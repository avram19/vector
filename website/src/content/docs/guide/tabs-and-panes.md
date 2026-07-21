---
title: Tabs & panes
description: Agent-native tabs, the project/agent picker, pane splits, and dragging panes between tabs.
---

Every tab in Vector starts inside a coding agent, not a shell prompt.

## New tab

`⌘T` opens the project picker: pick a folder (it remembers recents), then pick an agent — or **shell** for a plain terminal. Vector scans your `PATH` and only offers agents it actually finds installed.

If the folder you picked is scoped to a [Claude profile](/vector/guide/profiles/), the new tab starts already signed in to that profile's account.

## Pane splits

Split a tab into a grid of agent panes with `⌘D` (split right) or `⌘⇧D` (split down). Each pane runs its own agent, independently — drag the divider between two panes to resize them.

Panes aren't fixed to their tab: drag a pane's tab strip onto another tab to merge it into that tab's split, or drop it on the tab bar to pop it out into a new tab.

## Per-tab agent swap

Change the agent for the focused pane from the topbar dropdown at any time; the session restarts cleanly in the new agent.

## Switching tabs

`⌘1`…`⌘9` jumps to a specific tab; `⌃⇥` / `⌃⇧⇥` cycles to the next/previous tab. See [Shortcuts](/vector/guide/shortcuts/) for the full list, including Linux/Windows bindings.
