---
title: Sidebar — files & worktrees
description: The collapsible sidebar's Files and Worktrees tabs.
---

A collapsible sidebar with tabs scoped to the focused tab's project.

## Files

A VSCode-style tree of the project root with a hidden-files toggle.

- Click a file to open a [preview](/vector/guide/previewer/); ⌘⇧-click to pin a second preview.
- Right-click for **Reveal in Finder**, **Open in default app**, **Open in installed editor** (VS Code / Cursor / Zed / Windsurf / WebStorm / IntelliJ / PyCharm / Sublime), or **Copy path**.
- The tree refreshes live as the agent writes files.

## Worktrees

Every git repo discovered under the project, grouped by repo. Each worktree expands to show **Uncommitted** and **Committed (vs base)** changes.

- Click a change to open a unified diff with syntax highlighting in the preview pane.
- Toggle between flat and tree views from the search bar — both persist across restarts.
- Right-click a worktree for Reveal / Open / Open in editor.

Sidebar width, active tab, collapsed state, hidden-files toggle, and worktrees view mode all persist via `~/.config/vector/ui.toml`.
