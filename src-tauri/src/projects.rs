use serde::{Deserialize, Serialize};
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

#[derive(Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    session: Session,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
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

/// Every git repository directly under `root`, alphabetically.
#[tauri::command]
pub fn projects_list(root: String) -> Result<Vec<Project>, String> {
    let dir = PathBuf::from(&root);
    if !dir.is_dir() {
        return Err(format!("{root} is not a directory"));
    }

    let mut projects: Vec<Project> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|entry| entry.path().join(".git").exists())
        .map(|entry| {
            // Normalise separators: a root typed as `C:/git` would otherwise
            // produce `C:/git\repo`, and ids have to be stable across runs for
            // session restore to match them.
            let display = entry.path().to_string_lossy().replace('/', "\\");
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
