# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Vector is

A Tauri v2 desktop app (macOS-first, Apple Silicon) that replaces the shell inside terminal tabs with AI coding agents (Claude Code, Codex, etc.). Each tab owns a PTY running the agent's CLI, rendered into xterm.js. See `README.md` for user-facing behavior and the full agent list.

## Build / run / release

```bash
npm install
npm run tauri dev                                 # HMR frontend + Rust dev build
npm run tauri build                               # .app + .dmg in src-tauri/target/release/bundle/
cargo check --manifest-path src-tauri/Cargo.toml  # quick backend typecheck
```

There is no test suite. Verify changes by running the app and exercising the affected flow — especially anything that touches `pty.rs`.

Release: bump version in **three** files — `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` — sync lockfiles (`npm install --package-lock-only` and any `cargo` command), commit, tag `vX.Y.Z`, push, create the GitHub release with custom "What's new" notes (otherwise the script auto-generates from `git log`), then:

```bash
TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<passphrase>' bash scripts/release.sh
```

The script builds + signs with `~/.config/vector-updater/private.ke`, reads the release body back via `gh release view --json body`, embeds it in `latest.json` as `notes` (this is what the in-app updater shows as "What's new"), and uploads DMG + tarball + sig + manifest. If the signing password is wrong, `npm run tauri build` fails and no artifacts are uploaded.

## Architecture

**Frontend — `src/App.tsx`** (single file, all UI state)
- Tabs, per-tab recursive pane tree (`PaneLeaf | PaneSplit`), picker modal, update banner, xterm wiring per pane.
- xterm.js addons in use: `FitAddon`, `WebLinksAddon`, `Unicode11Addon`. WebGL/Canvas renderers have been tried and removed — they rendered worse on WKWebView. Stay on the DOM renderer.
- PTY bridge: `invoke("start_session", …)`, subscribe to `pty-data-{sessionId}` and `pty-exit-{sessionId}`, write via `invoke("write_stdin", …)`.

**Backend — `src-tauri/src/`**
- `main.rs` — Tauri command handlers + `AppState { registry, config }`. Resolves the agent binary against `augmented_path()` before spawning; sets `TERM=xterm-256color`, `COLORTERM=truecolor`; enables aggressive PTY filtering when `agent_id == "claude"`.
- `pty.rs` — PTY spawn/read/write + VT filter + **frame coalescing**. Most load-bearing file; easiest to regress.
- `config.rs` — Builtin agent list, TOML overrides from `~/.config/vector/config.toml`, and `augmented_path()` which prepends homebrew/cargo/npm/bun dirs because macOS GUI apps start with a minimal PATH.
- `sessions.rs` — Indexes Claude's `~/.claude/projects/*/*.jsonl` session files for the resume picker. Results cached by path+mtime.

## PTY pipeline (critical — do not regress)

In `pty.rs`, the reader→emitter split fixes Claude Code streaming corruption:

1. Reader thread blocks on `reader.read()`, runs `filter_pty_output` (handles sequences split across chunks via a carry buffer), pushes filtered bytes through an `mpsc::channel`.
2. Emitter thread blocks on the first chunk, then drains with `recv_timeout` for **16 ms** (one 60 fps frame) or until **128 KB**, and emits a single combined string per frame.

Why: Claude's diff-redraws emit cursor-up + CUF + repaint across several VT sequences. If those arrive at xterm across multiple `emit()`s, xterm can render a half-applied state between them (scattered-letter / em-dash corruption seen pre-v0.1.5). Do not go back to emitting on every PTY read.

The filter also:
- Strips **OSC 777** (Claude's `warp://cli-agent;{JSON}` remote-control notifies) for every session. xterm's OSC parser bleeds the payload into the visible buffer.
- In aggressive mode (Claude only, via the `aggressive_filter: bool` spawn arg), strips **DECSET/RST 2026** synchronized-update-mode markers (`ESC[?2026h` / `ESC[?2026l`). xterm 5.5 batches writes inside sync mode and its flush timing races Claude's redraws.

A prior attempt to rewrite CUF (`ESC[nC`) into literal spaces with SGR-inverse/bg tracking regressed Claude's inverse-styled prompt bar. Don't reintroduce it.

## Agent launch / resume

- `supported_resume_agents` returns `["claude"]` — single source of truth for whether the resume UI is enabled per agent.
- Claude is the only agent with session args: `--resume <id>` or `--continue` appended in `main.rs::start_session`.
- Adding a new agent with resume support means: update `supported_resume_agents`, add args in `start_session`, and add a `list_*_sessions` path in `sessions.rs`.

## Pane / tab model

- Each tab has a `root: PaneNode` — recursive `PaneLeaf` (one PTY) or `PaneSplit` (orientation + ratio + two children).
- Rendering is flat: walk the tree to compute `{leafId, rect}` for each leaf and divider, then absolutely position panes.
- Drag migration uses a `dndRef` payload; dropping on another pane splits/merges, dropping on the tab strip creates a new tab.
- Saved tabs go through `migrateTab` on restore to coerce older shapes into the current pane-tree schema.

## Gotchas

- **cols-3 margin**: `App.tsx` tells the PTY `cols - 3` and calls `term.resize(cols-3, rows)` to match. WebView fractional layout makes xterm slightly narrower than the window reports; removing this reintroduces wrap/scroll misalignment.
- **macOS GUI PATH is minimal** — never call a binary by bare name from Rust without going through `config::which_path`, or child processes spawned by agents (git, node, etc.) will fail to find tools.
- **Bundle identifier** `dev.vector.app` ends in `.app` (Tauri warns); changing it invalidates the updater for existing installs.
- **Pinned versions**: all `package.json` deps are pinned exactly (no `^`/`~`). Dependabot alerts have been addressed by pinning. Don't loosen constraints to quiet a warning.
- **License**: PolyForm Noncommercial 1.0.0. Commercial use requires a separate license.

## Updating this file (meta-rule)

Keep `CLAUDE.md` lean — every line here loads on every session. Add content only if it's (a) always-on behavior, (b) non-negotiable workflow/principles, or (c) required context not discoverable from code or README. Push topic-specific notes into a separate doc and link to it.

## Bash / tooling hygiene

- Don't chain independent commands with `&&` when each is already permitted — use separate parallel Bash calls; they run concurrently without stacking permission prompts.
- Prefer context-mode (`ctx_execute` shell) for commands with large output (`git log`, `git diff`, build logs, test output). Short/deterministic reads (`git rev-parse HEAD`, `git status`, `git remote -v`) are fine via Bash.

## Workflow orchestration

1. **Plan mode default.** Any non-trivial task (3+ steps or architectural decisions) starts in plan mode. If things go sideways, stop and re-plan — don't push through.
2. **Subagents for breadth.** Offload research, exploration, and parallel analysis to subagents. Keep the main context clean. One focused task per subagent.
3. **Todo list (mandatory).** Every change gets a `todo.md` with checkable items. It is the compaction-safe progress checkpoint. Mark items off as you go so a resumed session knows exactly where to pick up.
4. **Plan maintenance.** The plan is the single source of truth. When the approach changes mid-task, update the plan immediately — not at the end.
5. **Context preservation.** Before compaction, save a memory file under `~/.claude/projects/-Users-avinash-Personal-Vector/memory/` capturing decisions, current state, blockers, and key findings. Don't let compaction happen without persisting state first.
6. **Verification before done.** There is no test suite in this repo. A task is not complete until the app has been built and the affected flow exercised in a running instance. "It should work" is not acceptable.
7. **Demand elegance.** On non-trivial changes, pause and ask: is there a more elegant way? If the fix feels hacky, implement the real one. Skip for one-line obvious fixes.
8. **Autonomous bug fixing.** Given a bug report, just fix it — point at logs/errors yourself and resolve. No hand-holding back to the user.
9. **Long-running work goes to the background.** Anything that would otherwise require `sleep`/polling runs via `run_in_background: true` — never block the conversation.
10. **No `--no-verify`.** Never bypass pre-commit hooks or signing. If permission is granted once, it does not carry over — ask each time.
11. **Read-only ops run without asking.** Reading files, logs, GitHub/MCP data — proceed. If a tool forces a prompt for read-only work, script around it. Never interrupt the user for read-only operations.
12. **Staff-engineer review before push.** For non-trivial changes, spawn a subagent that independently reviews the diff — it should build its own context (read surrounding code, trace call paths, check downstream effects), not be spoon-fed. Address all findings before pushing.

## Plans directory

All plans, scripts, and prompts live under `~/.claude/projects/-Users-avinash-Personal-Vector/plans/<session>/` — outside the repo, never committed. Name each session subfolder by tag (`v0.1.5`) or a short descriptive slug. Scripts go in `plans/<session>/scripts/`, prompts in `plans/<session>/prompts/`. Do not drop plan files inside the repo or any worktree of it.

## Core principles

- **Simplicity first** — impact minimal code; don't over-engineer.
- **No laziness** — find root causes; no temporary fixes or "good enough" patches.
- **Minimal blast radius** — changes touch only what's necessary.
- **No guessing** — read the code or logs before assuming behavior.
- **Own mistakes** — when corrected, acknowledge, fix, and internalize the rule (save a memory if it's a rule you'll need again).
- **Prove it works** — every change is verified, not asserted.
