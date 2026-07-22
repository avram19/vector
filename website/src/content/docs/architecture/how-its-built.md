---
title: How it's built
description: A tour of Vector's architecture — Tauri v2, xterm.js, the PTY pipeline, and the cross-platform layer.
---

Vector is a [Tauri v2](https://v2.tauri.app/) desktop app. Each tab replaces the shell inside a terminal with an AI coding agent's CLI (Claude Code, Codex, etc.) — the tab owns a PTY running that agent, rendered into the page with [xterm.js](https://xtermjs.org/). It ships on macOS, Linux, and Windows.

## Frontend

`src/App.tsx` is a single, large file holding most UI state: tabs, the per-tab recursive pane tree (`PaneLeaf | PaneSplit`), the project picker modal, the update banner, and xterm wiring for every pane.

- xterm.js addons in use: `FitAddon`, `WebLinksAddon`, `Unicode11Addon`. WebGL/Canvas renderers were tried and removed — they rendered worse inside the WebView, so the app stays on the DOM renderer.
- The PTY bridge is a thin Tauri `invoke` layer: `start_session` spawns the PTY, the frontend subscribes to `pty-data-{sessionId}` / `pty-exit-{sessionId}` events, and keystrokes go back over `write_stdin`.
- `src/sidebar/` is the rail + panel (Files / Worktrees / GitHub tabs), `src/preview/` holds the preview-pane renderers (code/diff/markdown/mermaid/pdf/image), and `src/github/` is the GitHub tab (Repos, PR inbox, Actions, notifications badge) — all talking to `github::*` backend commands.

## Backend

The Rust backend lives in `src-tauri/src/`:

- `main.rs` — Tauri command handlers and shared `AppState` (agent registry, config, profiles, UI config, GitHub state, file watchers). It resolves the agent binary against an augmented `PATH` before spawning, since macOS GUI apps start with a minimal one.
- `pty.rs` — PTY spawn/read/write, the VT filter, and frame coalescing (see below). The most load-bearing file in the app.
- `config.rs` — the builtin agent list, TOML overrides from `~/.config/vector/config.toml`, and the `ui.toml`-backed `UiConfig`.
- `sessions.rs` — indexes Claude's `~/.claude/projects/*/*.jsonl` files to power the resume picker.
- `sidebar.rs` / `git.rs` — file tree, worktree discovery, and diff generation for the sidebar.
- `github/` — the GitHub sidebar backend, entirely driven through the `gh` CLI via a single choke point (`client.rs::run_gh`), so auth is whatever the user is already logged into with `gh` — no tokens stored.

## The PTY pipeline

The trickiest part of Vector is keeping the terminal from visually corrupting itself while an agent is mid-redraw. `pty.rs` splits PTY handling into a reader thread and an emitter thread:

1. **Reader thread** blocks on `reader.read()`, runs the output through a VT filter (which carries partial escape sequences across chunk boundaries), and pushes the filtered bytes through an `mpsc` channel.
2. **Emitter thread** blocks for the first chunk, then drains the channel with a `recv_timeout` for **16 ms** (one 60fps frame) or until it collects **128 KB**, whichever comes first — then emits everything collected as a single combined string.

This coalescing exists because Claude's diff-redraws emit a cursor-up, a cursor-forward, and a repaint across several separate VT sequences. If those land at xterm.js across multiple separate `emit()` calls, xterm can render a half-applied state in between — the scattered-letter and em-dash corruption seen in early Vector releases. Batching them into one frame means xterm only ever sees a complete redraw.

The filter also strips Claude's OSC 777 remote-control notifications (which otherwise bleed into the visible buffer), and — in an aggressive mode enabled only for Claude sessions — strips the DECSET/RST 2026 synchronized-update-mode markers that would otherwise race xterm's own batching.

## Cross-platform layer

OS-divergent operations (credential storage, clipboard/file-manager integration, path handling) live behind `src-tauri/src/platform/`, a module with one file per OS — `macos.rs`, `linux.rs`, `windows.rs` — plus shared surfaces like `creds.rs` and `uri_list.rs`. This is the single dispatch point for anything that differs by platform: the rest of the backend calls into `platform::*` rather than branching on `cfg(target_os)` inline, so porting to a new OS means filling in one module rather than hunting through the codebase.

## Further reading

Design specs for individual features — the GitHub sidebar, PR inbox, Actions dashboard, notifications, and the cross-platform port — live under `docs/superpowers/specs/` in the repository, if you want the reasoning behind a specific piece.
