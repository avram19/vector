---
title: Supported agents
description: The full list of coding agents Vector can run in a tab, and how it decides which ones to show.
---

Vector doesn't hard-wire itself to one agent — each tab spawns a PTY running whichever CLI you pick, rendered into the same xterm.js surface. The built-in list:

- **Claude Code** (`claude`)
- **Codex** (`codex`)
- **Cursor Agent** (`cursor-agent`)
- **GitHub Copilot CLI** (`copilot` / `gh-copilot`)
- **Aider** (`aider`)
- **Gemini CLI** (`gemini`)
- **Amazon Q** (`q`)
- **OpenCode** (`opencode`)
- **Crush** (`crush`)
- **Goose** (`goose`)
- **Amp** (`amp`)
- **Plandex** (`plandex`)
- **Continue** (`continue` / `cn`)
- **Qodo** (`qodo` / `qodo-gen`)

...plus a raw shell option, for when you just want a terminal tab with no agent at all.

## Auto-detect installed agents

Vector scans your `PATH` for each of these binaries at startup and only lists the ones you actually have installed — no need to manually enable or disable agents you don't use. If a CLI has more than one possible binary name (e.g. `copilot` vs `gh-copilot`), Vector picks whichever one it finds first.

You can switch an existing tab's agent from the topbar dropdown at any time; the session restarts cleanly with the new agent.

Don't see an agent you use? See [Add a custom agent](/agents/custom-agent/) — Vector will merge any CLI you point it at into this same list.
