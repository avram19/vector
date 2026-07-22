# Changelog

All notable, user-facing changes to Vector. **This file is the source of the
release notes** — on each release, the workflow publishes the section whose
heading matches the version being released (the in-app updater shows it as
"What's new").

How to use: while working, add bullets under `## [Unreleased]`. When you cut a
release, rename that heading to the version you're releasing (e.g.
`## [0.4.3] - 2026-07-22`) and start a fresh `## [Unreleased]`. Keep bullets
short and user-facing: `- **Thing** — what the user gets.`

## [Unreleased]

## [0.5.0] - 2026-07-22

- **Windows support (x64)** — Vector now builds, runs, and self-updates on Windows 10/11 via an NSIS installer. Agent directory tracking, reveal-in-Explorer, open-in-default-app, clipboard file paste, editor discovery, and PowerShell/pwsh shells are all wired up.
- **Known limitation** — on Windows, a *shell* pane's directory doesn't update live as you `cd` (it refreshes when you open the shell panel); agent panes are unaffected. Live shell tracking is a planned follow-up.
- **Note** — Windows builds are unsigned; SmartScreen shows a "Windows protected your PC" prompt on first launch (click *More info → Run anyway*).

## [0.4.2] - 2026-07-21

- **Security fixes** — updated dependencies to close all known advisories (markdown/diff preview XSS via DOMPurify/Mermaid, a Tauri IPC issue, and a TLS certificate-parsing bug).

## [0.4.0] - 2026-07-21

- **Linux support** 🐧 — Vector now runs on Linux (x86_64 and aarch64) via AppImage or `.deb`, with full feature parity to macOS: PTY streaming, live cwd tracking, clipboard file-paste, file/diff previews, the GitHub sidebar, and the Claude usage meter.
- **Platform-aware shortcuts** — app actions use **Ctrl+Shift** on Linux (⌘ on macOS); settings is `Ctrl+,`, terminal copy/paste is `Ctrl+Shift+C` / `Ctrl+Shift+V`. The Settings → Keyboard shortcuts panel shows the right keys per platform.
- **Native chrome follows your theme** on Linux (menu bar + titlebar), with themed controls and a "Show in Files" action.
