# Per-Profile GitHub Repo Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each Claude Profile define a set of visible GitHub repos in Settings, and have the GitHub tab automatically filter to that set when a tab bound to that profile is focused, with a session-only "show all" escape hatch.

**Architecture:** One new `Option<Vec<String>>` field on `ClaudeProfile` (Rust) / `ClaudeProfileDto` (frontend), edited via a repo multi-select added to the existing `ProfileDialog` edit mode. `Sidebar`/`GithubPanel` compute the scoped profile from the already-available `projectRoot` + `claudeProfiles`, and `ReposView`/`PrInboxView`/`ActionsView` gain a `repoFilter: Set<string> | null` prop applied as a pure `.filter()` ahead of their existing logic.

**Tech Stack:** Rust (Tauri commands, `serde`, `config.rs`'s TOML-backed `ProfilesFile`), React/TypeScript (`App.tsx`, `src/github/*.tsx`, `src/sidebar/Sidebar.tsx`).

## Global Constraints

- No test suite in this repo (per `CLAUDE.md`) — every task's verification step is `cargo check` / `npm run tauri dev` + manual exercise of the affected flow, not automated tests.
- `#[serde(rename_all = "camelCase")]` on all Rust DTOs going to the frontend, matching every existing struct in `github/` and `ClaudeProfileDto`.
- Existing `~/.config/vector/config.toml` profile entries must keep parsing after the schema change (additive field, `#[serde(default)]`).
- Follow the spec at `docs/superpowers/specs/2026-07-05-github-profile-scoping-design.md` exactly; this plan implements it in full.

---

### Task 1: Backend — `github_repos` field on `ClaudeProfile` + `update_claude_profile` command

**Files:**
- Modify: `src-tauri/src/config.rs:20-33` (`ClaudeProfile` struct)
- Modify: `src-tauri/src/main.rs:287-311` (`ClaudeProfileDto`, `profile_to_dto`)
- Modify: `src-tauri/src/main.rs:510-531` (`update_claude_profile` command)

**Interfaces:**
- Produces: `ClaudeProfile.github_repos: Option<Vec<String>>`, `ClaudeProfileDto.github_repos: Option<Vec<String>>`, and `update_claude_profile(..., github_repos: Option<Option<Vec<String>>>)` — outer `None` = "don't touch this field", outer `Some(None)` = "clear the repo filter", outer `Some(Some(v))` = "set to `v`". Task 2 calls this command.

- [ ] **Step 1: Add the field to `ClaudeProfile`**

In `src-tauri/src/config.rs`, add to the struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeProfile {
    /// Stable id (slugified from name at creation). Directory under ~/.claude-profiles/<id>.
    pub id: String,
    /// Display name — editable.
    pub name: String,
    /// Hex color for the avatar/pill (e.g. "#7fd6b5").
    pub color: String,
    /// Project folders this profile applies to. Absolute paths; leading `~` is expanded at match time.
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub created_ms: u64,
    /// GitHub repos (owner/name) visible in the GitHub tab when this profile is
    /// the one resolved for the focused tab. `None` = unfiltered (show everything).
    #[serde(default)]
    pub github_repos: Option<Vec<String>>,
}
```

- [ ] **Step 2: `cargo check` to confirm the additive field compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: succeeds (no other code constructs `ClaudeProfile` with exhaustive field lists outside `config.rs`/`main.rs`, both updated in this task).

- [ ] **Step 3: Mirror the field on `ClaudeProfileDto` and `profile_to_dto`**

In `src-tauri/src/main.rs`:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeProfileDto {
    id: String,
    name: String,
    color: String,
    folders: Vec<String>,
    created_ms: u64,
    config_dir: String,
    signed_in_email: Option<String>,
    github_repos: Option<Vec<String>>,
}

fn profile_to_dto(p: &config::ClaudeProfile) -> ClaudeProfileDto {
    let dir = config::profile_config_dir(&p.id).unwrap_or_default();
    let email = read_profile_email(&dir);
    ClaudeProfileDto {
        id: p.id.clone(),
        name: p.name.clone(),
        color: p.color.clone(),
        folders: p.folders.clone(),
        created_ms: p.created_ms,
        config_dir: dir.to_string_lossy().to_string(),
        signed_in_email: email,
        github_repos: p.github_repos.clone(),
    }
}
```

- [ ] **Step 4: Add the double-Option param to `update_claude_profile`**

```rust
#[tauri::command]
async fn update_claude_profile(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    color: Option<String>,
    folders: Option<Vec<String>>,
    github_repos: Option<Option<Vec<String>>>,
) -> Result<ClaudeProfileDto, String> {
    let mut profiles = state.profiles.lock();
    let prof = profiles.profiles.iter_mut().find(|p| p.id == id)
        .ok_or_else(|| format!("profile not found: {id}"))?;
    if let Some(n) = name {
        let n = n.trim().to_string();
        if n.is_empty() { return Err("name is required".into()); }
        prof.name = n;
    }
    if let Some(c) = color { prof.color = c; }
    if let Some(f) = folders { prof.folders = f; }
    if let Some(gr) = github_repos { prof.github_repos = gr; }
    let dto = profile_to_dto(prof);
    config::save_profiles(&profiles).map_err(|e| e.to_string())?;
    Ok(dto)
}
```

- [ ] **Step 5: `cargo check` again**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/main.rs
git commit -m "feat(github): add per-profile github_repos field"
```

---

### Task 2: Frontend — repo multi-select in `ProfileDialog`

**Files:**
- Modify: `src/App.tsx:391-399` (`ClaudeProfileDto` TS type)
- Modify: `src/App.tsx:2534-2620` (`ProfileDialog`, edit-mode-only addition)

**Interfaces:**
- Consumes: `ClaudeProfileDto.githubRepos: string[] | null` (Task 1's Rust field, camelCased by `serde(rename_all = "camelCase")`); `invoke<Repo[]>("get_cached_github_repos")` (existing command, `Repo` shape from `src/github/ReposView.tsx:5-13`, in particular `nameWithOwner: string`); `invoke("update_claude_profile", { id, githubRepos })`.
- Produces: nothing new consumed by later tasks — this task is UI-only against Task 1's backend.

- [ ] **Step 1: Add `githubRepos` to the TS `ClaudeProfileDto` type**

In `src/App.tsx`, update:

```ts
type ClaudeProfileDto = {
  id: string;
  name: string;
  color: string;
  folders: string[];
  createdMs: number;
  configDir: string;
  signedInEmail: string | null;
  githubRepos: string[] | null;
};
```

- [ ] **Step 2: Add a `GithubReposPicker` component and wire it into `ProfileDialog` (edit mode only)**

In `src/App.tsx`, near `ProfileDialog` (after its closing brace, or directly above it — either is fine, it's a sibling function component), add:

```tsx
function GithubReposPicker({ profile, onSaved }: { profile: ClaudeProfileDto; onSaved: (next: ClaudeProfileDto) => void }) {
  const [allRepos, setAllRepos] = useState<{ nameWithOwner: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(profile.githubRepos ?? []));
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<{ nameWithOwner: string }[]>("get_cached_github_repos").then(setAllRepos).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? allRepos.filter((r) => r.nameWithOwner.toLowerCase().includes(q)) : allRepos;
  }, [allRepos, query]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const githubRepos = selected.size > 0 ? [...selected] : null;
      const dto = await invoke<ClaudeProfileDto>("update_claude_profile", { id: profile.id, githubRepos });
      onSaved(dto);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="profile-github-repos">
      <label className="field-label">GitHub repos visible for &ldquo;{profile.name}&rdquo;</label>
      <p className="field-hint">Unchecked ⇒ this profile shows every repo you have access to.</p>
      <input
        className="profile-github-search"
        placeholder="Search your repos…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
      />
      <div className="profile-github-list">
        {filtered.map((r) => (
          <label key={r.nameWithOwner} className="profile-github-row">
            <input type="checkbox" checked={selected.has(r.nameWithOwner)} onChange={() => toggle(r.nameWithOwner)} />
            <span>{r.nameWithOwner}</span>
          </label>
        ))}
        {filtered.length === 0 && <div className="field-hint">No repos match.</div>}
      </div>
      <div className="profile-github-foot">
        <span className="field-hint">{selected.size} of {allRepos.length} selected</span>
        <button type="button" className="link-btn" onClick={() => setSelected(new Set())}>Clear all</button>
      </div>
      {error && <div style={{ color: "#ff5a5a", fontSize: 12 }}>{error}</div>}
      <button type="button" className="btn-primary" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save repo visibility"}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Render it inside `ProfileDialog` when `mode === "edit"`**

In `ProfileDialog` (`src/App.tsx:2534`), find the closing of its main form (search for where the dialog renders its save/cancel buttons — the JSX return's outer container). Add, just before that closing container tag:

```tsx
{mode === "edit" && initial && (
  <GithubReposPicker
    profile={initial}
    onSaved={() => { /* re-fetch happens via onSaved(await onChanged()) at the ProfilesSection level */ onSaved(); }}
  />
)}
```

This reuses the dialog's existing `onSaved` callback (already wired to `ProfilesSection`'s `onChanged`, which re-fetches `list_claude_profiles` — see `src/App.tsx:2477`), so saving the repo list refreshes the whole profile list the same way editing name/color/folders does.

- [ ] **Step 4: Verify manually**

Run: `npm run tauri dev`
Steps: Open Settings → Claude Profiles → Edit a profile with folders bound → confirm the "GitHub repos visible for…" section appears, search filters the list, checking boxes updates the "N of M selected" count, and "Save repo visibility" persists (re-open the dialog and confirm the same repos stay checked).
Expected: repo selection round-trips through `~/.config/vector/config.toml`'s `[[profiles]]` entries (inspect the file directly to confirm `github_repos = [...]` is written).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(github): add repo visibility picker to profile edit dialog"
```

---

### Task 3: Frontend — scoped-profile resolution + header pill in `GithubPanel`

**Files:**
- Modify: `src/sidebar/Sidebar.tsx:63-81` (props), `:192-208` (`GithubPanel` render call)
- Modify: `src/App.tsx:1639-1650` (`<Sidebar>` render call)
- Modify: `src/github/GithubPanel.tsx`

**Interfaces:**
- Consumes: `resolveProfileForCwd(profiles: ClaudeProfileDto[], cwd: string): ClaudeProfileDto | null` (existing, `src/App.tsx:420`).
- Produces: `GithubPanel` gains prop `scopedProfile: ClaudeProfileDto | null` and computes `effectiveRepoFilter: Set<string> | null`, passed to `ReposView`/`PrInboxView`/`ActionsView` as a new `repoFilter` prop in Task 4.

- [ ] **Step 1: Export the `ClaudeProfileDto` type, compute `scopedProfile` in `App.tsx`, pass it to `Sidebar`**

`Sidebar.tsx` must not import a value (like `resolveProfileForCwd`) back from `App.tsx`, since `App.tsx` already imports `Sidebar` — that would be a runtime circular import. Instead, compute the resolved profile once in `App.tsx` (which already has both `claudeProfiles` and `activeLeaf` in scope) and pass the *result* down as a plain prop; `Sidebar.tsx` only needs the `ClaudeProfileDto` type, which is erased at compile time and safe to import circularly.

In `src/App.tsx`, export the type (no other change to the type itself):

```ts
export type ClaudeProfileDto = {
  id: string;
  name: string;
  color: string;
  folders: string[];
  createdMs: number;
  configDir: string;
  signedInEmail: string | null;
  githubRepos: string[] | null;
};
```

Then at the `<Sidebar>` call site (`src/App.tsx:1639`), compute and pass `scopedProfile`:

```tsx
<Sidebar
  onOpenSettings={() => { setSettingsSection("appearance"); setSettingsOpen(true); }}
  projectRoot={activeLeaf?.cwd ?? null}
  scopedProfile={resolveProfileForCwd(claudeProfiles, activeLeaf?.cwd ?? "")}
  sessionId={
```

(`resolveProfileForCwd` and `claudeProfiles` are both already in scope in this component per `src/App.tsx:420` and `:628`.)

- [ ] **Step 2: Accept and forward the prop in `Sidebar.tsx`**

In `src/sidebar/Sidebar.tsx`, add to the import (type-only, safe under circularity) and props:

```tsx
import { GithubPanel } from "../github/GithubPanel";
import type { ClaudeProfileDto } from "../App";
```

```tsx
export function Sidebar({
  onOpenSettings,
  projectRoot,
  scopedProfile,
  sessionId,
  onOpenPreview,
  activePreviewPath,
  pinnedPaths,
  pinEnabled,
  onTogglePin,
}: {
  onOpenSettings?: () => void;
  projectRoot?: string | null;
  scopedProfile: ClaudeProfileDto | null;
  sessionId?: string | null;
  onOpenPreview?: (filePath: string, line: number | undefined, col: number | undefined, opts: { pin: boolean; mode?: "file" | "diff"; baseRef?: string }) => void;
  activePreviewPath?: string | null;
  pinnedPaths: string[];
  pinEnabled: boolean;
  onTogglePin: (path: string) => void;
}) {
```

Pass it straight through to the `GithubPanel` render call (`src/sidebar/Sidebar.tsx:192-208`) — no computation needed here, `Sidebar` just forwards what `App.tsx` already resolved:

```tsx
{sidebar_active_tab === "github" && (
  <GithubPanel
    subview={state.github_subview}
    onSubview={(v) => update({ github_subview: v })}
    repoState={{
      pinned: state.github_pinned_repos,
      customGroups: state.github_custom_groups,
      repoGroup: state.github_repo_group,
      collapsed: state.github_collapsed_groups,
    }}
    onRepoUpdate={(patch) => update(patch)}
    favoritedWorkflows={state.github_favorited_workflows}
    onFavoritedWorkflows={(next) => update({ github_favorited_workflows: next })}
    onOpenPreview={onOpenPreview ?? (() => {})}
    notifications={notifications}
    scopedProfile={scopedProfile}
  />
)}
```

- [ ] **Step 3: `cargo`-equivalent frontend typecheck**

Run: `npx tsc --noEmit -p .` (or whatever the project's existing typecheck invocation is — check `package.json` scripts; if none exists, skip straight to `npm run tauri dev` in Step 6 since this repo has no standalone typecheck script)
Expected: no new type errors from the prop additions (there will likely be a temporary error in `GithubPanel.tsx` until Step 4 adds the prop — that's expected mid-task).

- [ ] **Step 4: Accept `scopedProfile` in `GithubPanel`, add local override state + header pill**

In `src/github/GithubPanel.tsx`, add the import and prop:

```tsx
import type { ClaudeProfileDto } from "../App";
```

```tsx
export function GithubPanel({
  subview,
  onSubview,
  repoState,
  onRepoUpdate,
  favoritedWorkflows,
  onFavoritedWorkflows,
  onOpenPreview,
  notifications,
  scopedProfile,
}: {
  subview: string;
  onSubview: (v: string) => void;
  repoState: GithubRepoState;
  onRepoUpdate: (patch: RepoUpdate) => void;
  favoritedWorkflows: string[];
  onFavoritedWorkflows: (next: string[]) => void;
  onOpenPreview: (path: string, line: number | undefined, col: number | undefined, opts: { pin: boolean }) => void;
  notifications: { repo: string; number: number; updatedAt: string }[];
  scopedProfile: ClaudeProfileDto | null;
}) {
```

Add local state and the derived filter, just below the existing `useState` calls:

```tsx
const [sessionShowAll, setSessionShowAll] = useState(false);

useEffect(() => { setSessionShowAll(false); }, [scopedProfile?.id]);

const effectiveRepoFilter: Set<string> | null =
  sessionShowAll || !scopedProfile?.githubRepos ? null : new Set(scopedProfile.githubRepos);
```

Add the header pill markup right after the closing `</div>` of `gh-head` (`src/github/GithubPanel.tsx:103`), before `<div className="gh-subtabs">`:

```tsx
{scopedProfile?.githubRepos && (
  <div className={`gh-scopebar${sessionShowAll ? " all" : ""}`} onClick={() => setSessionShowAll((v) => !v)}>
    <span className="gh-scopedot" style={{ background: scopedProfile.color }} />
    <span className="gh-scopetxt">
      {sessionShowAll ? "Showing all repos (session override)" : (<>Scoped to <b>{scopedProfile.name}</b> — {scopedProfile.githubRepos.length} repos</>)}
    </span>
    <button onClick={(e) => { e.stopPropagation(); setSessionShowAll((v) => !v); }}>
      {sessionShowAll ? "Re-scope" : "Show all"}
    </button>
  </div>
)}
```

- [ ] **Step 5: Add the CSS for `.gh-scopebar`**

Find the GitHub-tab stylesheet (likely `src/index.css` or a dedicated `src/github`-adjacent CSS file — grep for `.gh-subtabs` to locate it) and add, near the other `.gh-*` rules:

```css
.gh-scopebar{display:flex;align-items:center;gap:7px;padding:7px 10px;margin:8px 10px 0;border-radius:8px;
  background:rgba(58,95,138,0.14);border:1px solid rgba(122,167,224,0.3);cursor:pointer}
.gh-scopedot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.gh-scopetxt{flex:1;font-size:11.5px;color:var(--accent-fg,#7aa7e0);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gh-scopetxt b{color:var(--fg,#e1e1eb)}
.gh-scopebar button{font-size:10.5px;color:var(--muted,#aaacbe);background:var(--bg,#0c0c12);border:1px solid var(--border,rgba(128,128,140,0.18));
  border-radius:6px;padding:3px 8px;cursor:pointer;flex:0 0 auto}
.gh-scopebar.all{background:rgba(217,162,58,0.1);border-color:rgba(217,162,58,0.32)}
.gh-scopebar.all .gh-scopetxt{color:#e0b25e}
```

Adjust the `var(--accent-fg,#7aa7e0)`-style fallbacks to the project's actual custom-property names once you've located the real stylesheet — the fallback values match the mockup at `docs/superpowers/specs/assets/2026-07-05-v037-mockups.html` so the pill looks identical even if a property name differs.

- [ ] **Step 6: Verify manually**

Run: `npm run tauri dev`
Steps: With a profile that has `githubRepos` set (from Task 2) bound to the focused tab's folder, open the GitHub tab — confirm the scope pill appears with the right profile name/color/count, and clicking it toggles "Show all" / "Re-scope". Focus a tab whose folder resolves to a different (or no) profile — confirm the pill disappears (unfiltered).
Expected: pill only shows for profiles with a non-null `githubRepos`, toggle state resets per profile switch.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/sidebar/Sidebar.tsx src/github/GithubPanel.tsx src/index.css
git commit -m "feat(github): resolve scoped profile and add scope pill to GitHub tab"
```

---

### Task 4: Frontend — apply `repoFilter` in `ReposView`, `PrInboxView`, `ActionsView`

**Files:**
- Modify: `src/github/GithubPanel.tsx` (pass `repoFilter` down to the three sub-views)
- Modify: `src/github/ReposView.tsx`
- Modify: `src/github/PrInboxView.tsx`
- Modify: `src/github/ActionsView.tsx`

**Interfaces:**
- Consumes: `effectiveRepoFilter: Set<string> | null` from Task 3.
- Produces: nothing further downstream — this is the last task in this plan.

- [ ] **Step 1: Pass `repoFilter` into the three sub-view render calls in `GithubPanel.tsx`**

```tsx
{active === "repos" && (
  <ReposView
    pinned={repoState.pinned}
    customGroups={repoState.customGroups}
    repoGroup={repoState.repoGroup}
    collapsed={repoState.collapsed}
    onUpdate={onRepoUpdate}
    onOpenPrs={(repo) => { setRepoFilter(repo); onSubview("prs"); }}
    onOpenActions={(repo) => { setActionsRepo(repo); onSubview("actions"); }}
    repoFilter={effectiveRepoFilter}
  />
)}
{active === "prs" && <PrInboxView repoFilter={repoFilter} onRepoFilter={setRepoFilter} login={auth.login ?? ""} onTrigger={(t) => setTriggerTarget(t)} notifications={notifications} scopeFilter={effectiveRepoFilter} />}
{active === "actions" && (
  <ActionsView
    favorites={favoritedWorkflows}
    onFavorites={(next) => onFavoritedWorkflows(next)}
    onOpenPreview={onOpenPreview}
    repo={actionsRepo}
    onRepo={setActionsRepo}
    onTrigger={(t) => setTriggerTarget(t)}
    scopeFilter={effectiveRepoFilter}
  />
)}
```

(Note: `PrInboxView`/`ActionsView` already have an existing prop named `repoFilter`/`repo` for the *user-picked single-repo* filter dropdown — the new profile-driven filter is named `scopeFilter` on those two to avoid clashing. `ReposView` has no pre-existing `repoFilter` prop, so it can use that name directly.)

- [ ] **Step 2: Filter in `ReposView`**

In `src/github/ReposView.tsx`, add the prop and apply it in the `sections` memo:

```tsx
export function ReposView({
  pinned,
  customGroups,
  repoGroup,
  collapsed,
  onUpdate,
  onOpenPrs,
  onOpenActions,
  repoFilter,
}: {
  pinned: string[];
  customGroups: string[];
  repoGroup: Record<string, string>;
  collapsed: string[];
  onUpdate: (patch: RepoUpdate) => void;
  onOpenPrs: (repo: string) => void;
  onOpenActions: (repo: string) => void;
  repoFilter: Set<string> | null;
}) {
```

In the `sections` `useMemo` (`src/github/ReposView.tsx:115-152`), add the scope filter alongside the existing archived/search filter:

```tsx
const visible = repos.filter((r) => {
  if (repoFilter && !repoFilter.has(r.nameWithOwner)) return false;
  if (r.isArchived && !searching) return false;
  return !q || r.nameWithOwner.toLowerCase().includes(q);
});
```

And add `repoFilter` to the memo's dependency array:

```tsx
}, [repos, filter, pinnedSet, customGroups, repoGroup, repoFilter]);
```

- [ ] **Step 3: Filter in `PrInboxView`**

In `src/github/PrInboxView.tsx`, add the prop:

```tsx
export function PrInboxView({ repoFilter, onRepoFilter, login, onTrigger, notifications, scopeFilter }: {
  repoFilter: string | null;
  onRepoFilter: (r: string | null) => void;
  login: string;
  onTrigger: (target: { repo: string; presetRef?: string }) => void;
  notifications: { repo: string; number: number; updatedAt: string }[];
  scopeFilter: Set<string> | null;
}) {
```

Apply it in the `groups` memo (`src/github/PrInboxView.tsx:208-232`) — filter every PR array by `scopeFilter` before the existing `match` filtering, since a scoped-out repo's PRs shouldn't appear regardless of search text:

```tsx
const groups = useMemo(() => {
  const weekAgo = Date.now() - 7 * 86400_000;
  const inScope = (p: PullRequest) => !scopeFilter || scopeFilter.has(p.repo);
  if (repoFilter) {
    const prs = (repoPrs ?? []).filter(inScope).filter(match);
    const authored = prs.filter((p) => p.author === login);
    const teamPrs = prs.filter((p) => p.author !== login);
    return {
      action: authored.filter(needsAction),
      ready: authored.filter((p) => !needsAction(p) && readyToMerge(p)),
      waiting: authored.filter((p) => !needsAction(p) && !readyToMerge(p)),
      done: [] as PullRequest[],
      teamPrs,
    };
  }
  const authored = (mine?.authored ?? []).filter(inScope).filter(match);
  const done = (mine?.recentlyClosed ?? []).filter(inScope).filter((p) => match(p) && new Date(p.updatedAt).getTime() >= weekAgo);
  return {
    action: authored.filter(needsAction),
    ready: authored.filter((p) => !needsAction(p) && readyToMerge(p)),
    waiting: authored.filter((p) => !needsAction(p) && !readyToMerge(p)),
    done,
    teamPrs: (team ?? []).filter(inScope).filter(match),
  };
}, [repoFilter, repoPrs, mine, team, match, login, scopeFilter]);
```

Also filter `repoOptions` (`src/github/PrInboxView.tsx:189-196`) so the manual repo-filter dropdown itself only offers in-scope repos:

```tsx
const repoOptions = useMemo(() => {
  const set = new Set<string>(allRepos);
  (mine?.authored ?? []).forEach((p) => set.add(p.repo));
  (mine?.recentlyClosed ?? []).forEach((p) => set.add(p.repo));
  (team ?? []).forEach((p) => set.add(p.repo));
  if (repoFilter) set.add(repoFilter);
  const all = [...set].sort();
  return scopeFilter ? all.filter((r) => scopeFilter.has(r)) : all;
}, [allRepos, mine, team, repoFilter, scopeFilter]);
```

- [ ] **Step 4: Filter in `ActionsView`**

In `src/github/ActionsView.tsx`, add the prop:

```tsx
export function ActionsView({ favorites, onFavorites, onOpenPreview, repo, onRepo, onTrigger, scopeFilter }: {
  favorites: string[];
  onFavorites: (next: string[]) => void;
  onOpenPreview: (path: string, line: number | undefined, col: number | undefined, opts: { pin: boolean }) => void;
  repo: string | null;
  onRepo: (r: string | null) => void;
  onTrigger: (target: { repo: string; presetWorkflowId?: number }) => void;
  scopeFilter: Set<string> | null;
}) {
```

Filter `repoOptions` (`src/github/ActionsView.tsx:142`):

```tsx
const repoOptions = useMemo(() => {
  const all = [...allRepos].sort();
  return scopeFilter ? all.filter((r) => scopeFilter.has(r)) : all;
}, [allRepos, scopeFilter]);
```

And filter the favorited-workflows dashboard (`src/github/ActionsView.tsx:53-56`) so out-of-scope favorites don't show runs:

```tsx
const loadFavRuns = useCallback(() => {
  const inScope = scopeFilter ? favorites.filter((f) => scopeFilter.has(f.split(":")[0])) : favorites;
  if (inScope.length === 0) { setFavRuns([]); return; }
  invoke<Run[]>("list_github_favorite_runs", { favorites: inScope }).then(setFavRuns).catch((e) => setError(String(e)));
}, [favorites, scopeFilter]);
```

(`favKey` format is `` `${repo}:${workflowFileBasename}` `` per `src/github/ActionsView.tsx:34`, so `f.split(":")[0]` recovers the repo.)

- [ ] **Step 5: Verify manually**

Run: `npm run tauri dev`
Steps: With a scoped profile focused (from Task 3's verification), open Repos — confirm only the selected repos' groups show non-empty (others still show as empty groups or are absent, per `ReposView`'s existing per-group rendering); open PRs — confirm only PRs from those repos appear in both My PRs and Team PRs, and the repo-filter dropdown only offers those repos; open Actions — confirm the repo dropdown is scoped and any favorited workflow outside the scope doesn't show a run row. Toggle "Show all" in the header pill and confirm all three views immediately show everything again.
Expected: all three sub-views respect the filter; toggling the pill flips them all at once (they all read the same `effectiveRepoFilter` from `GithubPanel`).

- [ ] **Step 6: Commit**

```bash
git add src/github/GithubPanel.tsx src/github/ReposView.tsx src/github/PrInboxView.tsx src/github/ActionsView.tsx
git commit -m "feat(github): apply profile-scoped repo filter across Repos/PRs/Actions"
```
