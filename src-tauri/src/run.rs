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

/// A running AppHost, as `aspire ps` describes it, plus which worktree of
/// the project it's running from.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningAppHost {
    pub app_host_path: String,
    #[serde(default)]
    pub dashboard_url: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// The linked worktree it runs from, or None for the project's own
    /// checkout.
    #[serde(default)]
    pub worktree: Option<String>,
    /// That worktree's branch, when it has one checked out.
    #[serde(default)]
    pub branch: Option<String>,
}

/// Keeps the aspire CLI from flashing a console window on every poll.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A linked worktree, as `git worktree list --porcelain` describes it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    path: String,
    branch: Option<String>,
}

/// Every worktree git knows for the repo at `dir`, wherever the tool that
/// made it put it: Claude Code's `.claude/worktrees`, T3 Code's `~/.t3`, a
/// sibling folder from VS Code. Ones whose folder has gone are left out.
fn worktrees(dir: &str) -> Vec<Worktree> {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir).args(["worktree", "list", "--porcelain"]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .replace("\r\n", "\n")
        .split("\n\n")
        .filter_map(|block| {
            let mut path = None;
            let mut branch = None;
            for line in block.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    path = Some(p.to_string());
                } else if let Some(b) = line.strip_prefix("branch ") {
                    branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
                } else if line.starts_with("prunable") || line == "bare" {
                    return None;
                }
            }
            Some(Worktree { path: path?, branch })
        })
        .collect()
}

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

/// A folder a running AppHost could belong to: an open project's own
/// checkout, or one of its linked worktrees.
struct Root {
    canonical: PathBuf,
    project: String,
    worktree: Option<Worktree>,
}

fn read_running(paths: Vec<String>) -> Result<HashMap<String, Vec<RunningAppHost>>, String> {
    let raw = aspire(&["ps", "--format", "Json"])?;
    // The banner and notices go to stderr, but be forgiving of anything that
    // lands ahead of the JSON.
    let json = raw.find('[').map(|i| &raw[i..]).unwrap_or("[]");
    let hosts: Vec<RunningAppHost> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if hosts.is_empty() {
        return Ok(HashMap::new());
    }

    // The projects themselves first, so a worktree that is also open as a
    // project of its own counts as that project's checkout.
    let mut roots: Vec<Root> = paths
        .iter()
        .filter_map(|path| {
            Some(Root { canonical: canonical(path)?, project: path.clone(), worktree: None })
        })
        .collect();
    for path in &paths {
        for tree in worktrees(path) {
            let Some(canonical) = canonical(&tree.path) else { continue };
            if roots.iter().any(|r| r.canonical == canonical) {
                continue;
            }
            roots.push(Root { canonical, project: path.clone(), worktree: Some(tree) });
        }
    }

    Ok(assign(hosts, &roots))
}

/// Credits each AppHost to the most specific folder it sits under, so one in
/// a worktree nested inside the repo, as Claude Code makes them, counts as
/// the worktree's rather than the repo's own.
fn assign(hosts: Vec<RunningAppHost>, roots: &[Root]) -> HashMap<String, Vec<RunningAppHost>> {
    let mut running: HashMap<String, Vec<RunningAppHost>> = HashMap::new();
    for mut host in hosts {
        let Some(at) = canonical(&host.app_host_path) else { continue };
        let Some(root) = roots
            .iter()
            .filter(|r| at.starts_with(&r.canonical))
            .max_by_key(|r| r.canonical.components().count())
        else {
            continue;
        };
        if let Some(tree) = &root.worktree {
            host.worktree = Some(tree.path.clone());
            host.branch = tree.branch.clone();
        }
        running.entry(root.project.clone()).or_default().push(host);
    }
    running
}

/// The project's other worktrees, the ones somewhere to run besides its own
/// checkout. `async` so a slow git doesn't stall the window.
#[tauri::command(async)]
pub fn worktrees_list(path: String) -> Vec<Worktree> {
    let own = canonical(&path);
    worktrees(&path)
        .into_iter()
        .filter(|tree| own.is_none() || canonical(&tree.path) != own)
        .collect()
}

/// The AppHosts running under each of these project directories or their
/// worktrees, by whoever started them: our own run pane, `aspire start` from
/// an agent, anything.
/// One `aspire ps` answers for every project, and it takes a second or two,
/// so it runs off the main thread.
#[tauri::command]
pub async fn aspire_running(
    paths: Vec<String>,
) -> Result<HashMap<String, Vec<RunningAppHost>>, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn host(path: &Path) -> RunningAppHost {
        RunningAppHost {
            app_host_path: path.to_string_lossy().into_owned(),
            dashboard_url: None,
            status: None,
            worktree: None,
            branch: None,
        }
    }

    fn root(path: &Path, project: &Path, branch: Option<&str>) -> Root {
        Root {
            canonical: fs::canonicalize(path).unwrap(),
            project: project.to_string_lossy().into_owned(),
            worktree: branch.map(|b| Worktree {
                path: path.to_string_lossy().into_owned(),
                branch: Some(b.to_string()),
            }),
        }
    }

    #[test]
    fn worktrees_get_their_own_apphosts() {
        let base = std::env::temp_dir().join(format!("butpicker-run-{}", std::process::id()));
        let repo = base.join("repo");
        let nested = repo.join(".claude").join("worktrees").join("agent");
        let sibling = base.join("t3").join("repo-feature");
        for dir in [&repo, &nested, &sibling] {
            fs::create_dir_all(dir.join("App.AppHost")).unwrap();
        }
        let csproj = |dir: &Path| {
            let file = dir.join("App.AppHost").join("App.AppHost.csproj");
            fs::write(&file, "").unwrap();
            file
        };
        let (main, agent, feature) = (csproj(&repo), csproj(&nested), csproj(&sibling));

        let roots = vec![
            root(&repo, &repo, None),
            root(&nested, &repo, Some("agent-branch")),
            root(&sibling, &repo, Some("feature")),
        ];
        let running = assign(vec![host(&agent), host(&main), host(&feature)], &roots);
        let _ = fs::remove_dir_all(&base);

        let hosts = &running[&repo.to_string_lossy().into_owned()];
        let by_branch = |b: Option<&str>| {
            hosts.iter().find(|h| h.branch.as_deref() == b).map(|h| h.app_host_path.clone())
        };
        assert_eq!(hosts.len(), 3);
        assert_eq!(by_branch(None), Some(main.to_string_lossy().into_owned()));
        assert_eq!(by_branch(Some("agent-branch")), Some(agent.to_string_lossy().into_owned()));
        assert_eq!(by_branch(Some("feature")), Some(feature.to_string_lossy().into_owned()));
    }
}
