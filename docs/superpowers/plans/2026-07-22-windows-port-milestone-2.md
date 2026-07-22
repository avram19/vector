# Windows Port — Milestone 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vector build, run, and self-update on Windows (x64) with feature parity to macOS/Linux, verified CI-only (no local Windows machine), by filling the six stubbed `platform/windows.rs` functions and wiring the Windows bundle + release leg.

**Architecture:** Vector already has a compiler-enforced platform module (`src-tauri/src/platform/{mod,macos,linux,windows}.rs`). Milestone 1 (Linux) landed the frontend + the module surface; `windows.rs` is six `todo!()` stubs. This milestone implements those leaf ops using raw `extern "system"` FFI (no new crates — the same technique the reference fork used and proved), fixes one load-bearing `which_path` ordering bug that would otherwise break agent launch on Windows, makes the shell panel and default shell Windows-aware, suppresses console-window flashing on child-process spawns, and adds the NSIS bundle target + a `windows-latest` release leg and a fast `windows-check` compile gate.

**Tech Stack:** Rust (Tauri v2, portable-pty→ConPTY), raw Win32 FFI (`ntdll`/`kernel32`/`user32`/`shell32`), GitHub Actions (`tauri-action`, NSIS), no new Cargo dependencies.

**Reference implementation:** The fork `github.com/prateekraj3711-alt/vector-windows` (cloned to the session scratchpad) ported an *older* Vector to Windows with the scattered-`#[cfg]` approach. It has **no** `platform/` module, so we do not copy its structure — but its `read_cwd_windows` PEB walk, `silent_command` helper, `which_path` exe-ordering fix, and `explorer /select` + `cmd /C start` reveal/open are proven and are transcribed (adapted to our module layout) below.

## Global Constraints

- **No new Cargo dependencies.** All Windows OS calls use raw `extern "system"` FFI + `#[link(...)]`. The `windows` crate is NOT added.
- **Target triple:** `x86_64-pc-windows-msvc` only (x64). PEB offsets below are x64 ABI. No 32-bit support.
- **Never spawn a bare binary name from Rust** — always resolve through `config::which_path` first (macOS/Windows GUI apps start with a minimal PATH). (from `CLAUDE.md`)
- **Never regress macOS or Linux.** Windows code is `#[cfg(target_os = "windows")]`-gated via `platform/mod.rs`; shared-file edits (`config.rs`, `main.rs`, `sidebar.rs`) must keep macOS/Linux arms byte-identical in behavior.
- **Console flash:** every `std::process::Command` that runs a *console* program on Windows must go through `config::silent_command` (sets `CREATE_NO_WINDOW`), or a console window flashes per call.
- **Verification is CI-only.** No local Windows runtime. Compile-verification = `windows-check` job (`cargo check` on `windows-latest`). Runtime behavior is smoke-tested on a real Windows box post-merge (checklist in Task 10). "It compiles" is the only automated gate; do not claim runtime behavior works.
- **Bundle identifier stays `dev.vector.app`** (changing it breaks the updater for existing installs).
- **Version files move together** — `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` must always agree (the release `gate` job fails otherwise).

## Deferred / documented degradation (NOT in this milestone)

- **PowerShell `prompt`-function trampoline (live shell cwd on `cd`).** Vector tracks live cwd via OSC-7 emitted by a shell trampoline (zsh ZDOTDIR / bash PROMPT_COMMAND), parsed by `src/shell/cwdSniffer`. On Windows we ship **without** the PowerShell trampoline: `read_agent_cwd` (the PEB walk) still returns correct cwd on shell-panel expand, and agent sessions are unaffected, but a Windows *shell* pane's cwd will not update live on every `cd`. This is the spec's sanctioned degradation (design doc Milestone 2, item 2 "falls back to `process_cwd`"). Documented in `CLAUDE.md` and `CHANGELOG.md` in Task 9. Revisit as a follow-up milestone.

## File map

- **Modify** `src-tauri/src/config.rs` — add `silent_command` (Task 2); fix `which_path` Windows exe-ordering (Task 2).
- **Modify** `src-tauri/src/platform/windows.rs` — implement all six stubs + `open_path` polish (Tasks 3–5).
- **Modify** `src-tauri/src/main.rs` — `default_shell` pwsh preference + `start_shell_session` Windows arm (Task 6).
- **Modify** `src-tauri/src/sidebar.rs` — Windows editor discovery in `installed_editors` + `open_in_editor` (Task 6).
- **Modify** `src-tauri/src/git.rs`, `src-tauri/src/github/client.rs` — route git/gh spawns through `silent_command` (Task 7).
- **Modify** `src-tauri/tauri.conf.json` — add `"nsis"` bundle target (Task 8).
- **Create** `.github/workflows/windows-check.yml` — fast `cargo check` gate on `windows-latest` (Task 1).
- **Modify** `.github/workflows/release.yml` — add the `windows-latest` matrix leg (Task 8).
- **Modify** `CHANGELOG.md`, `CLAUDE.md` — release notes + the documented cwd degradation (Task 9).

---

### Task 1: Windows compile-verification gate (`windows-check.yml`)

Establishes the ONLY automated verification available for every subsequent task: `cargo check` on a real `windows-latest` runner. Modeled on the existing `linux-check.yml` (no apt deps; Windows runners ship MSVC + WebView2). Fast (no bundle, no signing).

**Files:**
- Create: `.github/workflows/windows-check.yml`

**Interfaces:**
- Produces: a CI job named `windows-check / cargo-check` that runs on every push/PR touching `src-tauri/**` or the workflow, giving green/red compile status for the `#[cfg(target_os="windows")]` arms this milestone adds.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/windows-check.yml`:

```yaml
name: windows-check
# Fast Windows compile gate: type-checks every Windows #[cfg] branch on a real
# windows-latest runner (macOS/Linux `cargo check` never compiles the Windows
# arms). No signing secrets, no bundling — just `cargo check`.
on:
  push:
    branches: [main]
    paths: ["src-tauri/**", ".github/workflows/windows-check.yml", "package.json", "package-lock.json"]
  pull_request:
    paths: ["src-tauri/**", ".github/workflows/windows-check.yml", "package.json", "package-lock.json"]
  workflow_dispatch:

# Least-privilege GITHUB_TOKEN: this workflow only reads the repo.
permissions:
  contents: read

jobs:
  cargo-check:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: "x86_64-pc-windows-msvc" }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: Build frontend
        # generate_context!() embeds the frontend dist/, so it must exist
        # before cargo check even though we don't bundle here.
        run: |
          npm ci
          npm run build
      - name: cargo check
        run: cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
```

- [ ] **Step 2: Validate YAML locally**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/windows-check.yml')); print('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/windows-check.yml
git commit -m "ci: add windows-check cargo-check gate"
```

- [ ] **Step 4: Push the branch and confirm the job runs**

This is the harness every later task relies on. Push and confirm `windows-check` appears and runs (it will currently FAIL to compile because `windows.rs` still has `todo!()` bodies referencing undefined helpers only if they don't typecheck — `todo!()` itself compiles, so expect it to PASS on the current stubs). A PASS here proves the runner + frontend build + cross-check pipeline works.

Run: `git push -u origin HEAD` then `gh run watch $(gh run list --workflow windows-check.yml -L1 --json databaseId -q '.[0].databaseId')`
Expected: `windows-check` completes (PASS on current `todo!()` stubs).

---

### Task 2: `config.rs` — `silent_command` + `which_path` Windows exe-ordering fix

Two shared-file changes. **`which_path` fix is load-bearing:** npm installs a bare extensionless `claude` (a Git-Bash shell shim) next to `claude.cmd`. Our current loop returns the bare `claude` first — unrunnable via `CreateProcess` — so **every npm-installed agent fails to launch on Windows** until we probe `.exe/.cmd/.bat` first. Both edits compile on macOS (the new code is `#[cfg(windows)]`-gated or macOS-neutral).

**Files:**
- Modify: `src-tauri/src/config.rs` — `which_path` (currently ~line 191), add `silent_command` after `which`.

**Interfaces:**
- Produces: `pub fn silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command` — a `Command` with `CREATE_NO_WINDOW` set on Windows, plain `Command::new` elsewhere. Consumed by Tasks 3, 6, 7.
- Produces: `which_path` returning the `.exe/.cmd/.bat` variant before the bare name on Windows.

- [ ] **Step 1: Fix `which_path` Windows ordering**

Replace the body of the `for dir in std::env::split_paths(&path)` loop in `which_path` (the current form probes bare-name first, then exts) with exe-first ordering:

```rust
    for dir in std::env::split_paths(&path) {
        // On Windows, prefer the executable-extension variants. An extensionless
        // file is not runnable via CreateProcess — and npm ships a bare shell
        // shim (`claude`) alongside `claude.cmd`, so matching the bare name first
        // would hand back the unrunnable sh script. Skip the ext probe when `bin`
        // already carries an executable extension.
        #[cfg(windows)]
        {
            let has_exec_ext = std::path::Path::new(bin)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| matches!(e.to_ascii_lowercase().as_str(), "exe" | "cmd" | "bat" | "com"))
                .unwrap_or(false);
            if !has_exec_ext {
                for ext in ["exe", "cmd", "bat"] {
                    let f = dir.join(format!("{bin}.{ext}"));
                    if f.is_file() { return Some(f); }
                }
            }
        }
        let full = dir.join(bin);
        if full.is_file() { return Some(full); }
    }
    None
}
```

- [ ] **Step 2: Add `silent_command` immediately after the `which` fn**

```rust
/// Build a `std::process::Command` that does NOT flash a console window on
/// Windows. A GUI-subsystem app (Vector) spawning a console program — `git`,
/// `gh`, `cmd`, `explorer` — pops a visible console window per call unless
/// `CREATE_NO_WINDOW` is set. Worktree discovery alone fires many `git`
/// invocations on startup (× every auto-resumed tab), so without this the
/// window flickers with console pop-ups for a few seconds. No-op off Windows.
pub fn silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
```

- [ ] **Step 3: Verify macOS still compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS (0 errors; a `dead_code` warning on `silent_command` is acceptable until Task 3/7 use it — or add `#[allow(dead_code)]` if the warning is denied).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/config.rs
git commit -m "fix(windows): probe .exe/.cmd before bare name in which_path; add silent_command"
```

---

### Task 3: `windows.rs` — reveal / open / open_path / extra_path_dirs

The mechanical leaf ops. `explorer.exe` returns nonzero even on success, so we don't check its status. All spawns go through `config::silent_command` (Task 2) so no console flashes.

**Files:**
- Modify: `src-tauri/src/platform/windows.rs` — replace `open_path`, `reveal_in_file_manager`, `open_default_app`, `extra_path_dirs` stubs.

**Interfaces:**
- Consumes: `crate::config::silent_command` (Task 2).
- Produces (unchanged signatures, matching `linux.rs`): `open_path(&str) -> std::io::Result<()>`, `reveal_in_file_manager(&Path) -> Result<(),String>`, `open_default_app(&Path) -> Result<(),String>`, `extra_path_dirs(&Path) -> Vec<PathBuf>`.

- [ ] **Step 1: Rewrite the four functions**

In `src-tauri/src/platform/windows.rs`, replace the current `open_path`, `reveal_in_file_manager`, `open_default_app`, and `extra_path_dirs` stubs:

```rust
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
```

- [ ] **Step 2: Verify (macOS check is a no-op for these arms; rely on windows-check after push)**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS (these functions are `#[cfg(windows)]` via `mod.rs`, so macOS check only confirms the shared tree still builds).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/platform/windows.rs
git commit -m "feat(windows): implement reveal/open/open_path/extra_path_dirs"
```

---

### Task 4: `windows.rs` — `process_cwd` (PEB walk)

The highest-risk item, transcribed from the fork's proven `read_cwd_windows` (adapted to the `process_cwd(pid) -> Option<String>` signature and forward-slash normalization our callers expect is NOT required — macOS/Linux return native separators, so we keep backslashes). Reads another process's cwd by walking its PEB across the process boundary. x64 offsets only. Best-effort: any failure → `None` (caller falls back to spawn-time cwd).

**Files:**
- Modify: `src-tauri/src/platform/windows.rs` — replace the `process_cwd` stub.

**Interfaces:**
- Produces: `process_cwd(pid: u32) -> Option<String>` (same signature as `linux.rs`/`macos.rs`). Consumed by `main.rs::read_agent_cwd`.

- [ ] **Step 1: Replace the `process_cwd` stub**

```rust
/// Read another process's current working directory by walking its PEB. There
/// is no public Win32 API for this, so we use the documented approach:
/// `NtQueryInformationProcess(ProcessBasicInformation)` for the PEB base, then
/// `ReadProcessMemory` to follow PEB → RTL_USER_PROCESS_PARAMETERS →
/// CurrentDirectory.DosPath (a UNICODE_STRING). Offsets are the x64 ABI (our
/// only target). Best-effort — any failure returns None.
pub fn process_cwd(pid: u32) -> Option<String> {
    use std::os::raw::c_void;

    type Handle = *mut c_void;
    const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
    const PROCESS_VM_READ: u32 = 0x0010;

    #[repr(C)]
    struct ProcessBasicInformation {
        _reserved1: *mut c_void,
        peb_base_address: *mut c_void,
        _reserved2: [*mut c_void; 2],
        _unique_process_id: usize,
        _reserved3: *mut c_void,
    }

    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(h: Handle) -> i32;
        fn ReadProcessMemory(
            h: Handle,
            base: *const c_void,
            buf: *mut c_void,
            size: usize,
            read: *mut usize,
        ) -> i32;
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            h: Handle,
            class: u32,
            info: *mut c_void,
            len: u32,
            ret_len: *mut u32,
        ) -> i32;
    }

    unsafe {
        let h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if h.is_null() {
            return None;
        }
        // Closure so we CloseHandle on every exit path.
        let out = (|| -> Option<String> {
            let read_at = |addr: usize, buf: *mut c_void, size: usize| -> bool {
                let mut got = 0usize;
                ReadProcessMemory(h, addr as *const c_void, buf, size, &mut got) != 0 && got == size
            };

            let mut pbi: ProcessBasicInformation = std::mem::zeroed();
            let mut ret_len = 0u32;
            // ProcessBasicInformation class = 0.
            if NtQueryInformationProcess(
                h,
                0,
                &mut pbi as *mut _ as *mut c_void,
                std::mem::size_of::<ProcessBasicInformation>() as u32,
                &mut ret_len,
            ) != 0
            {
                return None;
            }
            let peb = pbi.peb_base_address as usize;
            if peb == 0 {
                return None;
            }

            let ptr_size = std::mem::size_of::<usize>();
            // x64 offsets:
            //   PEB.ProcessParameters                                  @ 0x20
            //   RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath   @ 0x38
            //     UNICODE_STRING { u16 Length; u16 MaxLength; PWSTR Buffer; }
            //       Length @ +0x00, Buffer ptr @ +0x08
            let mut params: usize = 0;
            if !read_at(peb + 0x20, &mut params as *mut _ as *mut c_void, ptr_size) || params == 0 {
                return None;
            }
            let mut len_u16: u16 = 0;
            if !read_at(params + 0x38, &mut len_u16 as *mut _ as *mut c_void, 2) {
                return None;
            }
            if len_u16 == 0 || len_u16 > 0x7ffe {
                return None;
            }
            let mut buf_ptr: usize = 0;
            if !read_at(params + 0x40, &mut buf_ptr as *mut _ as *mut c_void, ptr_size) || buf_ptr == 0 {
                return None;
            }
            let n_chars = (len_u16 as usize) / 2;
            let mut wbuf: Vec<u16> = vec![0u16; n_chars];
            if !read_at(buf_ptr, wbuf.as_mut_ptr() as *mut c_void, len_u16 as usize) {
                return None;
            }
            let s = String::from_utf16_lossy(&wbuf);
            let trimmed = s.trim_end_matches(['\\', '/']);
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })();
        CloseHandle(h);
        out
    }
}
```

- [ ] **Step 2: Verify shared tree still builds on macOS**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/platform/windows.rs
git commit -m "feat(windows): process_cwd via NtQueryInformationProcess PEB walk"
```

---

### Task 5: `windows.rs` — `clipboard_file_paths` (CF_HDROP) + `read_claude_credential`

`clipboard_file_paths` reads file paths a user copied in Explorer, via raw `CF_HDROP` + `DragQueryFileW` FFI (no `windows` crate — same style as Task 4). `read_claude_credential` mirrors `linux.rs` exactly (Claude Code stores plaintext `.credentials.json` on Windows too; no keychain). If clipboard FFI returns empty at runtime the feature degrades gracefully (paste falls through to text).

**Files:**
- Modify: `src-tauri/src/platform/windows.rs` — replace `clipboard_file_paths` and `read_claude_credential` stubs.

**Interfaces:**
- Consumes: `super::creds::extract_access_token`, `crate::config::profile_config_dir` (both exist).
- Produces: `clipboard_file_paths() -> Vec<String>`, `read_claude_credential(Option<&str>) -> Option<String>` (signatures match `linux.rs`).

- [ ] **Step 1: Replace the two stubs**

```rust
/// Read file paths off the clipboard via the shell `CF_HDROP` format (what
/// Explorer puts there on Ctrl-C of files). Raw Win32 FFI — no `windows` crate.
/// Best-effort: returns an empty vec on any failure, so paste falls through to
/// text handling.
pub fn clipboard_file_paths() -> Vec<String> {
    use std::os::raw::c_void;
    type Handle = *mut c_void;
    const CF_HDROP: u32 = 15;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hwnd: Handle) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(format: u32) -> Handle;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn DragQueryFileW(hdrop: Handle, index: u32, buf: *mut u16, cch: u32) -> u32;
    }

    let mut paths = Vec::new();
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return paths;
        }
        let hdrop = GetClipboardData(CF_HDROP);
        if !hdrop.is_null() {
            // index 0xFFFFFFFF returns the file count.
            let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, std::ptr::null_mut(), 0);
            for i in 0..count {
                // First call with null buffer returns length in chars (excl NUL).
                let len = DragQueryFileW(hdrop, i, std::ptr::null_mut(), 0);
                if len == 0 {
                    continue;
                }
                let mut buf: Vec<u16> = vec![0u16; (len + 1) as usize];
                let got = DragQueryFileW(hdrop, i, buf.as_mut_ptr(), len + 1);
                if got == 0 {
                    continue;
                }
                buf.truncate(got as usize);
                paths.push(String::from_utf16_lossy(&buf));
            }
        }
        CloseClipboard();
    }
    paths
}

/// On Windows, Claude Code stores credentials as plaintext `.credentials.json`
/// inside the profile config dir (or `~/.claude`). No keychain — identical to
/// the Linux path.
pub fn read_claude_credential(profile_id: Option<&str>) -> Option<String> {
    let dir = match profile_id {
        None | Some("") | Some("__default__") => dirs::home_dir()?.join(".claude"),
        Some(id) => crate::config::profile_config_dir(id)?,
    };
    let raw = std::fs::read_to_string(dir.join(".credentials.json")).ok()?;
    super::creds::extract_access_token(&raw)
}
```

- [ ] **Step 2: Confirm `windows.rs` no longer imports anything unused**

The `use std::path::{Path, PathBuf};` at the top of `windows.rs` is still needed (Path in reveal/open, PathBuf in extra_path_dirs). Leave it. No `todo!()` should remain.

Run: `grep -c 'todo!' src-tauri/src/platform/windows.rs`
Expected: `0`

- [ ] **Step 3: Verify shared tree builds on macOS**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/platform/windows.rs
git commit -m "feat(windows): clipboard_file_paths via CF_HDROP; plaintext credential reader"
```

---

### Task 6: Windows shell + editor discovery

Three Windows arms so the shell panel spawns PowerShell (not `/bin/zsh`), new tabs default to `pwsh`/`powershell`, and the editor picker works. `default_shell` and `start_shell_session` are in `main.rs`; editor discovery is in `sidebar.rs`.

**Files:**
- Modify: `src-tauri/src/main.rs` — `default_shell` (~line 64), `start_shell_session` (~line 230).
- Modify: `src-tauri/src/sidebar.rs` — `installed_editors` (Windows arm ~line 296), `open_in_editor` (Windows arm ~line 328).

**Interfaces:**
- Consumes: `crate::config::which`, `crate::config::silent_command`.
- Produces: no signature changes — only new `#[cfg(target_os = "windows")]` / `#[cfg(windows)]` branches.

- [ ] **Step 1: `default_shell` — prefer pwsh, then powershell**

Replace the `if cfg!(windows)` arm of `default_shell`:

```rust
fn default_shell() -> Vec<String> {
    if cfg!(windows) {
        // PowerShell 7 (pwsh) if installed, else Windows PowerShell 5.
        if config::which("pwsh.exe") {
            vec!["pwsh.exe".into()]
        } else {
            vec!["powershell.exe".into()]
        }
    } else if cfg!(target_os = "linux") {
        vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())]
    } else {
        vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())]
    }
}
```

- [ ] **Step 2: `start_shell_session` — Windows branch (no `/bin/zsh -l`, no trampoline)**

`start_shell_session` currently hardcodes `std::env::var("SHELL")` + `"-l"` + the zsh ZDOTDIR trampoline — all Unix-only. Gate the existing body as non-Windows and add a Windows branch. Wrap the current program/env/trampoline block:

Find the start of the function body:

```rust
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let program = vec![shell.clone(), "-l".to_string()];
    let path = config::augmented_path();
```

Replace with a Windows-gated split. On Windows, `program = default_shell()` (no login flag, no OSC-7 trampoline — see Deferred section), and `SHELL`/`TERM_PROGRAM` env is Unix-flavored so we set only PATH + TERM basics:

```rust
    #[cfg(windows)]
    let (program, mut env): (Vec<String>, Vec<(String, String)>) = {
        let path = config::augmented_path();
        (
            default_shell(),
            vec![
                ("TERM".into(), "xterm-256color".into()),
                ("COLORTERM".into(), "truecolor".into()),
                ("PATH".into(), path.to_string_lossy().to_string()),
            ],
        )
    };

    #[cfg(not(windows))]
    let (program, mut env) = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let program = vec![shell.clone(), "-l".to_string()];
        let path = config::augmented_path();
        let mut env: Vec<(String, String)> = vec![
            ("TERM".into(), "xterm-256color".into()),
            ("COLORTERM".into(), "truecolor".into()),
            ("TERM_PROGRAM".into(), "iTerm.app".into()),
            ("TERM_PROGRAM_VERSION".into(), "3.6.6".into()),
            ("PATH".into(), path.to_string_lossy().to_string()),
        ];
        // ZDOTDIR / PROMPT_COMMAND OSC-7 trampoline (zsh + bash) …
        // <-- keep the ENTIRE existing trampoline block here, unchanged, then:
        (program, env)
    };
```

**Note to implementer:** move the existing zsh/bash trampoline code verbatim inside the `#[cfg(not(windows))]` block before its `(program, env)` tail. Do not alter the trampoline logic. Everything after the env/trampoline setup (the `.spawn(...)` call) stays shared. Verify the `mut` on `env` is still warranted on non-Windows (the trampoline pushes to it) and that Windows `env` is `mut` only if later code mutates it — if the shared tail pushes to `env`, keep `mut` on both; otherwise drop `mut` on the Windows binding to avoid an `unused_mut` warning.

- [ ] **Step 3: `installed_editors` — Windows arm**

In `sidebar.rs`, the current `#[cfg(not(any(target_os = "macos", target_os = "linux")))] let found: Vec<EditorInfo> = vec![];` is the Windows fallback. Replace it with a real probe mirroring the Linux list (VS Code etc. ship `.cmd` launchers on PATH; `which_path` resolves them via the Task 2 ext-probe):

```rust
    #[cfg(target_os = "windows")]
    let found = tauri::async_runtime::spawn_blocking(|| -> Vec<EditorInfo> {
        // (binary_name, display_name) — resolved against the augmented PATH
        // (which_path probes .cmd/.exe). bundle_id carries the binary name.
        const WINDOWS_EDITORS: &[(&str, &str)] = &[
            ("code", "VS Code"), ("cursor", "Cursor"), ("windsurf", "Windsurf"),
            ("zed", "Zed"), ("subl", "Sublime Text"), ("nvim", "Neovim"),
            ("code-insiders", "VS Code Insiders"),
        ];
        WINDOWS_EDITORS.iter().filter_map(|&(bin, name)| {
            config::which_path(bin).map(|_| EditorInfo {
                bundle_id: bin.to_string(),
                display_name: name.to_string(),
            })
        }).collect()
    }).await.map_err(|e| e.to_string())?;

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let found: Vec<EditorInfo> = vec![];
```

- [ ] **Step 4: `open_in_editor` — Windows arm**

Add a Windows branch (spawn via `silent_command` so a console editor launcher doesn't flash), and narrow the final catch-all:

```rust
    #[cfg(target_os = "windows")]
    {
        let bin = config::which_path(&bundle_id).ok_or_else(|| format!("{bundle_id} not found"))?;
        config::silent_command(bin).arg(&path).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err("open_in_editor is not supported on this platform".to_string())
    }
```

- [ ] **Step 5: Verify macOS builds**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS (macOS arms untouched).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/src/sidebar.rs
git commit -m "feat(windows): pwsh default shell, Windows shell panel, editor discovery"
```

---

### Task 7: Console-flash suppression on git/gh spawns

`git` fires many times on startup (worktree discovery × auto-resumed tabs) and `gh` on every GitHub-tab action. Each is a console program → a flashing black window per call on Windows unless spawned with `CREATE_NO_WINDOW`. Route the three choke points through `config::silent_command`. No-op on macOS/Linux.

**Files:**
- Modify: `src-tauri/src/git.rs` — `run_git` (~line 40), `run_git_capture_stdout` (~line 60).
- Modify: `src-tauri/src/github/client.rs` — `run_gh` (~line 15).

**Interfaces:**
- Consumes: `crate::config::silent_command` (Task 2).

- [ ] **Step 1: `git.rs` — both runners**

In `run_git` and `run_git_capture_stdout`, replace `Command::new(&git)` with `crate::config::silent_command(&git)`. (Both already resolve `git` via `which_path` into the `git` binding, so only the constructor changes.) Remove/adjust any now-unused `use std::process::Command;` only if nothing else in the file uses it — otherwise leave it.

- [ ] **Step 2: `github/client.rs` — `run_gh`**

Replace `Command::new(&gh)` with `crate::config::silent_command(&gh)`.

- [ ] **Step 3: Verify macOS builds (silent_command is a no-op transform there)**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/git.rs src-tauri/src/github/client.rs
git commit -m "fix(windows): suppress console flash on git/gh spawns via silent_command"
```

---

### Task 8: Bundle + release leg (NSIS + windows-latest)

Add the NSIS installer target and the `windows-latest` release matrix leg. `tauri-action` builds NSIS + updater artifacts (`.exe`, `.nsis.zip`, `.sig`) and merges the `windows-x86_64` key into `latest.json` automatically. Unsigned (SmartScreen warning accepted).

**Files:**
- Modify: `src-tauri/tauri.conf.json` — `bundle.targets`.
- Modify: `.github/workflows/release.yml` — matrix + stale comment.

**Interfaces:**
- Produces: a `windows-latest / x86_64-pc-windows-msvc` release job; NSIS artifacts on the GitHub release; a `windows-x86_64` entry in `latest.json`.

- [ ] **Step 1: Add `"nsis"` to bundle targets**

In `tauri.conf.json`, change:

```json
    "targets": ["deb", "appimage", "app", "dmg"],
```
to:
```json
    "targets": ["deb", "appimage", "app", "dmg", "nsis"],
```

(`icon.ico` is already in the icon array; no NSIS-specific config needed — Tauri defaults produce a per-user installer.)

- [ ] **Step 2: Add the Windows matrix leg + update the stale comment in `release.yml`**

Change the matrix include list from:

```yaml
        include:
          - { os: macos-latest,     target: aarch64-apple-darwin }
          - { os: ubuntu-22.04,     target: x86_64-unknown-linux-gnu }
          - { os: ubuntu-22.04-arm, target: aarch64-unknown-linux-gnu }
```
to:
```yaml
        include:
          - { os: macos-latest,     target: aarch64-apple-darwin }
          - { os: ubuntu-22.04,     target: x86_64-unknown-linux-gnu }
          - { os: ubuntu-22.04-arm, target: aarch64-unknown-linux-gnu }
          - { os: windows-latest,   target: x86_64-pc-windows-msvc }
```

And delete the now-false top-of-file comment `# Windows is intentionally excluded until Milestone 2 (windows.rs is stubbed).` (the `Linux deps` step is already `if: startsWith(matrix.os, 'ubuntu')`, so it correctly skips on Windows; the shared `npm ci` + `tauri-action` steps run on Windows unchanged).

- [ ] **Step 3: Validate both files**

Run: `python3 -c "import json; json.load(open('src-tauri/tauri.conf.json')); print('json ok')"`
Expected: `json ok`
Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tauri.conf.json .github/workflows/release.yml
git commit -m "ci(windows): add NSIS bundle target and windows-latest release leg"
```

---

### Task 9: Docs — CHANGELOG, CLAUDE.md cwd degradation note

Record the milestone in the CHANGELOG (release notes are extracted from it by the `gate` job) and document the one parity gap in `CLAUDE.md`.

**Files:**
- Modify: `CHANGELOG.md` — new top section for the release version.
- Modify: `CLAUDE.md` — note the Windows shell-cwd degradation.

**Interfaces:**
- Produces: a `## [X.Y.Z]` CHANGELOG section the release `gate` job's awk extractor will pick up as `notes`.

- [ ] **Step 1: Add CHANGELOG section**

Prepend a section under the CHANGELOG header (the version is bumped in Task 10; use the same number there — implementer uses the value the controller supplies):

```markdown
## [X.Y.Z]

### Added
- **Windows support (x64).** Vector now builds, runs, and self-updates on Windows 10/11 via an NSIS installer. Agent cwd tracking (PEB walk), file reveal in Explorer, open-in-default-app, clipboard file paste, editor discovery, and PowerShell/pwsh shells are all wired up.

### Known limitations
- On Windows, a **shell** pane's directory does not update live on `cd` (the cwd shown refreshes when the shell panel is opened). Agent panes are unaffected. Live shell-cwd tracking (a PowerShell prompt trampoline) is a planned follow-up.
- Windows builds are **unsigned**; SmartScreen shows a "Windows protected your PC" warning on first launch (click *More info → Run anyway*).
```

- [ ] **Step 2: Add the CLAUDE.md note**

Under the `## Gotchas` section of `CLAUDE.md`, add one bullet:

```markdown
- **Windows shell cwd**: Windows ships without the OSC-7 shell trampoline (macOS/Linux use zsh ZDOTDIR / bash PROMPT_COMMAND). `read_agent_cwd` (PEB walk in `platform/windows.rs::process_cwd`) covers agent panes and shell-panel-expand; a shell pane's live cwd does not follow `cd`. Deferred follow-up: a PowerShell `prompt`-function trampoline.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: Windows support changelog + shell-cwd degradation note"
```

---

### Task 10: Version bump, ship, and CI verification

Bump the version across the three files, confirm `windows-check` is green on the branch, then (after merge) confirm the release job produces Windows artifacts + a `windows-x86_64` `latest.json` key. Runtime smoke happens on a real Windows box.

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` — version.
- Modify: `CHANGELOG.md` — replace `X.Y.Z` placeholder with the real version.

- [ ] **Step 1: Pick the version and bump all three files + lockfiles**

Bump `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` `version` to the chosen `X.Y.Z` (minor bump for a new platform, e.g. `0.5.0`), replace the `X.Y.Z` in the CHANGELOG heading, then sync lockfiles:

```bash
npm install --package-lock-only
cargo update -p vector --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 2: Confirm the three versions agree (the gate job's guard)**

Run:
```bash
node -p "require('./package.json').version"
node -p "require('./src-tauri/tauri.conf.json').version"
grep -m1 '^version' src-tauri/Cargo.toml
```
Expected: all three print the same `X.Y.Z`.

- [ ] **Step 3: Full macOS typecheck of the whole change**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 4: Commit + push, then confirm `windows-check` is green**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "release: prepare vX.Y.Z (Windows support)"
git push
```
Run: `gh run watch $(gh run list --workflow windows-check.yml -L1 --json databaseId -q '.[0].databaseId')`
Expected: `windows-check` **PASS** — this is the milestone's key automated gate (all Windows `#[cfg]` arms compile on a real Windows toolchain).

- [ ] **Step 5: After merge to main, confirm the release job produced Windows artifacts**

Once merged (the version bump triggers `release.yml`):
Run: `gh release view vX.Y.Z --json assets -q '.assets[].name'`
Expected: includes a Windows NSIS `.exe`, a `.nsis.zip`, and a `.sig`; and `latest.json` contains a `windows-x86_64` platform key (verify: `gh release download vX.Y.Z -p latest.json -O - | python3 -c "import json,sys; print('windows-x86_64' in json.load(sys.stdin)['platforms'])"` → `True`).

- [ ] **Step 6: Windows runtime smoke checklist (manual, on a real Windows box)**

Not automatable here. Record results before declaring the milestone done:
- App launches (past SmartScreen); a tab spawns Claude and it renders without VT corruption (ConPTY + aggressive filter).
- `cd` in an agent pane updates the tab cwd (PEB walk).
- Right-click → Reveal opens Explorer with the file selected; Open uses the default app.
- Copy files in Explorer → paste into a pane types the paths (CF_HDROP).
- Editor picker lists installed editors; open-in-editor launches one.
- No console windows flash during startup/GitHub actions.
- The in-app updater sees the next release and updates.

---

## Self-Review

**Spec coverage (design doc Milestone 2 items 1–8):**
1. `process_cwd` PEB walk → Task 4. ✅
2. Live cwd trampoline → **deferred** (documented degradation, Deferred section + Task 9). ✅ (sanctioned by spec fallback clause)
3. `augmented_path` Windows dirs → Task 3 (`extra_path_dirs`). ✅
4. Clipboard CF_HDROP → Task 5. ✅ (raw FFI instead of `windows` crate — Global Constraint)
5. reveal/open → Task 3. ✅
6. `default_shell` pwsh→powershell → Task 6. ✅
7. PTY/ConPTY re-verify → Task 10 Step 6 (filter unchanged; the fork confirmed no filter change needed — re-verified at smoke). ✅
8. NSIS bundle + latest.json windows key → Task 8 + Task 10 Step 5. ✅
- Load-bearing extra not in spec: `which_path` exe-ordering (Task 2) — without it npm agents don't launch on Windows. ✅
- Console-flash suppression (Task 2 + 7) — Windows UX. ✅
- Windows shell panel + editor discovery (Task 6) — parity. ✅

**Placeholder scan:** `X.Y.Z` in Tasks 9–10 is intentional (controller supplies the concrete version at execution); every code block is complete. No TBD/TODO.

**Type consistency:** `silent_command` signature identical in Tasks 2/3/6/7. `process_cwd`/`clipboard_file_paths`/`read_claude_credential`/`reveal_in_file_manager`/`open_default_app`/`open_path`/`extra_path_dirs` match the `linux.rs` signatures the module surface requires. `EditorInfo { bundle_id, display_name }` matches the Linux arm.
```