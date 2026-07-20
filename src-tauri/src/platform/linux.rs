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

pub fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Read file paths off the clipboard via the freedesktop `text/uri-list`
/// type. Tries Wayland's `wl-paste` first, then the X11 tools `xclip`/`xsel`.
/// Never spawns by bare name — resolves each binary through `which_path`
/// since GUI-launched processes get a minimal `PATH`.
pub fn clipboard_file_paths() -> Vec<String> {
    use crate::config::which_path;
    // Wayland first, then X11. Request the file URI list explicitly.
    let attempts: [(&str, Vec<&str>); 3] = [
        ("wl-paste", vec!["--no-newline", "--type", "text/uri-list"]),
        ("xclip", vec!["-selection", "clipboard", "-t", "text/uri-list", "-o"]),
        ("xsel", vec!["--clipboard", "--output"]),
    ];
    for (bin, args) in attempts {
        let Some(path) = which_path(bin) else { continue };
        if let Ok(out) = Command::new(path).args(&args).output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                let paths = super::uri_list::parse_uri_list(&text);
                if !paths.is_empty() {
                    return paths;
                }
            }
        }
    }
    Vec::new()
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

/// On Linux, Claude Code stores credentials as plaintext `.credentials.json`
/// inside the profile config dir (or `~/.claude`). No keychain.
pub fn read_claude_credential(profile_id: Option<&str>) -> Option<String> {
    let dir = match profile_id {
        None | Some("") | Some("__default__") => dirs::home_dir()?.join(".claude"),
        Some(id) => crate::config::profile_config_dir(id)?,
    };
    let raw = std::fs::read_to_string(dir.join(".credentials.json")).ok()?;
    super::creds::extract_access_token(&raw)
}
