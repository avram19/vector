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

## [0.4.2] - 2026-07-21

- **Security fixes** — updated dependencies to close all known advisories (markdown/diff preview XSS via DOMPurify/Mermaid, a Tauri IPC issue, and a TLS certificate-parsing bug).

## [0.4.0] - 2026-07-21

- **Linux support** 🐧 — Vector now runs on Linux (x86_64 and aarch64) via AppImage or `.deb`, with full feature parity to macOS: PTY streaming, live cwd tracking, clipboard file-paste, file/diff previews, the GitHub sidebar, and the Claude usage meter.
- **Platform-aware shortcuts** — app actions use **Ctrl+Shift** on Linux (⌘ on macOS); settings is `Ctrl+,`, terminal copy/paste is `Ctrl+Shift+C` / `Ctrl+Shift+V`. The Settings → Keyboard shortcuts panel shows the right keys per platform.
- **Native chrome follows your theme** on Linux (menu bar + titlebar), with themed controls and a "Show in Files" action.
