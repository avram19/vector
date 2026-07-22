# Vector

[![Downloads](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/avram19/vector/stats/downloads-badge.json)](https://github.com/avram19/vector/releases)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-avram19.github.io%2Fvector-informational)](https://avram19.github.io/vector/)

An agent-first terminal. Every tab starts inside your favorite coding agent
(Claude Code, Codex, Cursor Agent, GitHub Copilot CLI, Aider, Gemini, Amazon
Q, OpenCode, Crush, Goose, Amp, Plandex, Continue, Qodo — or a raw shell),
not a shell prompt.

<p align="center">
  <img src="src/logo.png" alt="Vector" width="96" />
</p>

**📖 Full docs, features, shortcuts, and guides: [avram19.github.io/vector](https://avram19.github.io/vector/)**

## Install

**macOS** — download the latest `.dmg` from [Releases](https://github.com/avram19/vector/releases), drag Vector into `/Applications`, and open it. The build is unsigned, so Gatekeeper blocks it the first time — right-click → Open, or run `xattr -dr com.apple.quarantine /Applications/Vector.app`.

**Linux** (x86_64/aarch64, WebKitGTK) — grab the `.AppImage` or `.deb` from [Releases](https://github.com/avram19/vector/releases); for the AppImage, `chmod +x Vector_*.AppImage` and run it.

**Windows** (x64) — download the `.exe` installer from [Releases](https://github.com/avram19/vector/releases) and run it. The build is unsigned, so SmartScreen warns on first launch — click **More info → Run anyway**.

Full install steps and first-run notes: [docs → Getting Started → Install](https://avram19.github.io/vector/getting-started/install/).

## Build from source

Requirements: Rust (stable), Node 20+, macOS / Linux / Windows.

```bash
npm install
npm run tauri dev       # dev build with HMR
npm run tauri build     # produce .app + .dmg in src-tauri/target/release/bundle/
```

More detail: [docs → Architecture → Build from source](https://avram19.github.io/vector/architecture/build-from-source/).

## Add a custom agent

Drop a TOML file at `~/.config/vector/config.toml` describing the agent's command and env — Vector merges it with the built-in list on every launch. See [docs → Agents → Add a custom agent](https://avram19.github.io/vector/agents/custom-agent/) for the full schema and an example.

## Learn more

Everything else — features, keyboard shortcuts, Claude Profiles, the sidebar, GitHub tab, file previewer, and more — lives in the docs:

- [Getting Started](https://avram19.github.io/vector/getting-started/install/)
- [Guide: Shortcuts](https://avram19.github.io/vector/guide/shortcuts/)
- [Guide: Claude Profiles](https://avram19.github.io/vector/guide/profiles/)
- [Agents: full agent list](https://avram19.github.io/vector/agents/agent-list/)
- [Architecture: how it's built](https://avram19.github.io/vector/architecture/how-its-built/)

## How it was built

**This is a vibe-coded app.** A human supplied the requirements in plain
English, and the implementation — Rust backend, React/TypeScript frontend,
Tauri packaging, icon generation, all of it — was produced by an AI coding
agent following those requirements. No line of code here was hand-written by
the human who scoped the project.

If you're curious what "agentic software development" looks like end-to-end,
this repository is one example: read the requirements, read the code, and
judge for yourself.

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
