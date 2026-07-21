---
title: Resume Claude sessions
description: Jump back into a previous Claude Code conversation instead of starting fresh.
---

When you open a new tab and pick a project folder, Vector surfaces that folder's Claude Code session history in the project picker — so you can resume a previous conversation instead of starting a new one.

Under the hood, picking a session appends `--resume <id>` to the `claude` launch command; picking "continue most recent" appends `--continue` instead. Both are handled entirely by Claude Code's own CLI flags — Vector just indexes your session files (`~/.claude/projects/*/*.jsonl`) to build the picker and passes the right flag through.

## Claude-only, for now

Session resume is currently only available for Claude Code. Vector exposes a single source of truth for this — the list of agents that support resume — and today that list contains only `claude`. Other agents (Codex, Cursor Agent, etc.) don't have an equivalent session-index/resume mechanism wired up yet, so their tabs always start fresh.
