mod builds;
mod projects;
mod pty;
mod run;
mod status;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyManager::default())
        .manage(builds::Builds::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            projects::projects_list,
            projects::session_get,
            projects::session_save,
            projects::project_settings_all,
            projects::project_settings_save,
            status::project_status,
            builds::build_status,
            run::run_detect,
            run::aspire_running,
            run::aspire_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
