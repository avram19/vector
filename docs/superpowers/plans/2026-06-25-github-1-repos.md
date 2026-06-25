# GitHub Sidebar — Plan 1: Repos View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Repos — coming in Plan 1" placeholder with a live, grouped repository tree: GitHub-org auto-groups, user-defined custom groups, a Favorites (pinned) section, drag-to-group, a context menu, search, and persisted layout — fed by `gh api graphql`.

**Architecture:** A new `github/repos.rs` fetches the viewer's repositories via paginated GraphQL through the existing `client::run_gh` choke point; a `list_github_repos` command (in `github/mod.rs`) caches the result in the existing `GithubState` TTL cache. The user's organizational layer (custom groups, repo→group map, pins, collapse) persists in `ui.toml` via the existing `update_sidebar_config` command. The frontend `ReposView` builds the tree and is mounted into `GithubPanel`'s `repos` sub-body.

**Tech Stack:** Rust (`serde_json::Value`, `tauri::async_runtime::spawn_blocking`, `parking_lot::Mutex`), React 18 + TypeScript, HTML5 drag-and-drop, the existing `FileContextMenu` and `open_path` command. No new dependencies.

## Global Constraints

- **No test suite.** The test cycle is `cargo check --manifest-path src-tauri/Cargo.toml` (backend) and `npx tsc --noEmit` (frontend), then manual verification in `npm run tauri dev`. Never claim a task passes without running these.
- **Builds on Plan 0 (already merged into this branch).** Available: `github::client::run_gh(&[&str]) -> Result<String,String>`, `github::CachedResponse { etag: Option<String>, body: String, fetched_at: std::time::Instant }`, `github::GithubState { cache: parking_lot::Mutex<HashMap<String, CachedResponse>> }`, the `AppState.github` field, and `GithubPanel`'s `active === "repos"` sub-body slot (`src/github/GithubPanel.tsx:81`).
- **Data layer:** `gh api graphql` only, via `client::run_gh`. No `reqwest`, no Octokit, no token handling. No new cargo/npm deps (`serde_json = "1"` already direct).
- **Persistence:** the user's taxonomy (groups/pins/collapse) lives in `~/.config/vector/ui.toml`; GitHub content is never written to disk (in-memory `GithubState` cache only). New `UiConfig` fields use `#[serde(default)]` so older configs still load.
- **Visual source of truth:** `docs/superpowers/specs/assets/2026-06-24-github-sidebar-mockup.html` (Repos sub-tab) — Favorites (★) → custom groups (labelled `custom group`) → org groups (labelled `org · N repos`); rows show private/public glyph, `owner/`-muted name, open-PR pill, last-push relative time, pin star.
- **Pinned repos appear only in Favorites** (not duplicated under their group); precedence per repo: pinned → Favorites; else custom group → that group; else org group.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Branch:** `feat/github-sidebar`.

---

### Task 1: Backend — fetch repositories via GraphQL

**Files:**
- Create: `src-tauri/src/github/repos.rs`
- Modify: `src-tauri/src/github/mod.rs` (add `pub mod repos;`, the `list_github_repos` command)
- Modify: `src-tauri/src/main.rs` (register `github::list_github_repos` in `generate_handler!`)

**Interfaces:**
- Produces:
  - `github::repos::Repo { name_with_owner, owner, is_private, pushed_at: Option<String>, default_branch: Option<String>, open_pr_count: u32 }` — serializes camelCase: `nameWithOwner`, `owner`, `isPrivate`, `pushedAt`, `defaultBranch`, `openPrCount`. Derives `Serialize, Deserialize, Clone`.
  - `github::repos::list_repos() -> Result<Vec<Repo>, String>` (blocking; paginates).
  - `github::list_github_repos(state, force: bool) -> Result<Vec<Repo>, String>` (Tauri command; 60s TTL cache).

- [ ] **Step 1: Create `src-tauri/src/github/repos.rs`**

```rust
use serde::{Deserialize, Serialize};

use super::client;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub name_with_owner: String,
    pub owner: String,
    pub is_private: bool,
    pub pushed_at: Option<String>,
    pub default_branch: Option<String>,
    pub open_pr_count: u32,
}

const QUERY: &str = r#"query($endCursor: String) {
  viewer {
    repositories(first: 100, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: PUSHED_AT, direction: DESC}, after: $endCursor) {
      nodes {
        nameWithOwner
        isPrivate
        pushedAt
        owner { login }
        defaultBranchRef { name }
        pullRequests(states: OPEN) { totalCount }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}"#;

/// Fetch every repository the viewer can see (owner / collaborator / org member),
/// newest-push first, following GraphQL cursor pagination. Blocking.
pub fn list_repos() -> Result<Vec<Repo>, String> {
    let mut out: Vec<Repo> = Vec::new();
    let mut cursor: Option<String> = None;

    loop {
        let query_arg = format!("query={QUERY}");
        let mut args: Vec<String> = vec![
            "api".into(),
            "graphql".into(),
            "-f".into(),
            query_arg,
        ];
        if let Some(c) = &cursor {
            args.push("-f".into());
            args.push(format!("endCursor={c}"));
        }
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let raw = client::run_gh(&arg_refs)?;

        let v: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("bad gh JSON: {e}"))?;
        let conn = &v["data"]["viewer"]["repositories"];

        if let Some(nodes) = conn["nodes"].as_array() {
            for n in nodes {
                out.push(Repo {
                    name_with_owner: n["nameWithOwner"].as_str().unwrap_or_default().to_string(),
                    owner: n["owner"]["login"].as_str().unwrap_or_default().to_string(),
                    is_private: n["isPrivate"].as_bool().unwrap_or(false),
                    pushed_at: n["pushedAt"].as_str().map(|s| s.to_string()),
                    default_branch: n["defaultBranchRef"]["name"].as_str().map(|s| s.to_string()),
                    open_pr_count: n["pullRequests"]["totalCount"].as_u64().unwrap_or(0) as u32,
                });
            }
        }

        if conn["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false) {
            match conn["pageInfo"]["endCursor"].as_str() {
                Some(c) => cursor = Some(c.to_string()),
                None => break,
            }
        } else {
            break;
        }
    }

    Ok(out)
}
```

- [ ] **Step 2: Add the module + command to `src-tauri/src/github/mod.rs`**

Add `pub mod repos;` under the existing `pub mod client;`:

```rust
pub mod client;
pub mod repos;
```

Then add this command after `gh_auth_status`:

```rust
#[tauri::command]
pub async fn list_github_repos(
    state: State<'_, AppState>,
    force: bool,
) -> Result<Vec<repos::Repo>, String> {
    const TTL: std::time::Duration = std::time::Duration::from_secs(60);

    if !force {
        let cached = {
            let cache = state.github.cache.lock();
            cache.get("repos").and_then(|c| {
                if c.fetched_at.elapsed() < TTL {
                    serde_json::from_str::<Vec<repos::Repo>>(&c.body).ok()
                } else {
                    None
                }
            })
        };
        if let Some(hit) = cached {
            return Ok(hit);
        }
    }

    let fresh = tauri::async_runtime::spawn_blocking(repos::list_repos)
        .await
        .map_err(|e| e.to_string())??;

    if let Ok(body) = serde_json::to_string(&fresh) {
        state.github.cache.lock().insert(
            "repos".to_string(),
            CachedResponse { etag: None, body, fetched_at: std::time::Instant::now() },
        );
    }

    Ok(fresh)
}
```

- [ ] **Step 3: Register the command in `src-tauri/src/main.rs`**

In `tauri::generate_handler![ … ]`, after `github::gh_auth_status,`:

```rust
            github::gh_auth_status,
            github::list_github_repos,
        ])
```

- [ ] **Step 4: Verify backend compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: `Finished`, no errors. (Pre-existing scaffold warnings remain acceptable; the `etag`/`CachedResponse` fields are now read by this code so some may clear.)

- [ ] **Step 5: Smoke-test the fetch against real gh** (you are `gh`-authed):

Run: `cd src-tauri && cargo run --quiet 2>/dev/null &` is NOT needed. Instead verify the GraphQL shape directly with gh:
`gh api graphql -f query='query{viewer{repositories(first:1,affiliations:[OWNER]){nodes{nameWithOwner isPrivate pushedAt owner{login} defaultBranchRef{name} pullRequests(states:OPEN){totalCount}}}}}'`
Expected: a JSON object with `data.viewer.repositories.nodes[0].nameWithOwner` present. This confirms the query fields are valid before wiring the UI.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/github/repos.rs src-tauri/src/github/mod.rs src-tauri/src/main.rs
git commit -m "feat(github): fetch repositories via gh GraphQL (paginated, cached)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Backend — persist groups, pins, collapse

**Files:**
- Modify: `src-tauri/src/config.rs` (`struct UiConfig`, `Default for UiConfig`, imports)
- Modify: `src-tauri/src/main.rs` (`struct SidebarConfigPatch`, `update_sidebar_config`)

**Interfaces:**
- Produces four new persisted `UiConfig` fields (all `#[serde(default)]`), settable via `update_sidebar_config`:
  - `github_custom_groups: Vec<String>` (ordered group names)
  - `github_repo_group: std::collections::BTreeMap<String, String>` (repo `nameWithOwner` → group name)
  - `github_pinned_repos: Vec<String>`
  - `github_collapsed_groups: Vec<String>` (collapsed section keys)

- [ ] **Step 1: Add the fields to `UiConfig` in `config.rs`**

`config.rs` already imports `std::collections::BTreeMap` (line 2). Add to `struct UiConfig`, after `github_subview`:

```rust
    #[serde(default = "default_github_subview")]
    pub github_subview: String,
    #[serde(default)]
    pub github_custom_groups: Vec<String>,
    #[serde(default)]
    pub github_repo_group: BTreeMap<String, String>,
    #[serde(default)]
    pub github_pinned_repos: Vec<String>,
    #[serde(default)]
    pub github_collapsed_groups: Vec<String>,
```

- [ ] **Step 2: Add them to the `Default` impl**

After `github_subview: default_github_subview(),`:

```rust
            github_subview: default_github_subview(),
            github_custom_groups: Vec::new(),
            github_repo_group: BTreeMap::new(),
            github_pinned_repos: Vec::new(),
            github_collapsed_groups: Vec::new(),
        }
```

- [ ] **Step 3: Extend `SidebarConfigPatch` in `main.rs`**

After `github_subview: Option<String>,`:

```rust
    github_subview: Option<String>,
    github_custom_groups: Option<Vec<String>>,
    github_repo_group: Option<std::collections::BTreeMap<String, String>>,
    github_pinned_repos: Option<Vec<String>>,
    github_collapsed_groups: Option<Vec<String>>,
}
```

- [ ] **Step 4: Apply them in `update_sidebar_config`**

Before the `config::save_ui_config(&cfg)` line, after the `github_subview` apply:

```rust
    if let Some(v) = patch.github_subview { cfg.github_subview = v; }
    if let Some(v) = patch.github_custom_groups { cfg.github_custom_groups = v; }
    if let Some(v) = patch.github_repo_group { cfg.github_repo_group = v; }
    if let Some(v) = patch.github_pinned_repos { cfg.github_pinned_repos = v; }
    if let Some(v) = patch.github_collapsed_groups { cfg.github_collapsed_groups = v; }
    config::save_ui_config(&cfg).map_err(|e| e.to_string())
```

- [ ] **Step 5: Verify backend compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3`
Expected: `Finished`, no errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/main.rs
git commit -m "feat(github): persist repo groups, pins, and collapse state

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — mirror the new persisted state

**Files:**
- Modify: `src/sidebar/sidebarState.ts` (`SidebarState` type, `DEFAULT`)

**Interfaces:**
- Produces on `SidebarState`: `github_custom_groups: string[]`, `github_repo_group: Record<string, string>`, `github_pinned_repos: string[]`, `github_collapsed_groups: string[]`.

- [ ] **Step 1: Extend the `SidebarState` type**

After `github_subview: string;`:

```ts
  github_subview: string;
  github_custom_groups: string[];
  github_repo_group: Record<string, string>;
  github_pinned_repos: string[];
  github_collapsed_groups: string[];
};
```

- [ ] **Step 2: Extend `DEFAULT`**

After `github_subview: "repos",`:

```ts
  github_subview: "repos",
  github_custom_groups: [],
  github_repo_group: {},
  github_pinned_repos: [],
  github_collapsed_groups: [],
};
```

- [ ] **Step 3: Verify types**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/sidebar/sidebarState.ts
git commit -m "feat(github): mirror repo group/pin/collapse state in frontend

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — ReposView tree (read-only: groups, rows, collapse, search)

**Files:**
- Create: `src/github/ReposView.tsx`
- Modify: `src/index.css` (append repo-tree styles)

**Interfaces:**
- Consumes: `invoke<Repo[]>("list_github_repos", { force })`; props `pinned: string[]`, `customGroups: string[]`, `repoGroup: Record<string,string>`, `collapsed: string[]`, and `onUpdate(patch)` where patch keys are the `github_*` `ui.toml` fields.
- Produces: `ReposView` component; `type Repo = { nameWithOwner; owner; isPrivate; pushedAt: string|null; defaultBranch: string|null; openPrCount: number }`.

This task ships a working read-only tree. Pin toggling, group creation, drag, and the context menu are Task 5 — but the row already renders a (non-interactive in this task) star and accepts the props it will need.

- [ ] **Step 1: Create `src/github/ReposView.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type Repo = {
  nameWithOwner: string;
  owner: string;
  isPrivate: boolean;
  pushedAt: string | null;
  defaultBranch: string | null;
  openPrCount: number;
};

export type RepoUpdate = {
  github_custom_groups?: string[];
  github_repo_group?: Record<string, string>;
  github_pinned_repos?: string[];
  github_collapsed_groups?: string[];
};

type Section = { key: string; label: string; tag?: string; star?: boolean; repos: Repo[] };

function relTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24; if (d < 7) return `${Math.floor(d)}d`;
  const w = d / 7; if (w < 5) return `${Math.floor(w)}w`;
  return `${Math.floor(d / 30)}mo`;
}

export function ReposView({
  pinned,
  customGroups,
  repoGroup,
  collapsed,
  onUpdate,
}: {
  pinned: string[];
  customGroups: string[];
  repoGroup: Record<string, string>;
  collapsed: string[];
  onUpdate: (patch: RepoUpdate) => void;
}) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback((force: boolean) => {
    setLoading(true);
    setError(null);
    invoke<Repo[]>("list_github_repos", { force })
      .then((r) => setRepos(r))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(false); }, [load]);

  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const collapsedSet = useMemo(() => new Set(collapsed), [collapsed]);

  const sections: Section[] = useMemo(() => {
    if (!repos) return [];
    const q = filter.trim().toLowerCase();
    const match = (r: Repo) => !q || r.nameWithOwner.toLowerCase().includes(q);
    const visible = repos.filter(match);

    const favorites = visible.filter((r) => pinnedSet.has(r.nameWithOwner));
    const custom = new Map<string, Repo[]>();
    customGroups.forEach((g) => custom.set(g, []));
    const orgs = new Map<string, Repo[]>();

    for (const r of visible) {
      if (pinnedSet.has(r.nameWithOwner)) continue;
      const g = repoGroup[r.nameWithOwner];
      if (g && custom.has(g)) {
        custom.get(g)!.push(r);
      } else {
        if (!orgs.has(r.owner)) orgs.set(r.owner, []);
        orgs.get(r.owner)!.push(r);
      }
    }

    const out: Section[] = [];
    if (favorites.length) out.push({ key: "fav", label: "Favorites", star: true, repos: favorites });
    for (const g of customGroups) {
      out.push({ key: `custom:${g}`, label: g, tag: "custom group", repos: custom.get(g) ?? [] });
    }
    for (const owner of [...orgs.keys()].sort()) {
      const list = orgs.get(owner)!;
      out.push({ key: `org:${owner}`, label: owner, tag: `org · ${list.length} repos`, repos: list });
    }
    return out;
  }, [repos, filter, pinnedSet, customGroups, repoGroup]);

  const toggleCollapse = (key: string) => {
    const next = collapsedSet.has(key)
      ? collapsed.filter((k) => k !== key)
      : [...collapsed, key];
    onUpdate({ github_collapsed_groups: next });
  };

  if (error) {
    return (
      <div className="gh-empty">
        <p><b>Couldn't load repositories</b></p>
        <p className="gh-muted">{error}</p>
        <button className="gh-retry" onClick={() => load(true)}>Retry</button>
      </div>
    );
  }
  if (!repos && loading) return <div className="gh-empty">Loading repositories…</div>;
  if (!repos) return <div className="gh-empty">No repositories.</div>;

  return (
    <div className="gh-repos">
      <div className="gh-search">
        <span>⌕</span>
        <input
          placeholder="Filter repos…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="gh-icobtn" title="Refresh" onClick={() => load(true)}>⟳</button>
      </div>
      <div className="gh-tree">
        {sections.map((sec) => {
          const isCollapsed = collapsedSet.has(sec.key);
          return (
            <div className="gh-grp" key={sec.key}>
              <div className="gh-grp-h" onClick={() => toggleCollapse(sec.key)}>
                <span className="gh-caret">{isCollapsed ? "▸" : "▾"}</span>
                {sec.star && <span className="gh-star">★</span>}
                <span className="gh-grp-label">{sec.label}</span>
                {sec.tag && <span className="gh-grp-tag">{sec.tag}</span>}
              </div>
              {!isCollapsed && sec.repos.map((r) => (
                <div className="gh-repo-row" key={r.nameWithOwner}>
                  <span className="gh-glyph">{r.isPrivate ? "🔒" : "○"}</span>
                  <span className="gh-repo-name">
                    <span className="gh-own">{r.owner}/</span>
                    {r.nameWithOwner.slice(r.owner.length + 1)}
                  </span>
                  <span className="gh-repo-meta">
                    {pinnedSet.has(r.nameWithOwner) && <span className="gh-pin">★</span>}
                    {r.openPrCount > 0 && <span className="gh-pill">{r.openPrCount} PR{r.openPrCount > 1 ? "s" : ""}</span>}
                    <span className="gh-time">{relTime(r.pushedAt)}</span>
                  </span>
                </div>
              ))}
              {!isCollapsed && sec.repos.length === 0 && (
                <div className="gh-grp-empty">No repos</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append styles to `src/index.css`** (after the Plan 0 GitHub block)

```css
/* ── GitHub repos tree ────────────────────────────────────── */
.gh-repos { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.gh-search { display: flex; align-items: center; gap: 6px; margin: 8px 10px 4px; padding: 5px 8px; background: rgba(0,0,0,0.25); border: 1px solid var(--border, rgba(128,128,128,0.18)); border-radius: 7px; color: rgba(170,172,190,0.6); }
.gh-search input { flex: 1; border: 0; background: transparent; color: var(--fg, #e1e1eb); outline: 0; font-size: 12px; }
.gh-tree { flex: 1; overflow: auto; min-height: 0; padding: 2px 6px 12px; }
.gh-grp { margin-top: 4px; }
.gh-grp-h { display: flex; align-items: center; gap: 6px; padding: 4px 6px; color: rgba(170,172,190,0.7); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer; user-select: none; }
.gh-grp-h:hover { color: var(--fg, #e1e1eb); }
.gh-caret { color: rgba(170,172,190,0.45); width: 10px; }
.gh-star { color: #d9a23a; }
.gh-grp-tag { margin-left: auto; text-transform: none; letter-spacing: 0; color: rgba(170,172,190,0.4); font-size: 10px; }
.gh-grp-empty { padding: 4px 6px 4px 22px; color: rgba(170,172,190,0.35); font-size: 11px; }
.gh-repo-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 22px; border-radius: 7px; cursor: pointer; }
.gh-repo-row:hover { background: rgba(128,128,128,0.12); }
.gh-repo-row.gh-drop-target { background: rgba(58,95,138,0.18); outline: 1px solid #3a5f8a; }
.gh-glyph { color: rgba(170,172,190,0.45); width: 14px; text-align: center; flex: 0 0 14px; font-size: 11px; }
.gh-repo-name { color: var(--fg, #e1e1eb); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.gh-own { color: rgba(170,172,190,0.6); }
.gh-repo-meta { margin-left: auto; display: flex; align-items: center; gap: 8px; color: rgba(170,172,190,0.45); font-size: 11px; flex: 0 0 auto; }
.gh-pin { color: #d9a23a; }
.gh-pill { background: #2d3a52; color: #7aa7e0; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 9px; }
.gh-newgrp { display: flex; gap: 6px; padding: 6px 10px; }
.gh-newgrp input { flex: 1; background: rgba(0,0,0,0.25); border: 1px solid var(--border, rgba(128,128,128,0.18)); border-radius: 6px; color: var(--fg, #e1e1eb); padding: 4px 7px; font-size: 12px; outline: 0; }
.gh-newgrp button { background: rgba(128,128,128,0.16); border: 0; color: inherit; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
```

- [ ] **Step 3: Verify types**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: no errors. (`ReposView` is unused until Task 6 — TS allows unused exports.)

- [ ] **Step 4: Commit**

```bash
git add src/github/ReposView.tsx src/index.css
git commit -m "feat(github): ReposView grouped tree (read-only, search, collapse)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Frontend — ReposView interactions (pin, new group, drag, context menu)

**Files:**
- Modify: `src/github/ReposView.tsx`

**Interfaces:**
- Consumes: `FileContextMenu` from `../sidebar/contextMenu`; `invoke("open_path", { path })`.
- Produces: pin toggling, custom-group creation, drag-repo-into-group, and a per-row right-click menu — all persisting via `onUpdate`.

- [ ] **Step 1: Add imports** at the top of `ReposView.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileContextMenu } from "../sidebar/contextMenu";
```

- [ ] **Step 2: Add interaction state + handlers** inside the component, after the `sections` memo:

```tsx
  const [newGroup, setNewGroup] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; repo: Repo } | null>(null);

  const togglePin = (name: string) => {
    const next = pinned.includes(name)
      ? pinned.filter((n) => n !== name)
      : [...pinned, name];
    onUpdate({ github_pinned_repos: next });
  };

  const addGroup = () => {
    const g = newGroup.trim();
    if (!g || customGroups.includes(g)) { setNewGroup(""); return; }
    onUpdate({ github_custom_groups: [...customGroups, g] });
    setNewGroup("");
  };

  const moveToGroup = (name: string, group: string | null) => {
    const next = { ...repoGroup };
    if (group) next[name] = group; else delete next[name];
    onUpdate({ github_repo_group: next });
  };
```

- [ ] **Step 3: Make group headers drop targets.** Replace the `<div className="gh-grp-h" …>` opening tag for **custom** sections so a dragged repo can be dropped onto them. Change the group-header render to compute droppability from the section key:

```tsx
              <div
                className="gh-grp-h"
                onClick={() => toggleCollapse(sec.key)}
                onDragOver={sec.key.startsWith("custom:") ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTarget(sec.key); } : undefined}
                onDragLeave={sec.key.startsWith("custom:") ? () => setDropTarget((t) => (t === sec.key ? null : t)) : undefined}
                onDrop={sec.key.startsWith("custom:") ? (e) => {
                  e.preventDefault();
                  const name = e.dataTransfer.getData("text/plain");
                  if (name) moveToGroup(name, sec.label);
                  setDropTarget(null);
                } : undefined}
                style={dropTarget === sec.key ? { background: "rgba(58,95,138,0.18)" } : undefined}
              >
```

- [ ] **Step 4: Make repo rows draggable + right-clickable + star-clickable.** Replace the `<div className="gh-repo-row" …>` block with:

```tsx
                <div
                  className="gh-repo-row"
                  key={r.nameWithOwner}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    try { e.dataTransfer.setData("text/plain", r.nameWithOwner); } catch { /* webview quirk */ }
                  }}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, repo: r }); }}
                  onClick={() => invoke("open_path", { path: `https://github.com/${r.nameWithOwner}` })}
                >
                  <span className="gh-glyph">{r.isPrivate ? "🔒" : "○"}</span>
                  <span className="gh-repo-name">
                    <span className="gh-own">{r.owner}/</span>
                    {r.nameWithOwner.slice(r.owner.length + 1)}
                  </span>
                  <span className="gh-repo-meta">
                    <span
                      className="gh-pin"
                      style={{ opacity: pinnedSet.has(r.nameWithOwner) ? 1 : 0.25, cursor: "pointer" }}
                      title={pinnedSet.has(r.nameWithOwner) ? "Unpin" : "Pin"}
                      onClick={(e) => { e.stopPropagation(); togglePin(r.nameWithOwner); }}
                    >★</span>
                    {r.openPrCount > 0 && <span className="gh-pill">{r.openPrCount} PR{r.openPrCount > 1 ? "s" : ""}</span>}
                    <span className="gh-time">{relTime(r.pushedAt)}</span>
                  </span>
                </div>
```

- [ ] **Step 5: Add a "New group" input** just below the `<div className="gh-search">…</div>` block:

```tsx
      <div className="gh-newgrp">
        <input
          placeholder="New group…"
          value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addGroup(); }}
        />
        <button onClick={addGroup}>Add</button>
      </div>
```

- [ ] **Step 6: Render the context menu** just before the closing `</div>` of the root `gh-repos` element:

```tsx
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: pinned.includes(menu.repo.nameWithOwner) ? "Unpin" : "Pin to Favorites", onClick: () => togglePin(menu.repo.nameWithOwner) },
            ...customGroups.map((g) => ({ label: `Move to: ${g}`, onClick: () => moveToGroup(menu.repo.nameWithOwner, g) })),
            ...(repoGroup[menu.repo.nameWithOwner] ? [{ label: "Remove from group", onClick: () => moveToGroup(menu.repo.nameWithOwner, null) }] : []),
            { label: "Open on GitHub", onClick: () => invoke("open_path", { path: `https://github.com/${menu.repo.nameWithOwner}` }) },
          ]}
        />
      )}
```

- [ ] **Step 7: Verify types**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: no errors. If `FileContextMenu`'s exported prop type differs from `{ x, y, items, onClose }`, open `src/sidebar/contextMenu.tsx`, match its actual signature, and adjust the call — do not change `contextMenu.tsx`.

- [ ] **Step 8: Commit**

```bash
git add src/github/ReposView.tsx
git commit -m "feat(github): ReposView interactions — pin, groups, drag, context menu

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Mount ReposView in GithubPanel

**Files:**
- Modify: `src/github/GithubPanel.tsx` (props, import, replace the `repos` placeholder)
- Modify: `src/sidebar/Sidebar.tsx` (pass repo state + update into `GithubPanel`)

**Interfaces:**
- Consumes: `ReposView` (Tasks 4–5); the four `github_*` fields from `SidebarState` (Task 3).
- Produces: a live Repos sub-tab.

- [ ] **Step 1: Extend `GithubPanel` props + import.** In `src/github/GithubPanel.tsx`, add the import and widen the props:

```tsx
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ReposView, RepoUpdate } from "./ReposView";

export type GhAuthStatus = { installed: boolean; authed: boolean; login: string | null };

type SubView = "repos" | "prs" | "actions";

export type GithubRepoState = {
  pinned: string[];
  customGroups: string[];
  repoGroup: Record<string, string>;
  collapsed: string[];
};
```

Change the component signature from `{ subview, onSubview }` to:

```tsx
export function GithubPanel({
  subview,
  onSubview,
  repoState,
  onRepoUpdate,
}: {
  subview: string;
  onSubview: (v: string) => void;
  repoState: GithubRepoState;
  onRepoUpdate: (patch: RepoUpdate) => void;
}) {
```

- [ ] **Step 2: Replace the repos placeholder.** Swap the line at the `active === "repos"` slot:

```tsx
        {active === "repos" && (
          <ReposView
            pinned={repoState.pinned}
            customGroups={repoState.customGroups}
            repoGroup={repoState.repoGroup}
            collapsed={repoState.collapsed}
            onUpdate={onRepoUpdate}
          />
        )}
        {active === "prs" && <div className="gh-placeholder">PR inbox — coming in Plan 2</div>}
        {active === "actions" && <div className="gh-placeholder">Actions — coming in Plan 3</div>}
```

- [ ] **Step 3: Pass state from `Sidebar.tsx`.** Update the `<GithubPanel>` render (added in Plan 0) to:

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
              />
            )}
```

- [ ] **Step 4: Verify types + build**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: no errors.
Run: `npm run build 2>&1 | tail -3`
Expected: `✓ built` (chunk-size warning is pre-existing and fine).

- [ ] **Step 5: Commit**

```bash
git add src/github/GithubPanel.tsx src/sidebar/Sidebar.tsx
git commit -m "feat(github): mount ReposView in the Repos sub-tab

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end manual verification

**Files:** none.

- [ ] **Step 1:** Run `npm run tauri dev`; open the GitHub tab → **Repos**.
- [ ] **Step 2: Tree loads.** Your repositories appear, grouped under their org/owner headers (`org · N repos`), newest-push first. Private repos show 🔒, public ○; repos with open PRs show a count pill; last-push times look right.
- [ ] **Step 3: Pin.** Click a row's ★ (or right-click → Pin). The repo moves into a top **★ Favorites** section and the star fills. Quit + relaunch → it's still pinned (persisted to `ui.toml`).
- [ ] **Step 4: Custom group.** Type a name in "New group…" → Add. **Drag** a repo onto that group's header → it moves under the group. Right-click → "Remove from group" → it returns to its org group. Restart → group + membership persist.
- [ ] **Step 5: Collapse + search.** Collapse/expand a group header (caret toggles); state survives restart. Type in the filter → only matching `owner/name` rows show.
- [ ] **Step 6: Open on GitHub.** Click a row (or right-click → Open on GitHub) → the repo opens in your browser.
- [ ] **Step 7: Refresh + cache.** Click ⟳ → list refetches. Confirm `cat ~/.config/vector/ui.toml` shows `github_pinned_repos`, `github_custom_groups`, `[github_repo_group]`, and `github_collapsed_groups` reflecting your actions.

If a fix was required during verification, commit it with a `fix(github):` message + the trailer.

---

## Self-Review

**Spec coverage (spec §4 Repos + §3 persistence):**
- Repos from `viewer.repositories` across OWNER/COLLABORATOR/ORGANIZATION_MEMBER, paginated, cached → Task 1. ✓
- Favorites → custom groups (user order) → auto org groups; pinned appear once (in Favorites) → Task 4 section builder. ✓
- Row: glyph, `owner/` name, open-PR pill, last-push relative time, pin star → Task 4. ✓
- Drag into custom group; "+ New group"; right-click Pin/Unpin, Move to group, Open on GitHub → Task 5. ✓
- Collapse state + scroll persist; group/pin persistence in `ui.toml` → Tasks 2–5. ✓
- Reveal-worktree context item → deferred (worktree linking is Plan 2's domain; noted, not built here). ✓ (scoped)

**Placeholder scan:** No "TBD/handle errors" — error/empty/loading states are concrete (Task 4). PR/Actions sub-bodies remain Plan 2/3 stubs by design. ✓

**Type consistency:** `Repo` camelCase fields identical in Rust (`repos.rs`) and TS (`ReposView.tsx`). `RepoUpdate` patch keys (`github_pinned_repos`, `github_custom_groups`, `github_repo_group`, `github_collapsed_groups`) match the `UiConfig`/`SidebarConfigPatch`/`SidebarState` field names exactly. `list_github_repos` takes `{ force: boolean }` on both sides. `GithubPanel` new props (`repoState`, `onRepoUpdate`) are threaded from `Sidebar.tsx`. ✓
