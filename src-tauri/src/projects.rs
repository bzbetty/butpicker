use crate::builds::BuildConfig;
use crate::run::RunConfig;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// A project is just a repository directory under the root. There's no adding
/// or forgetting: the folders on disk are the list.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    /// The full path, which is also the stable id across runs.
    pub id: String,
    pub name: String,
    pub path: String,
}

/// Which tabs were open last time, so a launch puts the workspace back the way
/// it was left.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Session {
    /// Project ids in tab order.
    #[serde(default)]
    pub open: Vec<String>,
    #[serde(default)]
    pub active: Option<String>,
}

/// Settings that belong to one repository rather than the app. They live here
/// rather than in a dotfile inside the repo: these are work repos shared with
/// other people, and a tool's preferences have no business dirtying them.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectSettings {
    pub builds: BuildConfig,
    pub run: RunConfig,
    pub prs: PrsConfig,
    pub releases: ReleasesConfig,
}

/// Release tracking: what's on the default branch but not yet in prod. A
/// tracked project is watched whether or not it's open in a tab.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReleasesConfig {
    /// None is the default: not tracked.
    pub track: Option<bool>,
    /// The Azure DevOps environment that counts as prod. None is `Production`.
    pub environment: Option<String>,
    /// Days the oldest unreleased work may wait before a nudge. None is the
    /// default (14); 0 never nudges.
    pub nudge_days: Option<u32>,
}

/// The PRs & builds pane.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PrsConfig {
    /// None is the default: closed until Ctrl+Shift+P. `true` opens it with the tab.
    pub open: Option<bool>,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    session: Session,
    /// Keyed by project id, which is the repository path.
    #[serde(default)]
    projects: BTreeMap<String, ProjectSettings>,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

/// One project's settings, or the defaults when it has none stored.
pub(crate) fn settings_for(app: &AppHandle, id: &str) -> ProjectSettings {
    load(app)
        .ok()
        .and_then(|mut store| store.projects.remove(id))
        .unwrap_or_default()
}

/// Every project whose settings turn release tracking on, by id (its path).
pub(crate) fn tracked_releases(app: &AppHandle) -> Result<Vec<(String, ProjectSettings)>, String> {
    Ok(load(app)?
        .projects
        .into_iter()
        .filter(|(_, s)| s.releases.track == Some(true))
        .collect())
}

fn load(app: &AppHandle) -> Result<Store, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(Store::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save(app: &AppHandle, store: &Store) -> Result<(), String> {
    let path = store_path(app)?;
    let raw = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

/// Normalise separators so an id is the same string on every run: on Windows a
/// root typed as `C:/git` would otherwise produce `C:/git\repo`, and session
/// restore matches tabs by id. Posix paths are already canonical.
#[cfg(windows)]
fn normalise(path: &str) -> String {
    path.replace('/', "\\")
}

#[cfg(not(windows))]
fn normalise(path: &str) -> String {
    path.to_string()
}

/// A root may be written with a leading `~`, which only a shell would expand.
fn expand_home(root: &str) -> PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match (root.strip_prefix("~/").or_else(|| root.strip_prefix("~\\")), home) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(root),
    }
}

/// Every git repository directly under `root`, alphabetically.
#[tauri::command]
pub fn projects_list(root: String) -> Result<Vec<Project>, String> {
    let dir = expand_home(&root);
    if !dir.is_dir() {
        return Err(format!("{root} is not a directory"));
    }

    let mut projects: Vec<Project> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|entry| entry.path().join(".git").exists())
        .map(|entry| {
            let display = normalise(&entry.path().to_string_lossy());
            Project {
                id: display.clone(),
                name: entry.file_name().to_string_lossy().to_string(),
                path: display,
            }
        })
        .collect();

    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(projects)
}

#[tauri::command]
pub fn session_get(app: AppHandle) -> Result<Session, String> {
    Ok(load(&app)?.session)
}

#[tauri::command]
pub fn session_save(
    app: AppHandle,
    open: Vec<String>,
    active: Option<String>,
) -> Result<(), String> {
    let mut store = load(&app)?;
    store.session = Session { open, active };
    save(&app, &store)
}

/// Every project's settings in one go: the frontend needs them for each tab it
/// opens, and there are only ever a handful.
#[tauri::command]
pub fn project_settings_all(app: AppHandle) -> Result<BTreeMap<String, ProjectSettings>, String> {
    Ok(load(&app)?.projects)
}

/// Settings that are entirely defaults are removed rather than written, so the
/// store doesn't fill up with empty entries for every repo ever opened.
#[tauri::command]
pub fn project_settings_save(
    app: AppHandle,
    id: String,
    settings: ProjectSettings,
) -> Result<(), String> {
    let mut store = load(&app)?;
    if is_default(&settings) {
        store.projects.remove(&id);
    } else {
        store.projects.insert(id, settings);
    }
    save(&app, &store)
}

fn is_default(settings: &ProjectSettings) -> bool {
    let builds = &settings.builds;
    let run = &settings.run;
    builds.enabled.is_none()
        && run.mode.is_none()
        && settings.prs.open.is_none()
        && settings.releases.track.is_none()
        && settings.releases.nudge_days.is_none()
        && builds.definitions.is_empty()
        && [
            &builds.organization,
            &builds.project,
            &builds.repository,
            &builds.branch,
            &run.command,
            &settings.releases.environment,
        ]
        .iter()
        .all(|value| value.as_deref().unwrap_or_default().trim().is_empty())
}
