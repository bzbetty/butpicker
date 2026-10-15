use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// What a project runs in its run pane, and when. Both fields are optional:
/// with neither set, a repo with an Aspire AppHost gets `aspire run` behind a
/// button and any other repo gets nothing.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunConfig {
    /// None is the default: a button when there's a command to run. Otherwise
    /// `auto` starts it when the tab is first looked at, `off` hides it.
    pub mode: Option<String>,
    /// None uses whatever detection found.
    pub command: Option<String>,
}

/// Folders that never hold an AppHost but can hold a great many files.
const SKIP: &[&str] = &[
    ".git", ".vs", ".idea", "node_modules", "bin", "obj", "dist", "target", "packages",
];

/// Deep enough for `src/Foo.AppHost/Foo.AppHost.csproj`, shallow enough that
/// a large repo answers instantly.
const MAX_DEPTH: usize = 3;

fn is_apphost(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name == "apphost.cs" || name == "apphost.ts" || name.ends_with(".apphost.csproj") {
        return true;
    }
    // An AppHost project that doesn't follow the naming convention still says
    // what it is in its SDK.
    name.ends_with(".csproj")
        && fs::read_to_string(path)
            .map(|raw| raw.contains("Aspire.AppHost.Sdk") || raw.contains("<IsAspireHost>true"))
            .unwrap_or(false)
}

fn find_apphost(dir: &Path, depth: usize) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if depth < MAX_DEPTH && !SKIP.contains(&name.as_str()) {
                subdirs.push(path);
            }
        } else if is_apphost(&path) {
            return true;
        }
    }
    subdirs.into_iter().any(|sub| find_apphost(&sub, depth + 1))
}

/// The command a project would run by default, if it has an obvious one.
/// `async` so a slow disk doesn't stall the window.
#[tauri::command(async)]
pub fn run_detect(path: String) -> Option<String> {
    find_apphost(Path::new(&path), 0).then(|| "aspire run".to_string())
}

/// A running AppHost, as `aspire ps` describes it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningAppHost {
    pub app_host_path: String,
    #[serde(default)]
    pub dashboard_url: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

/// Keeps the aspire CLI from flashing a console window on every poll.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn aspire(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("aspire");
    cmd.args(args).args(["--nologo", "--non-interactive"]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| format!("aspire: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Resolves junctions and casing, so `C:\git\Job` (a junction) and the
/// `D:\git\Job` that `aspire ps` reports compare equal.
fn canonical(path: &str) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

fn read_running(paths: Vec<String>) -> Result<HashMap<String, RunningAppHost>, String> {
    let raw = aspire(&["ps", "--format", "Json"])?;
    // The banner and notices go to stderr, but be forgiving of anything that
    // lands ahead of the JSON.
    let json = raw.find('[').map(|i| &raw[i..]).unwrap_or("[]");
    let hosts: Vec<RunningAppHost> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let hosts: Vec<(PathBuf, RunningAppHost)> = hosts
        .into_iter()
        .filter_map(|h| Some((canonical(&h.app_host_path)?, h)))
        .collect();
    Ok(paths
        .into_iter()
        .filter_map(|path| {
            let root = canonical(&path)?;
            let host = hosts.iter().find(|(p, _)| p.starts_with(&root))?;
            Some((path, host.1.clone()))
        })
        .collect())
}

/// Which of these project directories have an AppHost running, by whoever
/// started it: our own run pane, `aspire start` from an agent, anything.
/// One `aspire ps` answers for every project, and it takes a second or two,
/// so it runs off the main thread.
#[tauri::command]
pub async fn aspire_running(paths: Vec<String>) -> Result<HashMap<String, RunningAppHost>, String> {
    tauri::async_runtime::spawn_blocking(move || read_running(paths))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn aspire_stop(app_host_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        aspire(&["stop", "--apphost", &app_host_path]).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}
