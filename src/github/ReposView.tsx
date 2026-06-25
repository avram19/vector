import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileContextMenu } from "../sidebar/contextMenu";

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
  const [loading, setLoading] = useState(true);
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
      <div className="gh-newgrp">
        <input
          placeholder="New group…"
          value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addGroup(); }}
        />
        <button onClick={addGroup}>Add</button>
      </div>
      <div className="gh-tree">
        {sections.map((sec) => {
          const isCollapsed = collapsedSet.has(sec.key);
          return (
            <div className="gh-grp" key={sec.key}>
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
    </div>
  );
}
