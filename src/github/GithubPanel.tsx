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

const SUBTABS: { id: SubView; label: string }[] = [
  { id: "repos", label: "Repos" },
  { id: "prs", label: "PRs" },
  { id: "actions", label: "Actions" },
];

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
  const [auth, setAuth] = useState<GhAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    invoke<GhAuthStatus>("gh_auth_status")
      .then(setAuth)
      .catch(() => setAuth({ installed: false, authed: false, login: null }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading && !auth) {
    return <div className="gh-empty">Checking GitHub CLI…</div>;
  }
  if (!auth?.installed) {
    return (
      <div className="gh-empty">
        <p><b>GitHub CLI not found</b></p>
        <p className="gh-muted">Install <code>gh</code> to use the GitHub tab.</p>
        <a href="https://cli.github.com" target="_blank" rel="noreferrer">cli.github.com</a>
        <button className="gh-retry" onClick={refresh}>Retry</button>
      </div>
    );
  }
  if (!auth.authed) {
    return (
      <div className="gh-empty">
        <p><b>Not signed in to GitHub</b></p>
        <p className="gh-muted">Run <code>gh auth login</code> in a shell, then retry.</p>
        <button className="gh-retry" onClick={refresh}>Retry</button>
      </div>
    );
  }

  const active: SubView = SUBTABS.find((t) => t.id === subview)?.id ?? "repos";

  return (
    <div className="gh-panel">
      <div className="gh-head">
        <span className="gh-who">
          <span className="gh-av" />
          <b>@{auth.login}</b>
          <span className="gh-muted">· gh authed</span>
        </span>
        <button className="gh-icobtn" title="Refresh" onClick={refresh}>⟳</button>
      </div>
      <div className="gh-subtabs">
        {SUBTABS.map((t) => (
          <button
            key={t.id}
            className={`gh-subtab${active === t.id ? " active" : ""}`}
            onClick={() => onSubview(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="gh-subbody">
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
      </div>
    </div>
  );
}
