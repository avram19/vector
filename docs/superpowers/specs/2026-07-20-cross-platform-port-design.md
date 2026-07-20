# Cross-Platform Port — Windows + Linux

**Status:** Design approved, pending spec review
**Date:** 2026-07-20
**Author:** brainstorming session

## Goal

Port Vector from macOS-only to a tri-platform app (macOS, Linux, Windows) with
**full feature parity per platform**. Every feature that works on macOS must work
on a platform before that platform ships. No silent degradation.

## Constraints & decisions (locked)

- **Order:** Linux first, then Windows. Each platform's release is gated on
  *its own* feature parity — Linux does not wait on Windows's hard problems.
- **Parity bar:** Full parity per platform. Hard items (Windows live-cwd, Wayland
  clipboard) must be solved, not stubbed.
- **Distribution:** GitHub Releases, unsigned to start. Windows ships with the
  SmartScreen warning accepted; Authenticode signing is a later add-on. Linux
  AppImage/`.deb` need no signing.
- **App keybindings on Win/Linux:** `Ctrl+Shift` for app actions (new tab, split,
  reload, copy). `Ctrl` alone stays with the terminal (Ctrl+C/D/U → shell). The
  macOS `Cmd+Arrow` readline shims are dropped on Win/Linux (native Ctrl/Alt
  readline already works there).
- **Build/verify:** GitHub Actions 3-OS matrix produces installers; interactive
  parity verification runs in local Linux + Windows VMs.

## Architecture — the platform abstraction

Today platform-divergent logic is scattered as inline `#[cfg(target_os=…)]`
across `main.rs`, `config.rs`, `clipboard.rs`, `usage.rs`, `sidebar.rs`,
`preview.rs`. With three OSes and a full-parity bar, that scatter rots and hides
gaps.

**Introduce `src-tauri/src/platform/`:**

```
platform/
  mod.rs      # public surface — one fn per OS-divergent op; re-exports the active OS impl
  macos.rs    # existing macOS code lifted VERBATIM (no behavior change)
  linux.rs    # Linux impl
  windows.rs  # Windows impl
```

`mod.rs` selects the impl with a single `#[cfg]` block and re-exports it, so
callers become platform-agnostic. Because every OS module must implement the same
surface, the compiler enforces completeness — a missing Linux/Windows
implementation is a build error, not a runtime parity gap.

### The surface (functions each OS module implements)

| Function | macOS today | Linux | Windows |
|---|---|---|---|
| `augmented_path() -> OsString` | Homebrew/cargo/npm/bun | `~/.local/bin` + cargo/npm/bun | `%APPDATA%\npm`, cargo, bun, scoop shims, choco, Git |
| `open_path(target)` | `/usr/bin/open` | `xdg-open` | `cmd /C start` / `ShellExecute` |
| `reveal_in_file_manager(path)` | `open -R` | DBus `FileManager1.ShowItems` → `xdg-open` fallback | `explorer /select,<path>` |
| `open_default_app(path)` | `open` | `xdg-open` | `ShellExecute` |
| `process_cwd(pid) -> Option<String>` | `libproc` PROC_PIDVNODEPATHINFO | `readlink /proc/<pid>/cwd` | `NtQueryInformationProcess` → PEB → `CurrentDirectory` |
| `clipboard_file_paths() -> Vec<String>` | `NSPasteboard` | `wl-paste`/`xclip` `text/uri-list` → parse `file://` | `CF_HDROP` via `windows` crate |
| `read_claude_credential() -> Option<String>` | Keychain via `/usr/bin/security` | plaintext `~/.claude/.credentials.json` | plaintext `~/.claude/.credentials.json` |
| `discover_editors() -> Vec<Editor>` | `mdfind` + bundle IDs | PATH + `.desktop` scan | PATH + registry / known install dirs |
| `default_shell() -> Vec<String>` | `$SHELL` else `/bin/zsh` | `$SHELL` else `/bin/bash` | `pwsh.exe` → `powershell.exe` |
| `cwd_trampoline(shell) -> Option<Trampoline>` | zsh ZDOTDIR OSC-7 | zsh + bash (`PROMPT_COMMAND`) OSC-7 | PowerShell `prompt`-function OSC-7 |

`set_badge_count` stays on the Tauri API (no-op off macOS) and needs no platform
module. The `credentials_in_keychain` heuristic in `validate_claude_home` is
already correctly macOS-gated (`.credentials.json` is plaintext elsewhere).

## Milestone 1 — Linux (near-full parity, low effort)

Linux is cheap: Unix PTY works, `/proc` gives cwd for free, shell trampolines
work. The work is filling the platform module and solving the clipboard.

1. **`platform` module scaffold** — create the module, lift macOS code verbatim,
   convert all inline `#[cfg]` callsites to call `platform::*`. Verify macOS still
   builds and behaves identically. This is the foundation for both milestones.
2. **`process_cwd`** — `readlink /proc/<pid>/cwd`. Replaces libproc on Linux.
3. **Live cwd tracking** — generalize the `start_shell_session` trampoline: zsh via
   ZDOTDIR (existing), bash via a `--rcfile` that appends OSC-7 to `PROMPT_COMMAND`
   and sources the user's `~/.bashrc`. Both emit `\033]7;file://$HOST$PWD\007`.
4. **`augmented_path`** — Linux dirs.
5. **Clipboard file paths (the messy one, required by parity)** — detect
   `wl-paste` (Wayland) or `xclip`/`xsel` (X11), request `text/uri-list`, parse
   `file://` URIs (URL-decode). Empty result if no helper is installed (best-effort
   is acceptable *only* when the tool is genuinely absent; the code path itself is
   complete).
6. **`reveal_in_file_manager`** — DBus `org.freedesktop.FileManager1.ShowItems`
   (selects the file in the user's file manager), `xdg-open` on the parent dir as
   fallback.
7. **`discover_editors`** — scan PATH for known binaries (`code`, `cursor`,
   `windsurf`, `subl`, `nvim`, `zed`, …) and `.desktop` entries.
8. **`read_claude_credential`** — read plaintext `~/.claude/.credentials.json` for
   the usage meter.
9. **Menu / window chrome** — Tauri renders the app menu in-window on GTK; verify
   it doesn't consume layout awkwardly; hide macOS-only items.
10. **Bundle** — AppImage + `.deb` targets; wire AppImage into the updater manifest.
11. **RISK — WebKitGTK ≠ WKWebView** — Vector renders xterm.js on the DOM renderer
    (WebGL/Canvas were removed *because* they rendered worse on WKWebView, per
    CLAUDE.md). WebKitGTK is a different engine; xterm rendering, the cols-3 margin,
    and frame-coalescing timing must be re-verified. If DOM rendering regresses on
    WebKitGTK, re-evaluate the renderer *for Linux only* (do not change macOS).

## Milestone 2 — Windows (hardest)

1. **`process_cwd` (highest-risk item)** — `NtQueryInformationProcess`
   (`ProcessBasicInformation`) to get the PEB address, read `PEB →
   RTL_USER_PROCESS_PARAMETERS → CurrentDirectory.DosPath` across the process
   boundary with `ReadProcessMemory`. Undocumented but ABI-stable. Requires the
   `windows` crate. Guard with 32/64-bit awareness. If this proves unreliable,
   fall back to the trampoline-only cwd for the affected session (documented
   degradation reviewed before shipping).
2. **Live cwd tracking** — PowerShell `prompt`-function trampoline: launch with a
   profile that overrides `prompt` to emit OSC-7 and call the original. Falls back
   to `process_cwd` polling.
3. **`augmented_path`** — `%APPDATA%\npm`, `%USERPROFILE%\.cargo\bin`,
   `%USERPROFILE%\.bun\bin`, `scoop\shims`, choco `bin`, Git-for-Windows `cmd`.
4. **Clipboard file paths** — `CF_HDROP` via the `windows` crate: `OpenClipboard`
   → `GetClipboardData(CF_HDROP)` → `DragQueryFileW`.
5. **`reveal_in_file_manager` / `open_default_app`** — `explorer /select,<path>`
   and `ShellExecuteW`.
6. **`default_shell`** — prefer `pwsh.exe`, fall back to `powershell.exe`.
7. **PTY / ConPTY** — portable-pty uses ConPTY on Windows. Re-verify the aggressive
   Claude VT filter (DECSET/RST 2026, OSC-777) and frame-coalescing under ConPTY,
   which injects its own resize/repaint sequences. Adjust the filter only if
   corruption appears; do not regress macOS.
8. **Bundle** — NSIS installer + updater artifacts, unsigned (SmartScreen warning
   accepted). Add Windows keys to `latest.json`.

## Frontend (shared, lands with Milestone 1)

- **OS detection** via `@tauri-apps/plugin-os` (`platform()`), computed once.
- **`isMod(e)` helper** replacing scattered `e.metaKey` checks: `metaKey` on macOS,
  `ctrlKey && shiftKey` on Win/Linux for app actions.
- **Ctrl+Shift bindings** on Win/Linux for: new tab, close tab, split, reload,
  copy/paste (copy = Ctrl+Shift+C so Ctrl+C reaches the shell).
- **Drop the `Cmd+Arrow` → readline shims** on Win/Linux (they'd collide with
  terminal Ctrl+A/E; native readline already works there). Keep them on macOS.
- **Titlebar/traffic-light CSS** — any left padding reserved for macOS traffic
  lights flips to the right on Win/Linux where window controls live. Verify the
  tab strip layout.

## Release pipeline

- **`scripts/release.sh`** generalized (or split per-OS) — today it hardcodes
  `.dmg`, `aarch64`, `Vector.app.tar.gz`, and macOS notarization.
- **`latest.json`** gains per-platform keys: `darwin-aarch64` (existing),
  `linux-x86_64` (AppImage), `windows-x86_64` (NSIS). The Tauri updater reads the
  matching key per client.
- **GitHub Actions 3-OS matrix** (`macos-latest`, `ubuntu-latest`,
  `windows-latest`) builds + signs (updater key) + uploads artifacts. Interactive
  parity verification is manual in local VMs before promoting a release.
- **Updater signing key** (`~/.config/vector-updater/private.ke`) is shared across
  platforms — the same key signs all three bundle types.

## Testing / verification

No unit-test suite exists. Verification is behavioral, per CLAUDE.md:

- **Build:** CI matrix must produce installable artifacts on all three runners.
- **Linux VM:** exercise PTY streaming (Claude session), live cwd tracking (zsh +
  bash), clipboard file paste, reveal-in-files, editor open, usage meter, GitHub
  sidebar, updater. Confirm xterm renders cleanly on WebKitGTK.
- **Windows VM:** same checklist, plus ConPTY streaming correctness and
  `process_cwd` accuracy across node/agent child processes.
- **macOS regression:** after the platform-module refactor, re-run the macOS flow
  to confirm zero behavior change.

## Out of scope (YAGNI)

- Windows Authenticode / macOS notarization automation (unsigned-first decision).
- Linux ARM / Windows ARM builds (x86_64 + aarch64-macOS only for v1).
- A user-facing keybinding config file (Ctrl+Shift default only; configurability
  is a possible later milestone).
- Snap / Flatpak packaging (AppImage + `.deb` only for v1).

## Open risks (tracked, not blockers)

1. **WebKitGTK xterm rendering** (Linux) — may force a Linux-only renderer
   decision.
2. **`NtQueryInformationProcess` cwd** (Windows) — undocumented PEB walk; fallback
   is trampoline-only cwd.
3. **ConPTY + aggressive Claude filter** (Windows) — filter tuned on macOS PTY may
   need ConPTY-specific handling.
