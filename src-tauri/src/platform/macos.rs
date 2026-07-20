use std::path::{Path, PathBuf};
use std::process::Command;

pub fn open_path(target: &str) -> std::io::Result<()> {
    Command::new("/usr/bin/open").arg(target).spawn().map(|_| ())
}

pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    let open_bin = crate::config::which_path("open")
        .unwrap_or_else(|| PathBuf::from("/usr/bin/open"));
    Command::new(open_bin).arg("-R").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn open_default_app(path: &Path) -> Result<(), String> {
    let open_bin = crate::config::which_path("open")
        .unwrap_or_else(|| PathBuf::from("/usr/bin/open"));
    Command::new(open_bin).arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn extra_path_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        home.join(".local/bin"),
        home.join(".cargo/bin"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
    ]
}
