import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileContextMenu } from "../sidebar/contextMenu";

export type Repo = {
  nameWithOwner: string;
  owner: string;
  isPrivate: boolean;
  isArchived: boolean;
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

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function KebabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

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
  onOpenPrs,
}: {
  pinned: string[];
  customGroups: string[];
  repoGroup: Record<string, string>;
  collapsed: string[];
  onUpdate: (patch: RepoUpdate) => void;
  onOpenPrs: (repo: string) => void;
}) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async (force: boolean) => {
    setRefreshing(true);
    setError(null);
    try {
      const all: Repo[] = [];
      let cursor: string | null = null;
      // First page replaces; subsequent pages append — the view fills in live.
      do {
        const page: { repos: Repo[]; nextCursor: string | null } = await invoke(
          "list_github_repos_page", { cursor }
        );
        all.push(...page.repos);
        setRepos([...all]);
        cursor = page.nextCursor;
      } while (cursor);
      await invoke("set_cached_github_repos", { repos: all }).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    invoke<Repo[]>("get_cached_github_repos")
      .then((cached) => { if (alive && cached.length) { setRepos(cached); setLoading(false); } })
      .catch(() => {})
      .finally(() => { if (alive) load(false); });
    return () => { alive = false; };
  }, [load]);

  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const collapsedSet = useMemo(() => new Set(collapsed), [collapsed]);

  const sections: Section[] = useMemo(() => {
    if (!repos) return [];
    const q = filter.trim().toLowerCase();
    const searching = q.length > 0;
    // Archived repos are hidden by default and only surface when actively searching.
    const visible = repos.filter((r) => {
      if (r.isArchived && !searching) return false;
      return !q || r.nameWithOwner.toLowerCase().includes(q);
    });

    const favorites = visible.filter((r) => pinnedSet.has(r.nameWithOwner));
    const custom = new Map<string, Repo[]>();
    customGroups.forEach((g) => custom.set(g, []));
    const orgs = new Map<string, Repo[]>();

    // Pinned repos appear in Favorites AND still under their custom/org group,
    // so assigning a favorited repo to a group has a visible effect.
    for (const r of visible) {
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

  const [newGroup, setNewGroup] = useState("");
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; repo: Repo } | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; group: string } | null>(null);
  const [overflow, setOverflow] = useState<{ x: number; y: number } | null>(null);
  // WKWebView fires a `click` right after `contextmenu`; suppress that one click
  // so right-clicking a row opens the menu without also opening the repo.
  const suppressClickRef = useRef(false);

  const togglePin = (name: string) => {
    const next = pinned.includes(name)
      ? pinned.filter((n) => n !== name)
      : [...pinned, name];
    onUpdate({ github_pinned_repos: next });
  };

  const addGroup = () => {
    const g = newGroup.trim();
    if (!g || customGroups.includes(g)) { setNewGroup(""); setShowNewGroup(false); return; }
    onUpdate({ github_custom_groups: [...customGroups, g] });
    setNewGroup("");
    setShowNewGroup(false);
  };

  const deleteGroup = (group: string) => {
    const nextGroups = customGroups.filter((g) => g !== group);
    const nextMap: Record<string, string> = {};
    for (const [repo, g] of Object.entries(repoGroup)) {
      if (g !== group) nextMap[repo] = g; // repos in the deleted group fall back to their org
    }
    onUpdate({ github_custom_groups: nextGroups, github_repo_group: nextMap });
  };

  const moveToGroup = (name: string, group: string | null) => {
    const next = { ...repoGroup };
    if (group) next[name] = group; else delete next[name];
    onUpdate({ github_repo_group: next });
  };

  if (error && !repos) {
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
    <div className="gh-repos" onContextMenu={(e) => e.preventDefault()}>
      <div className="gh-search">
        <span className="gh-search-ico"><SearchIcon /></span>
        <input
          placeholder="Search repos…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        {refreshing && (
          <span className="gh-dots" title="Updating…"><span /><span /><span /></span>
        )}
        <button
          className="gh-icobtn"
          title="More actions"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setOverflow({ x: r.right, y: r.bottom });
          }}
        ><KebabIcon /></button>
      </div>
      {showNewGroup && (
        <div className="gh-newgrp">
          <input
            autoFocus
            placeholder="New group name…"
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addGroup();
              if (e.key === "Escape") { setNewGroup(""); setShowNewGroup(false); }
            }}
          />
          <button onClick={addGroup}>Add</button>
        </div>
      )}
      <div className="gh-tree">
        {sections.map((sec) => {
          const isCollapsed = collapsedSet.has(sec.key);
          return (
            <div className="gh-grp" key={sec.key}>
              <div
                className="gh-grp-h"
                onClick={(e) => { if (e.ctrlKey || e.button !== 0) return; toggleCollapse(sec.key); }}
                onDragOver={sec.key.startsWith("custom:") ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropTarget(sec.key); } : undefined}
                onDragLeave={sec.key.startsWith("custom:") ? () => setDropTarget((t) => (t === sec.key ? null : t)) : undefined}
                onDrop={sec.key.startsWith("custom:") ? (e) => {
                  e.preventDefault();
                  const name = e.dataTransfer.getData("text/plain");
                  if (name) moveToGroup(name, sec.label);
                  setDropTarget(null);
                } : undefined}
                onContextMenu={sec.key.startsWith("custom:") ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setGroupMenu({ x: e.clientX, y: e.clientY, group: sec.label });
                } : undefined}
                style={dropTarget === sec.key ? { background: "rgba(58,95,138,0.18)" } : undefined}
              >
                <span className="gh-caret">{isCollapsed ? "▸" : "▾"}</span>
                {sec.star && <span className="gh-star">★</span>}
                <span className="gh-grp-label">{sec.label}</span>
                {sec.tag && <span className="gh-grp-tag">{sec.tag}</span>}
              </div>
              {!isCollapsed && sec.repos.map((r) => (
                <div
                  className="gh-repo-row"
                  key={r.nameWithOwner}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    try { e.dataTransfer.setData("text/plain", r.nameWithOwner); } catch { /* webview quirk */ }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    suppressClickRef.current = true;
                    setTimeout(() => { suppressClickRef.current = false; }, 0);
                    setMenu({ x: e.clientX, y: e.clientY, repo: r });
                  }}
                  onClick={(e) => {
                    // Ctrl/right-click is a context-menu gesture, never an "open".
                    if (e.ctrlKey || e.button !== 0 || suppressClickRef.current) return;
                    invoke("open_path", { path: `https://github.com/${r.nameWithOwner}` });
                  }}
                >
                  <span className="gh-glyph">{r.isPrivate ? "🔒" : "○"}</span>
                  <span className="gh-repo-name">
                    {!sec.key.startsWith("org:") && <span className="gh-own">{r.owner}/</span>}
                    {r.nameWithOwner.slice(r.owner.length + 1)}
                  </span>
                  <span className="gh-repo-meta">
                    {r.isArchived && <span className="gh-archived">archived</span>}
                    <span
                      className="gh-pin"
                      style={{ cursor: "pointer" }}
                      title={pinnedSet.has(r.nameWithOwner) ? "Unpin" : "Pin"}
                      onClick={(e) => { e.stopPropagation(); togglePin(r.nameWithOwner); }}
                    >{pinnedSet.has(r.nameWithOwner) ? "★" : "☆"}</span>
                    {r.openPrCount > 0 && (
                      <button
                        className="gh-pill gh-pill-btn"
                        title={`Show ${r.openPrCount} open pull request${r.openPrCount > 1 ? "s" : ""} for ${r.nameWithOwner}`}
                        onClick={(e) => { e.stopPropagation(); onOpenPrs(r.nameWithOwner); }}
                      >{r.openPrCount} PR{r.openPrCount > 1 ? "s" : ""}</button>
                    )}
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
      {groupMenu && (
        <FileContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          onClose={() => setGroupMenu(null)}
          items={[
            { label: `Delete group "${groupMenu.group}"`, onClick: () => deleteGroup(groupMenu.group) },
          ]}
        />
      )}
      {overflow && (
        <FileContextMenu
          x={overflow.x}
          y={overflow.y}
          onClose={() => setOverflow(null)}
          items={[
            { label: "New group…", onClick: () => setShowNewGroup(true) },
            { label: "Refresh repos", onClick: () => load(true) },
          ]}
        />
      )}
    </div>
  );
}
