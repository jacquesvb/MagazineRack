use std::path::Path;
use tauri_plugin_fs::FsExt;

#[cfg(windows)]
fn display_path(path: &Path) -> String {
    let path = path.to_string_lossy().into_owned();
    if let Some(unc_path) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc_path}")
    } else if let Some(drive_path) = path.strip_prefix(r"\\?\") {
        if drive_path.as_bytes().get(1) == Some(&b':') {
            drive_path.to_string()
        } else {
            path
        }
    } else {
        path
    }
}

#[cfg(not(windows))]
fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[tauri::command]
fn allow_download_directory(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let directory = std::fs::canonicalize(&path)
        .map_err(|error| format!("Could not resolve the selected folder ‘{path}’: {error}"))?;
    if !directory.is_dir() {
        return Err("Choose an existing folder for downloaded publications.".into());
    }
    app.fs_scope()
        .allow_directory(Path::new(&directory), true)
        .map_err(|error| error.to_string())?;
    // Windows canonicalize() often returns an extended-length `\\?\` path.
    // Keep the extended form in the FS scope, but return a normal path to the
    // WebView APIs, which don't consistently accept that prefix.
    Ok(display_path(&directory))
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
