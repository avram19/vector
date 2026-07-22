use crate::config;

/// Resolve the `gh` binary against Vector's augmented PATH (GUI apps start with
/// a minimal PATH on macOS). `None` means gh is not installed / not on PATH.
pub fn gh_path() -> Option<std::path::PathBuf> {
    config::which_path("gh")
}

/// Run `gh` with `args`, returning stdout on success. A non-zero exit maps to
/// `Err(stderr)`. PATH is augmented so gh's own child processes (git) resolve.
pub fn run_gh(args: &[&str]) -> Result<String, String> {
    let gh = gh_path().ok_or_else(|| "gh CLI not found on PATH".to_string())?;
    let out = crate::config::silent_command(&gh)
        .args(args)
        .env("PATH", config::augmented_path())
        .output()
        .map_err(|e| format!("failed to spawn gh: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("gh exited with {}", out.status) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub installed: bool,
    pub authed: bool,
    pub login: Option<String>,
    /// Avatar URL of the signed-in user, for the panel header.
    pub avatar_url: Option<String>,
}

/// Determine gh install + auth state. Authed iff `gh api user` returns a login;
/// also grabs the avatar URL in the same round-trip (tab-separated).
pub fn auth_status() -> AuthStatus {
    if gh_path().is_none() {
        return AuthStatus { installed: false, authed: false, login: None, avatar_url: None };
    }
    match run_gh(&["api", "user", "--jq", "[.login, .avatar_url] | @tsv"]) {
        Ok(out) => {
            let line = out.trim();
            let mut parts = line.split('\t');
            let login = parts.next().unwrap_or("").to_string();
            let avatar_url = parts.next().map(|s| s.to_string()).filter(|s| !s.is_empty());
            if login.is_empty() {
                AuthStatus { installed: true, authed: false, login: None, avatar_url: None }
            } else {
                AuthStatus { installed: true, authed: true, login: Some(login), avatar_url }
            }
        }
        Err(_) => AuthStatus { installed: true, authed: false, login: None, avatar_url: None },
    }
}
