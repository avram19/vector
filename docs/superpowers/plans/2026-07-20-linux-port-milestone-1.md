# Linux Port (Milestone 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Vector to full feature parity on Linux (Ubuntu, x86_64 + aarch64), shipping AppImage/deb via the existing updater.

**Architecture:** Introduce `src-tauri/src/platform/{mod.rs,macos.rs,linux.rs,windows.rs}` as the single `#[cfg]`-dispatch point for leaf OS operations (open/reveal, extra PATH dirs, process cwd, clipboard file paths, Claude credential read). `macos.rs` adapts to existing macOS code (no risky mass-move); `linux.rs` is new; `windows.rs` is stubbed with `todo!()` (filled in Milestone 2 — it does not compile into the macOS/Linux builds). Shell-string-conditional logic (cwd trampoline, `default_shell`) stays in `main.rs`; editor discovery stays in `sidebar.rs`.

**Tech Stack:** Rust, Tauri v2, portable-pty, `@tauri-apps/plugin-os`, WebKitGTK (Linux webview), `xdg-open`/`dbus-send`/`wl-paste`/`xclip` (shelled out — no new heavy crates), GitHub Actions.

## Global Constraints

- **No test framework exists.** Verification is behavioral (run the app). `cargo test` is used ONLY for pure functions (URI/JSON parsing, path building). Everything else is verified by `cargo check`/`cargo build` + running in the **UTM Ubuntu Desktop arm64** VM and observing the affected flow.
- **Never regress macOS.** macOS bodies are adapted, not rewritten. After every task, `cargo check --manifest-path src-tauri/Cargo.toml` must pass on macOS.
- **Never spawn a binary by bare name from Rust** — resolve via `config::which_path` (macOS GUI PATH is minimal; same discipline applies on Linux).
- **Pinned deps only** — no `^`/`~` in `package.json`; pin any new npm dep exactly. Prefer shelling out over adding Rust crates.
- **Do not regress the PTY pipeline** — reader→emitter split, 16 ms/128 KB frame coalescing, OSC-777 strip, aggressive DECSET-2026 strip (Claude). Untouched by this milestone.
- **cols-3 margin** stays. **DOM renderer** stays (no WebGL/Canvas).
- **License header/style** — match surrounding code; PolyForm Noncommercial.
- Windows implementations in `windows.rs` are `todo!()` stubs this milestone and MUST NOT be relied on.

---

## File Structure

**Create:**
- `src-tauri/src/platform/mod.rs` — cfg dispatch + public surface re-export.
- `src-tauri/src/platform/macos.rs` — adapters to existing macOS code.
- `src-tauri/src/platform/linux.rs` — Linux implementations.
- `src-tauri/src/platform/windows.rs` — `todo!()` stubs.
- `src/platform.ts` — frontend OS detection + `isMod(e)` helper.
- `.github/workflows/build.yml` — 3-OS build matrix (Linux builds x86_64 + aarch64).

**Modify:**
- `src-tauri/src/main.rs` — `mod platform;`; `open_path`, `read_agent_cwd`, `default_shell`, `start_shell_session` trampoline route through platform / gain bash + Linux support.
- `src-tauri/src/config.rs` — `augmented_path` uses `platform::extra_path_dirs`.
- `src-tauri/src/clipboard.rs` — non-macOS branch calls `platform::clipboard_file_paths`.
- `src-tauri/src/usage.rs` — non-macOS credential read via `platform::read_claude_credential`.
- `src-tauri/src/preview.rs` — `reveal_in_finder`/`open_default_app` route through platform.
- `src-tauri/src/sidebar.rs` — Linux editor discovery + open branch.
- `src/App.tsx` — keybindings via `isMod`; drop Cmd+Arrow shims off macOS; titlebar CSS.
- `package.json` / `src-tauri/Cargo.toml` — add `@tauri-apps/plugin-os`; register the OS plugin.
- `src-tauri/tauri.conf.json` — confirm Linux bundle targets (deb, appimage).
- `scripts/release.sh` — generalize; `latest.json` gains `linux-x86_64` + `linux-aarch64`.

---

## Task 1: Platform module scaffold + open/reveal/PATH ops + first Linux run (WebKitGTK gate)

This task establishes the module, ports the simplest three leaf ops, and — critically — gets a bare Vector running in the Linux VM to retire the WebKitGTK rendering risk BEFORE investing in Tasks 2–9.

**Files:**
- Create: `src-tauri/src/platform/mod.rs`, `macos.rs`, `linux.rs`, `windows.rs`
- Modify: `src-tauri/src/main.rs` (add `mod platform;` near other `mod` decls; rewrite `open_path` command body), `src-tauri/src/config.rs:196-216` (`augmented_path`), `src-tauri/src/preview.rs:133-154`

**Interfaces:**
- Produces:
  - `platform::open_path(target: &str) -> std::io::Result<()>`
  - `platform::reveal_in_file_manager(path: &std::path::Path) -> Result<(), String>`
  - `platform::open_default_app(path: &std::path::Path) -> Result<(), String>`
  - `platform::extra_path_dirs(home: &std::path::Path) -> Vec<std::path::PathBuf>`

- [ ] **Step 1: Create `platform/mod.rs` with cfg dispatch and surface re-export**

```rust
//! Single cfg-dispatch point for leaf OS operations. Each OS module implements
//! the same surface; the compiler enforces completeness, so a missing platform
//! impl is a build error rather than a silent parity gap.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;
```

- [ ] **Step 2: Create `platform/macos.rs` with the three ops adapted from existing code**

```rust
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
```

- [ ] **Step 3: Create `platform/linux.rs`**

```rust
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
```

- [ ] **Step 4: Create `platform/windows.rs` with stubs (Milestone 2)**

```rust
use std::path::{Path, PathBuf};

pub fn open_path(target: &str) -> std::io::Result<()> {
    std::process::Command::new("cmd").args(["/C", "start", "", target]).spawn().map(|_| ())
}
pub fn reveal_in_file_manager(_path: &Path) -> Result<(), String> { todo!("Milestone 2: explorer /select") }
pub fn open_default_app(_path: &Path) -> Result<(), String> { todo!("Milestone 2: ShellExecute") }
pub fn extra_path_dirs(_home: &Path) -> Vec<PathBuf> { todo!("Milestone 2: %APPDATA%\\npm, scoop, etc.") }
```

- [ ] **Step 5: Wire callers.** In `main.rs`, add `mod platform;` beside the other module declarations. Replace the `open_path` command body's three `#[cfg]` `spawn` lines (currently `main.rs:701-706`) with:

```rust
    platform::open_path(&target).map_err(|e| e.to_string())
```

In `config.rs::augmented_path`, replace the hardcoded `extra` array (lines 199-208) with:

```rust
        let extra = crate::platform::extra_path_dirs(&home);
```

In `preview.rs`, replace the `reveal_in_finder` and `open_default_app` bodies (keeping the `#[tauri::command]` + `expand_tilde`) with calls to `crate::platform::reveal_in_file_manager(&p)` and `crate::platform::open_default_app(&p)` respectively.

- [ ] **Step 6: Verify macOS still builds and behaves**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles clean. Then `npm run tauri dev`, open a folder, "Reveal in Finder" and "Open with default app" both work exactly as before.

- [ ] **Step 7: First Linux build + run (WebKitGTK RISK GATE)**

In the UTM Ubuntu arm64 VM (with Rust, Node, `libwebkit2gtk-4.1-dev`, `build-essential`, `libgtk-3-dev` installed):

Run: `npm install && npm run tauri dev`
Expected: Vector launches. Open a shell tab. **Confirm xterm renders cleanly** — no scattered letters, correct wrapping (cols-3 margin holds), cursor tracks. Type `ls`, run `htop`, resize the window.

**GATE:** If rendering is broken on WebKitGTK, STOP and open a focused investigation (systematic-debugging) before continuing — this changes the milestone's shape. If it renders cleanly, the primary Linux risk is retired; proceed.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/platform src-tauri/src/main.rs src-tauri/src/config.rs src-tauri/src/preview.rs
git commit -m "feat(platform): module scaffold + open/reveal/PATH ops for Linux"
```

---

## Task 2: `process_cwd` (live cwd tracking backend)

**Files:**
- Modify: `platform/macos.rs`, `platform/linux.rs`, `platform/windows.rs`, `src-tauri/src/main.rs:732-796` (`read_agent_cwd`)

**Interfaces:**
- Produces: `platform::process_cwd(pid: u32) -> Option<String>`

- [ ] **Step 1: Add macOS impl by lifting the libproc block.** Move the entire `#[cfg(target_os = "macos")]` body of `read_agent_cwd` (main.rs:735-793, the `proc_pidinfo` / `ProcVnodePathInfo` code) into `platform/macos.rs` as:

```rust
pub fn process_cwd(pid: u32) -> Option<String> {
    // ... existing libproc PROC_PIDVNODEPATHINFO body, with `pid as c_int` ...
}
```

- [ ] **Step 2: Add Linux impl**

```rust
pub fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}
```

- [ ] **Step 3: Add Windows stub**

```rust
pub fn process_cwd(_pid: u32) -> Option<String> { todo!("Milestone 2: NtQueryInformationProcess PEB walk") }
```

- [ ] **Step 4: Rewire `read_agent_cwd`.** Replace its whole `#[cfg]` body with:

```rust
    let pid = state.registry.child_pid(&session_id)?;
    platform::process_cwd(pid)
```

(Adjust `child_pid`'s return type to `u32` at the call boundary if needed — cast with `as u32`.)

- [ ] **Step 5: Verify**

macOS: `cargo check` passes; `npm run tauri dev`, cd around in an agent tab, confirm the sidebar cwd/worktree still tracks.
Linux VM: `npm run tauri dev`, run `cd /tmp` inside an agent tab, confirm `read_agent_cwd` returns the new dir (observe sidebar file tree following the cwd).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/platform src-tauri/src/main.rs
git commit -m "feat(platform): process_cwd via /proc on Linux, libproc on macOS"
```

---

## Task 3: Clipboard file paths (Wayland + X11)

**Files:**
- Modify: `platform/macos.rs`, `platform/linux.rs`, `platform/windows.rs`, `src-tauri/src/clipboard.rs`
- Test: inline `#[cfg(test)]` module in `platform/linux.rs`

**Interfaces:**
- Produces: `platform::clipboard_file_paths() -> Vec<String>`

- [ ] **Step 1: Write the failing unit test for the URI-list parser (Linux)**

Add to `platform/linux.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::parse_uri_list;
    #[test]
    fn parses_and_percent_decodes_file_uris() {
        let input = "file:///home/u/a%20b.txt\r\nfile:///tmp/c.rs\r\n# comment\r\n";
        assert_eq!(
            parse_uri_list(input),
            vec!["/home/u/a b.txt".to_string(), "/tmp/c.rs".to_string()]
        );
    }
    #[test]
    fn ignores_non_file_and_blank_lines() {
        let input = "\r\nhttp://x/y\r\nfile:///z\r\n";
        assert_eq!(parse_uri_list(input), vec!["/z".to_string()]);
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml parse_uri_list` (on Linux, or macOS if you gate the test `#[cfg(target_os="linux")]` — simplest is to run this task's `cargo test` in the VM)
Expected: FAIL — `parse_uri_list` not found.

- [ ] **Step 3: Implement the Linux clipboard + parser**

```rust
/// Parse a freedesktop `text/uri-list`: skip blank/comment lines, keep only
/// `file://` URIs, strip the scheme+host, and percent-decode the path.
fn parse_uri_list(raw: &str) -> Vec<String> {
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.strip_prefix("file://"))
        // Drop an optional host component: file://host/path -> /path
        .map(|rest| match rest.find('/') { Some(i) => &rest[i..], None => rest })
        .map(percent_decode)
        .collect()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

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
        if let Ok(out) = std::process::Command::new(path).args(&args).output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                let paths = parse_uri_list(&text);
                if !paths.is_empty() {
                    return paths;
                }
            }
        }
    }
    Vec::new()
}
```

- [ ] **Step 4: Run the tests, confirm pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml parse_uri_list` (in the Linux VM)
Expected: PASS (2 tests).

- [ ] **Step 5: Add macOS delegate + Windows stub**

`platform/macos.rs`:

```rust
pub fn clipboard_file_paths() -> Vec<String> {
    // Existing NSPasteboard reader lives in crate::clipboard::macos.
    crate::clipboard::macos_file_paths()
}
```

Rename the `mod macos` inside `clipboard.rs` to expose it: add `pub(crate) fn macos_file_paths() -> Vec<String> { macos::file_paths() }` under the existing `#[cfg(target_os="macos")]`.

`platform/windows.rs`:

```rust
pub fn clipboard_file_paths() -> Vec<String> { todo!("Milestone 2: CF_HDROP") }
```

- [ ] **Step 6: Rewire `clipboard.rs` command.** Replace the `#[cfg(not(target_os="macos"))] { Vec::new() }` branch of `read_clipboard_file_paths` with `{ crate::platform::clipboard_file_paths() }`, and the macOS branch with `{ crate::platform::clipboard_file_paths() }` too (both now route through platform).

- [ ] **Step 7: Verify in VM**

Linux VM: install `wl-clipboard` (Wayland) or `xclip`. In the file manager, copy a file, then in a Vector agent tab press paste — the file's absolute path is inserted (matches macOS Finder-copy behavior). Test a filename with a space.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/platform src-tauri/src/clipboard.rs
git commit -m "feat(platform): clipboard file paths via uri-list on Linux"
```

---

## Task 4: Claude credential read (usage meter)

**Files:**
- Modify: `platform/macos.rs`, `platform/linux.rs`, `platform/windows.rs`, `src-tauri/src/usage.rs:77-92`
- Test: inline `#[cfg(test)]` in `platform/linux.rs`

**Interfaces:**
- Produces: `platform::read_claude_credential(profile_id: Option<&str>) -> Option<String>` — returns the OAuth accessToken.

- [ ] **Step 1: Failing test for the token JSON parse (shared shape)**

Add to `platform/linux.rs`:

```rust
#[cfg(test)]
mod cred_tests {
    use super::extract_access_token;
    #[test]
    fn reads_nested_and_flat_shapes() {
        assert_eq!(extract_access_token(r#"{"claudeAiOauth":{"accessToken":"tok1"}}"#), Some("tok1".into()));
        assert_eq!(extract_access_token(r#"{"accessToken":"tok2"}"#), Some("tok2".into()));
        assert_eq!(extract_access_token(r#"{"nope":1}"#), None);
    }
}
```

- [ ] **Step 2: Run, watch it fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml extract_access_token` (Linux VM)
Expected: FAIL — not found.

- [ ] **Step 3: Implement Linux credential read (plaintext file)**

```rust
/// Parse the accessToken from a Claude credentials JSON blob. Two observed
/// shapes: { claudeAiOauth: { accessToken } } or { accessToken }.
fn extract_access_token(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    v.get("claudeAiOauth").and_then(|o| o.get("accessToken")).and_then(|s| s.as_str())
        .or_else(|| v.get("accessToken").and_then(|s| s.as_str()))
        .map(|s| s.to_string())
}

/// On Linux, Claude Code stores credentials as plaintext `.credentials.json`
/// inside the profile config dir (or `~/.claude`). No keychain.
pub fn read_claude_credential(profile_id: Option<&str>) -> Option<String> {
    let dir = match profile_id {
        None | Some("") | Some("__default__") => dirs::home_dir()?.join(".claude"),
        Some(id) => crate::config::profile_config_dir(id)?,
    };
    let raw = std::fs::read_to_string(dir.join(".credentials.json")).ok()?;
    extract_access_token(&raw)
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml extract_access_token`
Expected: PASS (1 test, 3 assertions).

- [ ] **Step 5: macOS delegate + Windows stub**

`platform/macos.rs`:

```rust
pub fn read_claude_credential(profile_id: Option<&str>) -> Option<String> {
    crate::usage::read_oauth_token_keychain(profile_id)
}
```

In `usage.rs`, rename the existing `read_oauth_token` to `pub(crate) fn read_oauth_token_keychain` under `#[cfg(target_os="macos")]`.

`platform/windows.rs`:

```rust
pub fn read_claude_credential(profile_id: Option<&str>) -> Option<String> {
    // Same plaintext scheme as Linux — Milestone 2 will lift the linux body here.
    todo!("Milestone 2: plaintext .credentials.json")
}
```

- [ ] **Step 6: Rewire `fetch_claude_usage`.** Change `let token = match read_oauth_token(profile_id)` to `let token = match crate::platform::read_claude_credential(profile_id)`.

- [ ] **Step 7: Verify**

macOS: usage meter still populates (Keychain path unchanged).
Linux VM: with a signed-in Claude, the usage meter shows numbers (reads `~/.claude/.credentials.json`).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/platform src-tauri/src/usage.rs
git commit -m "feat(platform): Claude credential read (plaintext) on Linux"
```

---

## Task 5: Editor discovery + open on Linux

**Files:**
- Modify: `src-tauri/src/sidebar.rs:228-294` (`installed_editors`, `open_in_editor`)

**Interfaces:**
- Consumes: existing `EditorInfo { bundle_id, display_name }`. On Linux, `bundle_id` holds the launch binary name (opaque key; the frontend passes it back unchanged).

- [ ] **Step 1: Add a Linux editor table + PATH probe.** Wrap the existing macOS `mdfind` probe in `#[cfg(target_os = "macos")]` and add a Linux branch inside the `spawn_blocking` closure:

```rust
    #[cfg(target_os = "linux")]
    let found = tauri::async_runtime::spawn_blocking(|| -> Vec<EditorInfo> {
        // (binary_name, display_name) — probed against the augmented PATH.
        const LINUX_EDITORS: &[(&str, &str)] = &[
            ("code", "VS Code"), ("cursor", "Cursor"), ("windsurf", "Windsurf"),
            ("zed", "Zed"), ("subl", "Sublime Text"), ("nvim", "Neovim"),
            ("code-insiders", "VS Code Insiders"),
        ];
        LINUX_EDITORS.iter().filter_map(|&(bin, name)| {
            config::which_path(bin).map(|_| EditorInfo {
                bundle_id: bin.to_string(),
                display_name: name.to_string(),
            })
        }).collect()
    }).await.map_err(|e| e.to_string())?;
```

- [ ] **Step 2: Add a Linux `open_in_editor` branch.** Wrap the macOS body in `#[cfg(target_os = "macos")]` and add:

```rust
    #[cfg(target_os = "linux")]
    {
        let bin = config::which_path(&bundle_id).ok_or_else(|| format!("{bundle_id} not found"))?;
        Command::new(bin).arg(&path).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
```

- [ ] **Step 3: Verify**

macOS: editor list + "open in editor" unchanged.
Linux VM: with `code` installed, the sidebar editor menu lists "VS Code"; opening a file launches it at that path.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sidebar.rs
git commit -m "feat(sidebar): PATH-based editor discovery + open on Linux"
```

---

## Task 6: Live cwd trampoline for bash + Linux shell defaults

**Files:**
- Modify: `src-tauri/src/main.rs:63-69` (`default_shell`), `src-tauri/src/main.rs:246-272` (trampoline in `start_shell_session`)

- [ ] **Step 1: Linux default-shell fallback.** In `default_shell`, change the non-Windows fallback so Linux prefers bash:

```rust
fn default_shell() -> Vec<String> {
    if cfg!(windows) {
        vec!["powershell.exe".into()]
    } else if cfg!(target_os = "linux") {
        vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())]
    } else {
        vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())]
    }
}
```

- [ ] **Step 2: Add a bash branch to the trampoline.** After the existing zsh `if` block in `start_shell_session`, add:

```rust
    // bash: PROMPT_COMMAND is read from the environment, so we can inject OSC-7
    // without a temp rcfile. Prepend so the user's own PROMPT_COMMAND still runs.
    else if shell.ends_with("/bash") || shell == "bash" {
        let existing = std::env::var("PROMPT_COMMAND").unwrap_or_default();
        let osc7 = r#"printf '\033]7;file://%s%s\007' "$HOSTNAME" "$PWD""#;
        let combined = if existing.is_empty() {
            osc7.to_string()
        } else {
            format!("{osc7}; {existing}")
        };
        env.push(("PROMPT_COMMAND".into(), combined));
    }
```

- [ ] **Step 3: Verify**

Linux VM: open a shell tab (bash). `cd /tmp`, then `cd ~`. Confirm the sidebar cwd follows each `cd` (OSC-7 is emitted every prompt). Repeat with zsh as `$SHELL` to confirm the existing zsh path still works.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(shell): live cwd tracking for bash + Linux shell defaults"
```

---

## Task 7: Frontend — cross-platform keybindings + chrome

**Files:**
- Create: `src/platform.ts`
- Modify: `src/App.tsx` (keybinding handlers around lines 3960-4025; app-action shortcuts), `package.json`, `src-tauri/src/main.rs` (register OS plugin), `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `isMod(e: KeyboardEvent): boolean`, `isMac: boolean` from `src/platform.ts`.

- [ ] **Step 1: Add the OS plugin.**

```bash
npm install --save-exact @tauri-apps/plugin-os
```

Add `tauri-plugin-os = "2"` to `src-tauri/Cargo.toml` `[dependencies]`, and `.plugin(tauri_plugin_os::init())` in `main.rs`'s builder chain.

- [ ] **Step 2: Create `src/platform.ts`**

```ts
import { platform } from "@tauri-apps/plugin-os";

// platform() is synchronous in plugin-os v2 and returns e.g. "macos" | "linux" | "windows".
export const isMac = platform() === "macos";

/** The app-action modifier: ⌘ on macOS, Ctrl+Shift elsewhere (Ctrl alone
 *  belongs to the terminal — Ctrl+C/D/U must reach the shell). */
export function isMod(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey && e.shiftKey;
}
```

- [ ] **Step 3: Route app shortcuts through `isMod`.** For each app-action shortcut in `App.tsx` currently testing `e.metaKey` (new tab ⌘T, close ⌘W, split, reload ⌘⇧R, picker, copy), replace the modifier test with `isMod(e)`. Import `{ isMod, isMac }` at the top. Copy becomes Ctrl+Shift+C on non-mac (already covered by `isMod`), leaving Ctrl+C for the shell.

- [ ] **Step 4: Gate the Cmd+Arrow readline shims to macOS.** Wrap the `e.metaKey` arrow/backspace readline translations (App.tsx:4004-4019) in `if (isMac) { … }` so they don't fire on Linux, where native Ctrl/Alt readline already works and Ctrl+A/E belong to the shell.

- [ ] **Step 5: Titlebar CSS.** Locate any left-side padding reserved for macOS traffic lights in the tab strip. Make it conditional (e.g. add `data-os` to the root and key the padding off `:root:not([data-os="macos"])` to move/remove it). Set the attribute from `isMac`.

- [ ] **Step 6: Verify**

macOS: every ⌘ shortcut works as before; ⌘←/→ still do line start/end.
Linux VM: Ctrl+Shift+T opens a tab, Ctrl+Shift+C copies, plain Ctrl+C interrupts the running process in the terminal (reaches the shell). Tab strip has no dead traffic-light gap; window controls sit on the right.

- [ ] **Step 7: Commit**

```bash
git add src/platform.ts src/App.tsx package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/main.rs
git commit -m "feat(ui): cross-platform keybindings (Ctrl+Shift on Linux) + chrome"
```

---

## Task 8: Linux bundling + CI build matrix + updater manifest

**Files:**
- Create: `.github/workflows/build.yml`
- Modify: `src-tauri/tauri.conf.json` (confirm `deb`/`appimage` targets), `scripts/release.sh`

- [ ] **Step 1: Confirm bundle targets.** In `tauri.conf.json`, `bundle.targets` is `"all"` — on Linux this yields `.deb` + `.AppImage` + updater artifacts. Leave `"all"`; verify the icon set includes the PNGs (it does).

- [ ] **Step 2: Add the CI build matrix.** Create `.github/workflows/build.yml`:

```yaml
name: build
on:
  workflow_dispatch:
  push:
    tags: ["v*"]
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: macos-latest,   target: aarch64-apple-darwin,  rustflags: "" }
          - { os: ubuntu-22.04,   target: x86_64-unknown-linux-gnu, rustflags: "" }
          - { os: ubuntu-22.04-arm, target: aarch64-unknown-linux-gnu, rustflags: "" }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: "${{ matrix.target }}" }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: Linux deps
        if: startsWith(matrix.os, 'ubuntu')
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
            libayatana-appindicator3-dev librsvg2-dev patchelf
      - run: npm ci
      - name: Build
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        run: npm run tauri build -- --target ${{ matrix.target }}
      - uses: actions/upload-artifact@v4
        with:
          name: vector-${{ matrix.target }}
          path: |
            src-tauri/target/${{ matrix.target }}/release/bundle/**/*.AppImage
            src-tauri/target/${{ matrix.target }}/release/bundle/**/*.deb
            src-tauri/target/${{ matrix.target }}/release/bundle/**/*.dmg
            src-tauri/target/${{ matrix.target }}/release/bundle/**/*.sig
            src-tauri/target/${{ matrix.target }}/release/bundle/**/*.tar.gz
```

(Store `TAURI_SIGNING_PRIVATE_KEY` / password as repo secrets — the same updater key signs all bundles.)

- [ ] **Step 3: Extend `latest.json` for Linux.** In `scripts/release.sh`, after the macOS platform block, add `linux-x86_64` and `linux-aarch64` entries pointing at each AppImage `.tar.gz` + `.sig` uploaded to the release. Keep the existing `darwin-aarch64` block untouched. (The updater matches the running platform's key; extra keys are ignored by macOS clients.)

- [ ] **Step 4: Verify**

Run: `gh workflow run build.yml` (or push a test tag) — confirm all three matrix legs produce artifacts. Download the `aarch64-unknown-linux-gnu` AppImage, run it in the UTM VM: the app launches and every prior task's flow works from the packaged binary (not just `tauri dev`).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/build.yml scripts/release.sh src-tauri/tauri.conf.json
git commit -m "ci: 3-OS build matrix (Linux x86_64+aarch64) + Linux updater manifest"
```

---

## Task 9: Full-parity verification sweep + docs

**Files:**
- Modify: `README.md` (platform support), `CLAUDE.md` (note Linux is supported; link this plan)

- [ ] **Step 1: Run the full behavioral checklist in the UTM Ubuntu arm64 VM** against the packaged AppImage from Task 8:
  - PTY streaming with a live Claude session (no corruption; frame coalescing intact).
  - Live cwd tracking: bash + zsh, `cd` reflected in sidebar.
  - Clipboard file paste (Wayland + X11 helper), filename with spaces.
  - Reveal in file manager (DBus select) + open-with-default-app.
  - Editor discovery + open (`code`).
  - Usage meter reads plaintext credential.
  - GitHub sidebar (repos/PRs/actions) via `gh` on PATH.
  - Keybindings: Ctrl+Shift app actions; plain Ctrl+C reaches shell.
  - Updater: bump to a test version, confirm the AppImage self-updates from the Linux `latest.json` key.
  - xterm rendering under WebKitGTK stays clean under load (`htop`, fast scroll).

- [ ] **Step 2: Fix any parity gap found** (loop back to the relevant task; do not proceed with known gaps — full parity is the bar).

- [ ] **Step 3: Update docs.** README: add Linux to supported platforms + AppImage/deb install notes. CLAUDE.md: one line noting Linux support and a link to `docs/superpowers/plans/2026-07-20-linux-port-milestone-1.md`.

- [ ] **Step 4: macOS regression pass.** Run the same checklist on macOS — confirm zero behavior change from the refactor.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: Linux support (Milestone 1) + parity verification complete"
```

---

## Self-Review (completed)

- **Spec coverage:** platform module (Tasks 1–4) ✓; process_cwd `/proc` (T2) ✓; Wayland/X11 clipboard (T3) ✓; DBus reveal (T1) ✓; plaintext credential (T4) ✓; editor discovery (T5) ✓; bash trampoline + shell default (T6) ✓; frontend Ctrl+Shift + drop Cmd+Arrow + titlebar (T7) ✓; augmented_path Linux dirs (T1) ✓; AppImage/deb + `latest.json` linux keys + aarch64 target (T8) ✓; WebKitGTK risk gate (T1 Step 7) ✓; UTM verification env (T9) ✓; macOS regression (T9 Step 4) ✓.
- **Placeholders:** none — Windows `todo!()` stubs are intentional and out of scope for this milestone (documented in Global Constraints).
- **Type consistency:** `process_cwd(pid: u32)`, `clipboard_file_paths() -> Vec<String>`, `read_claude_credential(Option<&str>) -> Option<String>`, `extra_path_dirs(&Path) -> Vec<PathBuf>`, `open_path(&str)`, reveal/open `(&Path) -> Result<(),String>` used consistently across `mod.rs` re-export and all callers. Frontend `isMod`/`isMac` consistent across `platform.ts` and `App.tsx`.
