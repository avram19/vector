use std::path::{Path, PathBuf};

pub fn open_path(target: &str) -> std::io::Result<()> {
    std::process::Command::new("cmd").args(["/C", "start", "", target]).spawn().map(|_| ())
}
pub fn reveal_in_file_manager(_path: &Path) -> Result<(), String> { todo!("Milestone 2: explorer /select") }
pub fn open_default_app(_path: &Path) -> Result<(), String> { todo!("Milestone 2: ShellExecute") }
pub fn extra_path_dirs(_home: &Path) -> Vec<PathBuf> { todo!("Milestone 2: %APPDATA%\\npm, scoop, etc.") }
pub fn process_cwd(_pid: u32) -> Option<String> { todo!("Milestone 2: NtQueryInformationProcess PEB walk") }
pub fn clipboard_file_paths() -> Vec<String> { todo!("Milestone 2: CF_HDROP") }
pub fn read_claude_credential(_profile_id: Option<&str>) -> Option<String> { todo!("Milestone 2: plaintext .credentials.json") }
