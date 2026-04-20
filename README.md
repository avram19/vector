# Vector

An agent-first terminal. Every tab starts inside your favorite coding agent
(Claude Code, Codex, Cursor Agent, GitHub Copilot CLI, Aider, Gemini, Amazon
Q, OpenCode, Crush, Goose, Amp, Plandex, Continue, Qodo — or a raw shell),
not a shell prompt.

<p align="center">
  <img src="src/logo.png" alt="Vector" width="96" />
</p>

## What it does

- **Agent-native tabs** — `⌘T` opens a new tab already inside an agent, scoped to a project folder you pick.
- **Auto-detect installed agents** — scans `PATH` for known CLIs; only shows ones you actually have.
- **Project picker** — remembers recents, one picker per new tab.
- **Per-tab agent swap** — change agent from the topbar dropdown; session restarts cleanly.
- **Bell notifications** — when an agent emits `\x07` (asking for input) and the tab is inactive or the window is unfocused, the tab is highlighted and a macOS notification fires.
- **Theme** — dark or Solarized Light.
- **Tab layout** — horizontal on top, or vertical sidebar.
- **Per-agent icons and chips** in every tab.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘T` | New tab (opens project picker) |
| `⌘W` | Close active tab |
| `⌘⇧R` | Reload (restart) active agent |
| `⌘1`…`⌘9` | Switch tab |

## How it was built

**This is a vibe-coded app.** A human supplied the requirements in plain
English, and the implementation — Rust backend, React/TypeScript frontend,
Tauri packaging, icon generation, all of it — was produced by an AI coding
agent following those requirements. No line of code here was hand-written by
the human who scoped the project.

If you're curious what "agentic software development" looks like end-to-end,
this repository is one example: read the requirements, read the code, and
judge for yourself.

## Try it

Download the latest `.dmg` from the [Releases](https://github.com/avram19/vector/releases)
page, drag Vector into `/Applications`, and open it.

Because the build is unsigned, macOS Gatekeeper will block it the first time.
To bypass once:

```
# Option A — right-click Open
Right-click Vector.app → Open → Open

# Option B — remove the quarantine attribute
xattr -dr com.apple.quarantine /Applications/Vector.app
```

After the first launch, you can open it normally from Launchpad or
Spotlight.

On first launch Vector will ask for Notification permission (so agents can
alert you when they need input) — grant it in System Settings if you dismiss
the prompt.

## Build from source

Requirements: Rust (stable), Node 20+, macOS / Linux / Windows.

```bash
npm install
npm run tauri dev       # dev build with HMR
npm run tauri build     # produce .app + .dmg in src-tauri/target/release/bundle/
```

## Add a custom agent

Drop a TOML file at `~/.config/vector/config.toml`:

```toml
default = "claude"

[agents.myagent]
label = "My Custom Agent"
command = ["my-cli", "--flag"]

[agents.myagent.env]
MY_API_KEY = "..."
```

Vector merges this with the built-in list on every launch.

## License

Source-available under the
[PolyForm Noncommercial License 1.0.0](./LICENSE).

Anyone is free to read, modify, redistribute, and use Vector for non-commercial
purposes (personal use, research, hobby projects, internal use at a nonprofit,
etc.). **Commercial use requires a separate license** — open an issue or
contact the maintainer.

Vector bundles and invokes third-party CLIs (Claude Code, Codex, Cursor
Agent, Copilot CLI, etc.) — those are governed by their own licenses and
terms of service.
