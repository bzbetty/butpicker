use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Keeps `but status` from flashing a console window on every poll.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// What a tab badge needs. Deliberately counts only — the TUI pane next to it
/// is the place to actually look at the work.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ProjectStatus {
    /// Uncommitted files, whether or not they're assigned to a stack.
    pub pending: usize,
    /// Applied branches across all stacks.
    pub branches: usize,
    /// Stacks in the workspace.
    pub stacks: usize,
    /// Set when `but` couldn't answer; the badge goes quiet rather than lying.
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ButStatus {
    #[serde(default)]
    uncommitted_changes: Vec<serde_json::Value>,
    #[serde(default)]
    stacks: Vec<ButStack>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ButStack {
    #[serde(default)]
    assigned_changes: Vec<serde_json::Value>,
    #[serde(default)]
    branches: Vec<ButBranch>,
}

#[derive(Deserialize)]
struct ButBranch {
    #[serde(default)]
    name: String,
}

fn but_command(program: &str, cwd: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.current_dir(cwd);
    // Same reasoning as the pty: `but` switches to a machine format when it
    // thinks an agent is watching — here we want that, but on our terms.
    cmd.env("BUT_OUTPUT_FORMAT", "json");
    cmd.env_remove("BUT_PAGER");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// `but status` takes seconds on a repo with pending changes. A plain sync
/// command runs on the main thread, which also delivers pty output and input,
/// so every poll froze every terminal until it came back.
#[tauri::command]
pub async fn project_status(
    path: String,
    program: String,
    ignore_branches: Vec<String>,
) -> ProjectStatus {
    tauri::async_runtime::spawn_blocking(move || read_status(path, program, ignore_branches))
        .await
        .unwrap_or_else(|e| ProjectStatus {
            error: Some(e.to_string()),
            ..Default::default()
        })
}

/// Branches that are pushed but never merged — plan notes and the like — don't
/// represent outstanding work, so counting them just makes the badge noisy.
fn read_status(path: String, program: String, ignore_branches: Vec<String>) -> ProjectStatus {
    let ignored: Vec<String> = ignore_branches.iter().map(|b| b.to_lowercase()).collect();
    let counts = |branches: &[ButBranch]| {
        branches
            .iter()
            .filter(|b| !ignored.contains(&b.name.to_lowercase()))
            .count()
    };
    let cwd = Path::new(&path);
    if !cwd.is_dir() {
        return ProjectStatus {
            error: Some("missing directory".into()),
            ..Default::default()
        };
    }

    let output = match but_command(&program, cwd).args(["status", "--json"]).output() {
        Ok(out) => out,
        Err(e) => {
            return ProjectStatus {
                error: Some(e.to_string()),
                ..Default::default()
            }
        }
    };

    if !output.status.success() {
        // Not a GitButler workspace, or `but` errored. Either way, no badge.
        let stderr = String::from_utf8_lossy(&output.stderr);
        return ProjectStatus {
            error: Some(stderr.lines().next().unwrap_or("but status failed").into()),
            ..Default::default()
        };
    }

    let parsed: ButStatus = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(e) => {
            return ProjectStatus {
                error: Some(format!("unreadable status: {e}")),
                ..Default::default()
            }
        }
    };

    let assigned: usize = parsed.stacks.iter().map(|s| s.assigned_changes.len()).sum();
    ProjectStatus {
        pending: parsed.uncommitted_changes.len() + assigned,
        branches: parsed.stacks.iter().map(|s| counts(&s.branches)).sum(),
        // A stack that is nothing but ignored branches isn't work in progress.
        stacks: parsed
            .stacks
            .iter()
            .filter(|s| counts(&s.branches) > 0)
            .count(),
        error: None,
    }
}
