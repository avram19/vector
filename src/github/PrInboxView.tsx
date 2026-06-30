import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RepoFilterDropdown } from "./RepoFilterDropdown";

export type PullRequest = {
  repo: string; number: number; title: string; url: string;
  author: string; authorAvatar: string | null; headRef: string;
  isDraft: boolean; state: string; reviewDecision: string | null;
  mergeable: string; ciStatus: string | null; updatedAt: string;
};
type MyPrs = { authored: PullRequest[]; recentlyClosed: PullRequest[] };
type PrPage = { prs: PullRequest[]; nextCursor: string | null };

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24; if (d < 7) return `${Math.floor(d)}d`;
  return `${Math.floor(d / 7)}w`;
}
function ciClass(ci: string | null): string {
  if (ci === "SUCCESS") return "ci-pass";
  if (ci === "FAILURE" || ci === "ERROR") return "ci-fail";
  if (ci === "PENDING" || ci === "EXPECTED") return "ci-run";
  return "ci-none";
}
function needsAction(p: PullRequest): boolean {
  return p.reviewDecision === "CHANGES_REQUESTED" || p.ciStatus === "FAILURE" || p.ciStatus === "ERROR" || p.mergeable === "CONFLICTING";
}
function readyToMerge(p: PullRequest): boolean {
  return p.reviewDecision === "APPROVED" && p.mergeable === "MERGEABLE" && (p.ciStatus === "SUCCESS" || p.ciStatus === null) && !p.isDraft;
}
function initials(login: string): string {
  return login.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

function Avatar({ pr }: { pr: PullRequest }) {
  const [failed, setFailed] = useState(false);
  if (pr.authorAvatar && !failed) {
    return <img className="gh-pr-avatar" src={pr.authorAvatar} alt={pr.author} onError={() => setFailed(true)} />;
  }
  return <span className="gh-pr-avatar gh-pr-avatar--fallback">{initials(pr.author)}</span>;
}

function PrRow({ pr, onTrigger, unreadSet }: { pr: PullRequest; onTrigger: (t: { repo: string; presetRef?: string }) => void; unreadSet: Set<string> }) {
  const unread = unreadSet.has(`${pr.repo}#${pr.number}`);
  const chips: { label: string; cls: string }[] = [];
  if (pr.state === "MERGED") chips.push({ label: "Merged", cls: "merged" });
  else if (pr.state === "CLOSED") chips.push({ label: "Closed", cls: "closed" });
  else {
    if (pr.mergeable === "CONFLICTING") chips.push({ label: "merge conflict", cls: "conflict" });
    if (pr.ciStatus === "FAILURE" || pr.ciStatus === "ERROR") chips.push({ label: "CI failed", cls: "conflict" });
    if (pr.reviewDecision === "CHANGES_REQUESTED") chips.push({ label: "changes requested", cls: "req" });
    if (pr.reviewDecision === "APPROVED") chips.push({ label: "approved", cls: "ok" });
    if (pr.isDraft) chips.push({ label: "draft", cls: "draft" });
  }
  return (
    <div className="gh-pr-row" onClick={() => invoke("open_path", { path: pr.url })} title={pr.title}>
      <div className="gh-pr-top">
        {unread && <span className="gh-pr-unread" title="Unread activity" />}
        <span className={`gh-ci-dot ${ciClass(pr.ciStatus)}`} />
        <span className="gh-pr-num">#{pr.number}</span>
        <span className="gh-pr-title">{pr.title}</span>
      </div>
      <div className="gh-pr-bot">
        <span className="gh-pr-repo">{pr.repo}</span>
        {chips.map((c) => <span key={c.label} className={`gh-pr-chip ${c.cls}`}>{c.label}</span>)}
        <span className="gh-pr-spacer" />
        {pr.state === "OPEN" && (
          <button className="gh-pr-deploy" title={`Run a workflow on ${pr.headRef}`}
            onClick={(e) => { e.stopPropagation(); onTrigger({ repo: pr.repo, presetRef: pr.headRef }); }}>Deploy</button>
        )}
        <Avatar pr={pr} />
        <span className="gh-pr-time">{relTime(pr.updatedAt)}</span>
      </div>
    </div>
  );
}

function Section({ title, count, children, defaultOpen = true, level = 0 }: {
  title: string; count: number; children: React.ReactNode; defaultOpen?: boolean; level?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`gh-pr-section level-${level}`}>
      <div className="gh-pr-section-h" onClick={() => setOpen((v) => !v)}>
        <span className="gh-caret">{open ? "▾" : "▸"}</span>
        <span className="gh-pr-section-title">{title}</span>
        <span className="gh-pr-count">{count}</span>
      </div>
      {open && <div className="gh-pr-section-body">{children}</div>}
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v5h-5" />
    </svg>
  );
}

export function PrInboxView({ repoFilter, onRepoFilter, login, onTrigger, notifications }: {
  repoFilter: string | null;
  onRepoFilter: (r: string | null) => void;
  login: string;
  onTrigger: (target: { repo: string; presetRef?: string }) => void;
  notifications: { repo: string; number: number; updatedAt: string }[];
}) {
  const [mine, setMine] = useState<MyPrs | null>(null);
  const [team, setTeam] = useState<PullRequest[] | null>(null);
  const [teamCursor, setTeamCursor] = useState<string | null>(null);
  const [teamMore, setTeamMore] = useState(false);
  const [repoPrs, setRepoPrs] = useState<PullRequest[] | null>(null);
  const [repoCursor, setRepoCursor] = useState<string | null>(null);
  const [repoMore, setRepoMore] = useState(false);
  const [repoLoading, setRepoLoading] = useState(false);
  const [allRepos, setAllRepos] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback((force: boolean) => {
    setRefreshing(true);
    // My PRs first (fast), then the first page of Team PRs (the big one).
    const p1 = invoke<MyPrs>("list_github_my_prs", { force })
      .then((r) => { setMine(r); setLoading(false); })
      .catch((e) => setError(String(e)));
    const p2 = invoke<PrPage>("list_github_team_prs", { after: null })
      .then((page) => { setTeam(page.prs); setTeamCursor(page.nextCursor); })
      .catch((e) => setError(String(e)));
    Promise.allSettled([p1, p2]).finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.allSettled([
      invoke<MyPrs>("get_cached_github_my_prs").then((c) => { if (alive && (c.authored.length || c.recentlyClosed.length)) { setMine(c); setLoading(false); } }),
      invoke<PullRequest[]>("get_cached_github_team_prs").then((c) => { if (alive && c.length) setTeam(c); }),
    ]).finally(() => { if (alive) load(false); });
    return () => { alive = false; };
  }, [load]);

  const loadMoreTeam = () => {
    if (!teamCursor || teamMore) return;
    setTeamMore(true);
    invoke<PrPage>("list_github_team_prs", { after: teamCursor })
      .then((page) => { setTeam((prev) => [...(prev ?? []), ...page.prs]); setTeamCursor(page.nextCursor); })
      .catch((e) => setError(String(e)))
      .finally(() => setTeamMore(false));
  };

  // All repos that have open PRs (from the repos cache) — the dropdown source,
  // so any repo whose PR-count badge you click is selectable and shows its PRs.
  useEffect(() => {
    invoke<{ nameWithOwner: string; openPrCount: number }[]>("get_cached_github_repos")
      .then((repos) => setAllRepos(repos.filter((r) => r.openPrCount > 0).map((r) => r.nameWithOwner)))
      .catch(() => {});
  }, []);

  // When a repo is selected, fetch the first page of its open PRs on demand.
  useEffect(() => {
    if (!repoFilter) { setRepoPrs(null); setRepoCursor(null); return; }
    let alive = true;
    setRepoLoading(true);
    setRepoPrs(null);
    setRepoCursor(null);
    invoke<PrPage>("list_github_repo_prs", { repo: repoFilter, after: null })
      .then((page) => { if (alive) { setRepoPrs(page.prs); setRepoCursor(page.nextCursor); } })
      .catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setRepoLoading(false); });
    return () => { alive = false; };
  }, [repoFilter]);

  const loadMoreRepo = () => {
    if (!repoFilter || !repoCursor || repoMore) return;
    setRepoMore(true);
    invoke<PrPage>("list_github_repo_prs", { repo: repoFilter, after: repoCursor })
      .then((page) => { setRepoPrs((prev) => [...(prev ?? []), ...page.prs]); setRepoCursor(page.nextCursor); })
      .catch((e) => setError(String(e)))
      .finally(() => setRepoMore(false));
  };

  const repoOptions = useMemo(() => {
    const set = new Set<string>(allRepos);
    (mine?.authored ?? []).forEach((p) => set.add(p.repo));
    (mine?.recentlyClosed ?? []).forEach((p) => set.add(p.repo));
    (team ?? []).forEach((p) => set.add(p.repo));
    if (repoFilter) set.add(repoFilter);
    return [...set].sort();
  }, [allRepos, mine, team, repoFilter]);

  const unreadSet = useMemo(() => new Set(notifications.map((n) => `${n.repo}#${n.number}`)), [notifications]);

  const match = useCallback((p: PullRequest) => {
    const q = filter.trim().toLowerCase().replace(/^#/, "");
    if (!q) return true;
    return p.title.toLowerCase().includes(q)
      || p.repo.toLowerCase().includes(q)
      || String(p.number).includes(q);
  }, [filter]);

  const groups = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86400_000;
    if (repoFilter) {
      // Repo mode: all open PRs in the repo, split by authorship.
      const prs = (repoPrs ?? []).filter(match);
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
    const authored = (mine?.authored ?? []).filter(match);
    const done = (mine?.recentlyClosed ?? []).filter((p) => match(p) && new Date(p.updatedAt).getTime() >= weekAgo);
    return {
      action: authored.filter(needsAction),
      ready: authored.filter((p) => !needsAction(p) && readyToMerge(p)),
      waiting: authored.filter((p) => !needsAction(p) && !readyToMerge(p)),
      done,
      teamPrs: (team ?? []).filter(match),
    };
  }, [repoFilter, repoPrs, mine, team, match, login]);

  const myTotal = groups.action.length + groups.ready.length + groups.waiting.length + groups.done.length;
  const nothingLoaded = !mine && !team && !repoPrs;
  // Repo mode: loading whenever its on-demand fetch hasn't returned yet (even if
  // the inbox was already loaded). Inbox mode: only before the first results.
  const showLoading = repoFilter ? (repoLoading && !repoPrs) : (loading && !mine && !team);

  // A plain JSX element (NOT a nested component) so the search input keeps focus
  // across re-renders. Reused by both the error and normal returns.
  const chrome = (
    <>
      <div className="gh-search">
        <input
          placeholder="Search Pull Requests…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        {(refreshing || repoLoading) && <span className="gh-dots" title="Updating…"><span /><span /><span /></span>}
        <button className="gh-icobtn" title="Refresh" onClick={() => load(true)}><RefreshIcon /></button>
      </div>
      <div className="gh-pr-repofilter">
        <RepoFilterDropdown value={repoFilter} options={repoOptions} onChange={onRepoFilter} />
      </div>
    </>
  );

  if (error && nothingLoaded) {
    return (
      <div className="gh-prs">
        {chrome}
        <div className="gh-empty">
          <p><b>Couldn't load pull requests</b></p>
          <p className="gh-muted">{error}</p>
          <button className="gh-retry" onClick={() => load(true)}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="gh-prs">
      {chrome}
      <div className="gh-pr-list">
        {showLoading ? (
          <div className="gh-placeholder">Loading pull requests…</div>
        ) : (
          <>
            <Section title="My Pull Requests" count={myTotal} level={0}>
              {groups.action.length > 0 && <Section title="Needs Action" count={groups.action.length} level={1}>{groups.action.map((p) => <PrRow key={p.url} pr={p} onTrigger={onTrigger} unreadSet={unreadSet} />)}</Section>}
              {groups.ready.length > 0 && <Section title="Ready to Merge" count={groups.ready.length} level={1}>{groups.ready.map((p) => <PrRow key={p.url} pr={p} onTrigger={onTrigger} unreadSet={unreadSet} />)}</Section>}
              {groups.waiting.length > 0 && <Section title="Waiting for Review/Checks" count={groups.waiting.length} level={1}>{groups.waiting.map((p) => <PrRow key={p.url} pr={p} onTrigger={onTrigger} unreadSet={unreadSet} />)}</Section>}
              {groups.done.length > 0 && <Section title="Done" count={groups.done.length} level={1} defaultOpen={false}>{groups.done.map((p) => <PrRow key={p.url} pr={p} onTrigger={onTrigger} unreadSet={unreadSet} />)}</Section>}
              {myTotal === 0 && <div className="gh-placeholder">Nothing here. 🎉</div>}
            </Section>
            <Section title="Team Pull Requests" count={groups.teamPrs.length} level={0}>
              {groups.teamPrs.length > 0 ? groups.teamPrs.map((p) => <PrRow key={p.url} pr={p} onTrigger={onTrigger} unreadSet={unreadSet} />) : <div className="gh-placeholder">No pull requests.</div>}
              {!repoFilter && teamCursor && <ViewMore loading={teamMore} onClick={loadMoreTeam} />}
            </Section>
            {repoFilter && repoCursor && <ViewMore loading={repoMore} onClick={loadMoreRepo} />}
          </>
        )}
      </div>
    </div>
  );
}

function ViewMore({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button className="gh-viewmore" onClick={onClick} disabled={loading}>
      {loading ? "Loading…" : "View more"}
    </button>
  );
}
