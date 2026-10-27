use std::path::Path;
use tauri_plugin_fs::FsExt;

#[tauri::command]
fn allow_download_directory(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let directory = std::fs::canonicalize(&path).map_err(|error| error.to_string())?;
    if !directory.is_dir() {
        return Err("Choose an existing folder for downloaded publications.".into());
    }
    app.fs_scope()
        .allow_directory(Path::new(&directory), true)
        .map_err(|error| error.to_string())?;
    Ok(directory.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![allow_download_directory])
        .run(tauri::generate_context!())
        .expect("error while running Magazine Rack");
}
