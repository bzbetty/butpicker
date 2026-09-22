use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// A live pseudo-terminal. The master half is kept so we can resize it; the
/// writer and killer are the only other handles the UI ever needs.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Clone, Serialize)]
struct OutputEvent {
    id: String,
    /// base64, because a read can split a UTF-8 sequence or an escape code
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: String,
    code: u32,
}

/// Markers that make CLI tools assume they're being scraped by an agent and
/// switch to machine-readable output. `but` refuses to open its TUI under
/// them. The panes here are real interactive terminals, so if ButPicker was
/// itself launched from an agent session, that inheritance is just wrong.
const AGENT_ENV_MARKERS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_PID",
    "AI_AGENT",
    "AGENT",
    "CI",
];

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    mgr: State<'_, PtyManager>,
    id: String,
    cwd: String,
    program: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Replacing an id implicitly kills whatever was there.
    if let Some(mut stale) = mgr.sessions.lock().unwrap().remove(&id) {
        stale.killer.kill().ok();
    }

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&program);
    for a in &args {
        cmd.arg(a);
    }
    cmd.cwd(&cwd);
    for marker in AGENT_ENV_MARKERS {
        cmd.env_remove(marker);
    }
    // ConPTY ignores TERM, but the TUIs running inside it do not.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (key, value) in &env {
        cmd.env(key, value);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave handle must go away or the pty never reports EOF.
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    mgr.sessions.lock().unwrap().insert(
        id.clone(),
        Session {
            master: pair.master,
            writer,
            killer,
        },
    );

    let pump_app = app.clone();
    let pump_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let payload = OutputEvent {
                        id: pump_id.clone(),
                        data: B64.encode(&buf[..n]),
                    };
                    if pump_app.emit("pty:output", payload).is_err() {
                        break;
                    }
                }
            }
        }
    });

    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        app.emit("pty:exit", ExitEvent { id, code }).ok();
    });

    Ok(())
}

#[tauri::command]
pub fn pty_write(mgr: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut sessions = mgr.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("no such pty")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    mgr: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = mgr.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such pty")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(mgr: State<'_, PtyManager>, id: String) -> Result<(), String> {
    if let Some(mut session) = mgr.sessions.lock().unwrap().remove(&id) {
        session.killer.kill().ok();
    }
    Ok(())
}

/// Reaps every pty. The frontend calls this as it boots: a reloaded webview has
/// forgotten its panes, but the processes behind them are still running.
#[tauri::command]
pub fn pty_kill_all(mgr: State<'_, PtyManager>) -> Result<usize, String> {
    let mut sessions = mgr.sessions.lock().unwrap();
    let count = sessions.len();
    for (_, mut session) in sessions.drain() {
        session.killer.kill().ok();
    }
    Ok(count)
}
