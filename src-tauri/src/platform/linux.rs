use std::path::{Path, PathBuf};
use std::process::Command;

pub fn open_path(target: &str) -> std::io::Result<()> {
    Command::new("xdg-open").arg(target).spawn().map(|_| ())
}

/// Select the file in the user's file manager via the freedesktop DBus API,
/// falling back to opening the parent directory. `dbus-send` is shelled out to
/// avoid pulling in a DBus crate.
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    let abs = path.to_string_lossy();
    let uri = format!("file://{abs}");
    let dbus = Command::new("dbus-send")
        .args([
            "--session",
            "--dest=org.freedesktop.FileManager1",
            "--type=method_call",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1.ShowItems",
            &format!("array:string:{uri}"),
            "string:",
        ])
        .status();
    if matches!(dbus, Ok(s) if s.success()) {
        return Ok(());
    }
    // Fallback: open the containing directory.
    let dir = path.parent().unwrap_or(path);
    Command::new("xdg-open").arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn open_default_app(path: &Path) -> Result<(), String> {
    Command::new("xdg-open").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn extra_path_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        home.join(".local/bin"),
        home.join(".cargo/bin"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
    ]
}
