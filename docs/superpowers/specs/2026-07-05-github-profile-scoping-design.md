# Per-Profile GitHub Repo Visibility — Design Spec (v0.3.7)

**Status:** Approved design, pre-implementation
**Date:** 2026-07-05
**Target release:** v0.3.7

---

## 1. Summary

Today the GitHub tab is intentionally account-global (see `2026-06-24-github-sidebar-design.md`): it shows every repo/PR/action the user's `gh` login can see, regardless of which project tab is focused. This spec adds an opt-in narrowing layer: each **Claude Profile** (`ClaudeProfileDto`, Settings → Claude Profiles) can be configured with a specific set of visible GitHub repos. When the focused tab's project folder resolves to a profile with a configured repo set, the GitHub tab's three sub-views (Repos, PR inbox, Actions) automatically filter down to just those repos. Unconfigured profiles (or no profile) behave exactly as today — unfiltered.

This does not change the account-global architecture or auth model from the v0.3.5 design. It adds a filter on top of the same cached repo/PR/action data that already flows through the frontend.

### In scope

1. Settings → Claude Profiles: editing a profile shows a searchable multi-select of the user's GitHub repos; checked repos become that profile's `githubRepos`.
2. `GithubPanel` resolves the focused tab's profile the same way the existing profile pill does (`resolveProfileForCwd`), and filters Repos / PR inbox / Actions to the profile's `githubRepos` when set.
3. A "scoped to `<profile name>`" pill in the `GithubPanel` header that toggles a session-only, non-persisted "show all repos" override.
4. Unconfigured profile, or no profile resolved for the focused tab's cwd → unfiltered (today's behavior).

### Out of scope / deferred

- Auto-detecting repos from git remotes (rejected — manual multi-select only, per user decision).
- Per-folder (rather than per-profile) scoping — profiles are the unit of configuration since they already group folders.
- Any change to GitHub auth, caching, or the polling/notifications architecture.

---

## 2. Data model

### Backend — `src-tauri/src/config.rs`

Add one field to `ClaudeProfile`:

```rust
pub struct ClaudeProfile {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub created_ms: u64,
    /// GitHub repos (owner/name) visible in the GitHub tab when this profile
    /// is active. `None`/absent = unfiltered (show everything).
    #[serde(default)]
    pub github_repos: Option<Vec<String>>,
}
```

`#[serde(default)]` on an `Option<Vec<String>>` deserializes missing TOML keys as `None`, so existing `~/.config/vector/config.toml` profile entries stay valid untouched.

### `ClaudeProfileDto` (`main.rs`) and TS type

Mirror the field (`github_repos` → `githubRepos` via existing `rename_all = "camelCase"`):

```rust
struct ClaudeProfileDto {
    // ...existing fields...
    github_repos: Option<Vec<String>>,
}
```

```ts
type ClaudeProfileDto = {
  // ...existing fields...
  githubRepos: string[] | null;
};
```

### `update_claude_profile` command

Add a new optional param:

```rust
async fn update_claude_profile(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    color: Option<String>,
    folders: Option<Vec<String>>,
    github_repos: Option<Option<Vec<String>>>, // outer Some = "set this field"; inner None = clear it
) -> Result<ClaudeProfileDto, String>
```

The double-Option distinguishes "don't touch this field" (outer `None`, matches the existing pattern for `name`/`color`/`folders`) from "clear the repo filter" (outer `Some(None)`). The frontend always passes the outer `Some(...)` when saving from the repo-picker UI.

No new persistence file — this rides on the existing `ProfilesFile` / `save_profiles` round-trip in `config.rs`.

---

## 3. Settings UI

`ProfilesSection` / `ProfileRow` in `App.tsx` (~line 2434) gains a new expandable "GitHub repos" row per profile, reusing the same repo-fetch path `ReposView` already uses (`get_cached_github_repos`) and a multi-select list component (checkbox list with search, similar interaction to `RepoFilterDropdown` but multi-select instead of single-pick). Selecting/deselecting calls `update_claude_profile` with the new full `githubRepos` array; clearing all checkboxes calls it with `Some(None)` to fully unset (revert to unfiltered).

No new Tauri commands needed — this is a UI addition over `list_claude_profiles` (read) and `update_claude_profile` (write), both of which already exist.

---

## 4. Runtime scoping in the GitHub tab

`GithubPanel` (currently rendered from `App.tsx` with `projectRoot`-style props already piped down for Files/Worktrees tabs) gains:

- A resolved `scopedProfile: ClaudeProfileDto | null`, computed in `App.tsx` via the existing `resolveProfileForCwd(claudeProfiles, activeLeaf?.cwd ?? "")` and passed down alongside the other GH panel props.
- A local `sessionShowAll: boolean` state (not persisted) inside `GithubPanel`, toggled by the header pill.
- An `effectiveRepoFilter: Set<string> | null` = `sessionShowAll || !scopedProfile?.githubRepos ? null : new Set(scopedProfile.githubRepos)`.

Each sub-view (`ReposView`, `PrInboxView`, `ActionsView`) already receives its repo list via `get_cached_github_repos` and does client-side filtering/grouping. They gain an `repoFilter: Set<string> | null` prop; when non-null, the fetched repo list (and therefore anything derived from it — PR search inputs, Actions dashboard repos) is filtered to `r => repoFilter.has(r.nameWithOwner)` before existing logic runs. This is a pure additional `.filter()` step ahead of each view's current pipeline — no changes to `gh` queries, caching, or the notification poller.

### Header pill

Rendered in `GithubPanel`'s header row only when `scopedProfile?.githubRepos` is non-null:
- Scoped state: `"Scoped to {profile.name}"` with the profile's color as an accent, click → `sessionShowAll = true`.
- Overridden state: `"All repos (click to re-scope)"`, click → `sessionShowAll = false`.
- Switching focused tabs (and therefore `scopedProfile`) resets `sessionShowAll` to `false` — the override is per-focus-session, not sticky across profile switches.

---

## 5. Edge cases

- **Profile has `githubRepos: []` (all deselected in UI)**: treated as "explicitly show nothing," distinct from `null` ("unfiltered"). The repo-picker UI should make this state visually clear (e.g., an inline note) since it's an unusual thing to configure deliberately, but the spec allows it since it's a legitimate profile config.
- **Repo in `githubRepos` no longer accessible to the `gh` login** (removed from org, etc.): silently drops out of `get_cached_github_repos`'s result; no error state needed, filter just yields fewer rows.
- **No profile resolves for the focused tab's cwd**: `scopedProfile` is `null`, `effectiveRepoFilter` is `null`, fully unfiltered — matches today.

---

## 6. Testing

No test suite in this repo (per `CLAUDE.md`). Verification plan for the implementation phase: run `npm run tauri dev`, configure a profile's `githubRepos` to a subset, focus a tab bound to that profile's folder, confirm Repos/PR inbox/Actions all narrow to that set, confirm the header pill toggle restores the full list for the session, then switch to a tab under a different/no profile and confirm it's unfiltered.
