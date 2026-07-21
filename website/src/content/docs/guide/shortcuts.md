---
title: Shortcuts
description: Keyboard shortcuts, including the Linux/Windows Ctrl+Shift mapping.
---

## macOS

| Shortcut | Action |
| --- | --- |
| `⌘T` | New tab (opens project picker) |
| `⌘W` | Close active pane |
| `⌘D` / `⌘⇧D` | Split pane right / down |
| `⌘⌥←` `⌘⌥→` `⌘⌥↑` `⌘⌥↓` | Focus adjacent pane |
| `⌘⇧R` | Reload (restart) active agent |
| `⌘1`…`⌘9` | Switch tab |
| `⌃⇥` / `⌃⇧⇥` | Next / previous tab |
| `⌘,` | Open Settings |
| `⇧↵` | Multi-line input (Claude Code) |
| `⌘←` / `⌘→` | Cursor to line start / end (while typing) |
| `⌥←` / `⌥→` | Cursor back / forward one word |
| `⌘⌫` / `⌥⌫` | Delete to line start / word start |

## Linux / Windows

App-action shortcuts use **Ctrl+Shift** instead of ⌘, because plain Ctrl belongs to the terminal (Ctrl+C/D/U reach the shell):

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+T` | New tab (opens project picker) |
| `Ctrl+Shift+W` | Close active pane |
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | Split pane right / down |
| `Ctrl+Shift+R` | Reload (restart) active agent |
| `Ctrl+,` | Open Settings (no Shift needed) |
| `Ctrl+= / Ctrl+− / Ctrl+0` | Zoom in / out / reset (no Shift needed) |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Terminal copy / paste |

The `⌘←/→/⌫` and `⌥←/→/⌫` readline-style shims are macOS-only — Linux and Windows already get native Ctrl/Alt readline behavior in the terminal, so those bindings aren't remapped there.
