import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ReposView, RepoUpdate } from "./ReposView";
import { PrInboxView } from "./PrInboxView";
import { ActionsView } from "./ActionsView";
import { TriggerModal } from "./TriggerModal";

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
  { id: "prs", label: "Pull Requests" },
  { id: "actions", label: "Actions" },
];

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

export function GithubPanel({
  subview,
  onSubview,
  repoState,
  onRepoUpdate,
  favoritedWorkflows,
  onFavoritedWorkflows,
  onOpenPreview,
}: {
  subview: string;
  onSubview: (v: string) => void;
  repoState: GithubRepoState;
  onRepoUpdate: (patch: RepoUpdate) => void;
  favoritedWorkflows: string[];
  onFavoritedWorkflows: (next: string[]) => void;
  onOpenPreview: (path: string, line: number | undefined, col: number | undefined, opts: { pin: boolean }) => void;
}) {
  const [auth, setAuth] = useState<GhAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [actionsRepo, setActionsRepo] = useState<string | null>(null);
  const [triggerTarget, setTriggerTarget] = useState<{ repo: string; presetRef?: string; presetWorkflowId?: number } | null>(null);

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
    <div className="gh-panel" onContextMenu={(e) => e.preventDefault()}>
      <div className="gh-head">
        <span className="gh-who">
          <span className="gh-av" />
          <b>@{auth.login}</b>
          <span className="gh-muted">· gh authed</span>
        </span>
        <button className="gh-icobtn" title="Refresh" onClick={refresh}><RefreshIcon /></button>
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
            onOpenPrs={(repo) => { setRepoFilter(repo); onSubview("prs"); }}
            onOpenActions={(repo) => { setActionsRepo(repo); onSubview("actions"); }}
          />
        )}
        {active === "prs" && <PrInboxView repoFilter={repoFilter} onRepoFilter={setRepoFilter} login={auth.login ?? ""} onTrigger={(t) => setTriggerTarget(t)} />}
        {active === "actions" && (
          <ActionsView
            favorites={favoritedWorkflows}
            onFavorites={(next) => onFavoritedWorkflows(next)}
            onOpenPreview={onOpenPreview}
            repo={actionsRepo}
            onRepo={setActionsRepo}
            onTrigger={(t) => setTriggerTarget(t)}
          />
        )}
      </div>
      {triggerTarget && (
        <TriggerModal
          repo={triggerTarget.repo}
          presetRef={triggerTarget.presetRef}
          presetWorkflowId={triggerTarget.presetWorkflowId}
          onClose={() => setTriggerTarget(null)}
        />
      )}
    </div>
  );
}
