---
title: GitHub — repos, PRs & actions
description: The GitHub sidebar tab — Repos, the PR inbox, Actions, and the notifications badge.
---

A third sidebar tab that turns Vector into a GitHub cockpit, authenticated through your existing `gh` CLI login — no tokens stored, it inherits your exact scopes and org SSO. Three sub-tabs:

## Repos

Every repo you can see, auto-grouped by org with your own custom groups, a Favorites section, pin/drag-to-group/right-click actions, and search. Archived repos are hidden until you search.

Renders instantly from an on-disk cache, then refreshes in the background. Click a repo's PR-count badge to jump to its pull requests; right-click for **Open Actions**.

If the focused tab's project is scoped to a [Claude profile](/vector/guide/profiles/) with a repo allowlist configured, the Repos tab scopes to just that profile's repos, with a banner to toggle back to showing everything.

## Pull requests

An account-wide inbox split into:

- **My Pull Requests** — Needs Action / Ready to Merge / Waiting / Done.
- **Team Pull Requests** — review-requested.

Each PR shows CI/review/conflict/merged/closed badges, plus a searchable repo filter, search by title or number, "View more" paging, and an unread-activity dot. A **Deploy** button on any PR opens the workflow trigger prefilled with that PR's branch.

## Actions

A favorited-workflows dashboard across repos, plus per-repo drill-down (workflows → runs → jobs).

- Open a finished job's logs in the preview pane.
- **Re-run**, **re-run failed**, or **cancel** a run.
- **Trigger** a `workflow_dispatch` with a typed input form — boolean inputs collapse into one searchable multi-select.

## Notifications badge

The GitHub rail icon shows a badge for unread activity on PRs you authored or were asked to review (in-app only — no system notifications); it clears when you open the tab.

Groups, pins, favorited workflows, and seen-state persist in `~/.config/vector/ui.toml`.
