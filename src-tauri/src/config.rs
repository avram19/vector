use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpec {
    pub label: Option<String>,
    pub command: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    pub default: Option<String>,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentSpec>,
}

fn config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("vector").join("config.toml"))
}

pub fn load() -> Config {
    let mut cfg = builtin();
    if let Some(p) = config_path() {
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(user) = toml::from_str::<Config>(&text) {
                if let Some(d) = user.default {
                    cfg.default = Some(d);
                }
                for (k, v) in user.agents {
                    cfg.agents.insert(k, v);
                }
            }
        }
    }
    cfg
}

fn builtin() -> Config {
    let known: &[(&str, &str, &[&str])] = &[
        ("claude",   "Claude Code",         &["claude"]),
        ("codex",    "Codex",               &["codex"]),
        ("cursor",   "Cursor Agent",        &["cursor-agent"]),
        ("copilot",  "GitHub Copilot CLI",  &["copilot", "gh-copilot"]),
        ("aider",    "Aider",               &["aider"]),
        ("gemini",   "Gemini CLI",          &["gemini"]),
        ("q",        "Amazon Q",            &["q"]),
        ("opencode", "OpenCode",            &["opencode"]),
        ("crush",    "Crush",               &["crush"]),
        ("goose",    "Goose",               &["goose"]),
        ("amp",      "Amp",                 &["amp"]),
        ("plandex",  "Plandex",             &["plandex"]),
        ("continue", "Continue",            &["continue", "cn"]),
        ("qodo",     "Qodo",                &["qodo", "qodo-gen"]),
    ];
    let mut agents = BTreeMap::new();
    for (id, label, bins) in known {
        let first = bins.iter().find(|b| which(b)).copied().unwrap_or(bins[0]);
        agents.insert(
            (*id).into(),
            AgentSpec { label: Some((*label).into()), command: vec![first.into()], env: Default::default() },
        );
    }
    Config { default: Some("claude".into()), agents }
}

pub fn augmented_path() -> std::ffi::OsString {
    let mut path = std::env::var_os("PATH").unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        let extra = [
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".npm-global/bin"),
            home.join(".bun/bin"),
        ];
        let mut joined: Vec<PathBuf> = std::env::split_paths(&path).collect();
        for e in extra {
            if !joined.contains(&e) { joined.push(e); }
        }
        path = std::env::join_paths(joined).unwrap_or(path);
    }
    path
}

pub fn which_path(bin: &str) -> Option<PathBuf> {
    // Absolute / contains path sep: use as-is.
    let p = PathBuf::from(bin);
    if p.is_absolute() || bin.contains('/') {
        return if p.is_file() { Some(p) } else { None };
    }
    let path = augmented_path();
    for dir in std::env::split_paths(&path) {
        let full = dir.join(bin);
        if full.is_file() { return Some(full); }
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat"] {
                let f = dir.join(format!("{bin}.{ext}"));
                if f.is_file() { return Some(f); }
            }
        }
    }
    None
}

pub fn which(bin: &str) -> bool {
    which_path(bin).is_some()
}
