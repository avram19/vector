---
title: The vibe-coded story
description: Vector's code — Rust backend, React/TypeScript frontend, and packaging — was written entirely by an AI coding agent.
---

**This is a vibe-coded app.** A human supplied the requirements in plain English, and the implementation — Rust backend, React/TypeScript frontend, Tauri packaging, icon generation, all of it — was produced by an AI coding agent following those requirements. No line of code here was hand-written by the human who scoped the project.

If you're curious what "agentic software development" looks like end-to-end, this repository is one example: read the requirements, read the code, and judge for yourself.

## How individual features were designed

Beyond the initial build, every non-trivial feature added since — the GitHub sidebar, the PR inbox, the Actions dashboard, notifications, profile scoping, the cross-platform port — went through a written design spec before implementation. Those specs live under `docs/superpowers/specs/` in the repository, dated by when they were written, and capture the reasoning and trade-offs behind each feature rather than just the resulting code.
