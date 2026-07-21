---
title: Claude profiles
description: Map folders to separate Claude accounts and switch without /logout, /login.
---

If you juggle two Claude accounts — say personal and work — the usual flow is painful: Claude Code keeps a single login in `~/.claude/`, so switching means `/logout` then `/login` every time you move between folders.

Vector solves this by mapping **folders → profiles**, where each profile is an isolated Claude home (`~/.claude-profiles/<id>/`) injected via `CLAUDE_CONFIG_DIR` when a Claude session starts in a matched folder.

## Setting up a profile

1. Open **Settings** (`⌘,`) → **Claude Profiles** → **Add profile**.
2. Pick a name and the folders that should use it.
3. Under **Advanced**, optionally pick a **Seed from** source — defaults to `~/.claude`, or point it at `~/.claude-work` or any existing Claude home. Credentials, `settings.json`, and `projects/` history are copied over so the new profile starts with your real state instead of a blank install.

macOS stores Claude credentials in Keychain by default; seeding copies everything else, but the new profile will still prompt `/login` once — after that it sticks.

## Using a profile

Each Claude tab shows a small pill with the active profile. Click it to override for just that tab (ephemeral), or jump to **Manage profiles**.

Folders not mapped to any profile continue to use your existing `~/.claude/` — upgrading Vector never touches your default login.
