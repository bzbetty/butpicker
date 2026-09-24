use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// A live pseudo-terminal. The master half is kept so we can resize it; the
/// input queue and killer are the only other handles the UI ever needs.
struct Session {
    master: Box<dyn MasterPty + Send>,
    /// Feeds the session's writer thread. A write into the pty blocks once its
    /// pipe fills, so it happens there rather than on the command's thread.
    input: Sender<String>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Tells this spawn apart from a later one that reuses the id.
    generation: u64,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
    next_generation: AtomicU64,
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

/// `async`, so Tauri runs it off the main thread: starting a ConPTY and its
/// process can take long enough to visibly freeze the window.
#[tauri::command(async)]
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
    let stale = mgr.sessions.lock().unwrap().remove(&id);
    if let Some(mut stale) = stale {
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
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // One writer thread per session keeps keystrokes in order, which parallel
    // async commands would not. It ends when the session drops its sender.
    let (input, queued) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for data in queued {
            if writer
                .write_all(data.as_bytes())
                .and_then(|_| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });

    let generation = mgr.next_generation.fetch_add(1, Ordering::Relaxed);
    mgr.sessions.lock().unwrap().insert(
        id.clone(),
        Session {
            master: pair.master,
            input,
            killer,
            generation,
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
        // Forget the session so its handles close, unless the id has since
        // been handed to a newer spawn.
        let finished = {
            let mgr = app.state::<PtyManager>();
            let mut sessions = mgr.sessions.lock().unwrap();
            match sessions.get(&id) {
                Some(s) if s.generation == generation => sessions.remove(&id),
                _ => None,
            }
        };
        // Closing a ConPTY can wait on its output draining; don't hold the lock.
        drop(finished);
        app.emit("pty:exit", ExitEvent { id, code }).ok();
    });

    Ok(())
}

#[tauri::command]
pub fn pty_write(mgr: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let sessions = mgr.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("no such pty")?;
    session.input.send(data).map_err(|_| "pty closed".to_string())
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
    let session = mgr.sessions.lock().unwrap().remove(&id);
    if let Some(mut session) = session {
        session.killer.kill().ok();
    }
    Ok(())
}

/// Reaps every pty. The frontend calls this as it boots: a reloaded webview has
/// forgotten its panes, but the processes behind them are still running.
#[tauri::command]
pub fn pty_kill_all(mgr: State<'_, PtyManager>) -> Result<usize, String> {
    let sessions: Vec<Session> = mgr.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
    let count = sessions.len();
    for mut session in sessions {
        session.killer.kill().ok();
    }
    Ok(count)
}
