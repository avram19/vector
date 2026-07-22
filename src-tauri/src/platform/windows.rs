use std::path::{Path, PathBuf};

pub fn open_path(target: &str) -> std::io::Result<()> {
    // The empty "" is `start`'s title argument — required so a quoted path
    // isn't consumed as the window title.
    crate::config::silent_command("cmd")
        .args(["/C", "start", "", target])
        .spawn()
        .map(|_| ())
}

/// Windows: `explorer /select,<path>` highlights the file in a new Explorer
/// window. explorer.exe returns a nonzero exit code even on success, so we
/// spawn-and-forget without checking status.
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    crate::config::silent_command("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Windows: `cmd /C start "" <path>` opens the path in its default handler.
pub fn open_default_app(path: &Path) -> Result<(), String> {
    crate::config::silent_command("cmd")
        .args(["/C", "start", ""])
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Extra PATH dirs where Windows package managers drop agent/git shims. macOS
/// GUI apps start with a minimal PATH; Windows GUI apps inherit the fuller user
/// PATH, but these cover common setups where a shim dir isn't on PATH yet.
pub fn extra_path_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm")); // npm global bin (.cmd shims)
    }
    dirs.push(home.join(".cargo").join("bin"));
    dirs.push(home.join(".bun").join("bin"));
    dirs.push(home.join("scoop").join("shims"));
    if let Some(programdata) = std::env::var_os("ProgramData") {
        dirs.push(PathBuf::from(programdata).join("chocolatey").join("bin"));
    }
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        dirs.push(PathBuf::from(pf).join("Git").join("cmd")); // Git for Windows
    }
    dirs
}
pub fn process_cwd(_pid: u32) -> Option<String> { todo!("Milestone 2: NtQueryInformationProcess PEB walk") }
pub fn clipboard_file_paths() -> Vec<String> { todo!("Milestone 2: CF_HDROP") }
pub fn read_claude_credential(_profile_id: Option<&str>) -> Option<String> { todo!("Milestone 2: plaintext .credentials.json") }
