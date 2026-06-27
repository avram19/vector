import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type PullRequest = {
  repo: string; number: number; title: string; url: string;
  author: string; authorAvatar: string | null; headRef: string;
  isDraft: boolean; state: string; reviewDecision: string | null;
  mergeable: string; ciStatus: string | null; updatedAt: string;
};
type MyPrs = { authored: PullRequest[]; recentlyClosed: PullRequest[] };

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

function PrRow({ pr }: { pr: PullRequest }) {
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
        <span className={`gh-ci-dot ${ciClass(pr.ciStatus)}`} />
        <span className="gh-pr-num">#{pr.number}</span>
        <span className="gh-pr-title">{pr.title}</span>
      </div>
      <div className="gh-pr-bot">
        <span className="gh-pr-repo">{pr.repo}</span>
        {chips.map((c) => <span key={c.label} className={`gh-pr-chip ${c.cls}`}>{c.label}</span>)}
        <span className="gh-pr-spacer" />
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

export function PrInboxView({ repoFilter, onRepoFilter }: {
  repoFilter: string | null;
  onRepoFilter: (r: string | null) => void;
}) {
  const [mine, setMine] = useState<MyPrs | null>(null);
  const [team, setTeam] = useState<PullRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback((force: boolean) => {
    setRefreshing(true);
    // My PRs first (fast), then Team PRs (the big one) — renders in two phases.
    const p1 = invoke<MyPrs>("list_github_my_prs", { force })
      .then((r) => { setMine(r); setLoading(false); })
      .catch((e) => setError(String(e)));
    const p2 = invoke<PullRequest[]>("list_github_team_prs", { force })
      .then((r) => setTeam(r))
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

  // Repos present across all fetched PRs, for the dropdown.
  const repoOptions = useMemo(() => {
    const set = new Set<string>();
    (mine?.authored ?? []).forEach((p) => set.add(p.repo));
    (mine?.recentlyClosed ?? []).forEach((p) => set.add(p.repo));
    (team ?? []).forEach((p) => set.add(p.repo));
    return [...set].sort();
  }, [mine, team]);

  const match = useCallback((p: PullRequest) => {
    const q = filter.trim().toLowerCase();
    return (!repoFilter || p.repo === repoFilter)
      && (!q || p.title.toLowerCase().includes(q) || p.repo.toLowerCase().includes(q));
  }, [filter, repoFilter]);

  const groups = useMemo(() => {
    const authored = (mine?.authored ?? []).filter(match);
    const weekAgo = Date.now() - 7 * 86400_000;
    const done = (mine?.recentlyClosed ?? []).filter((p) => match(p) && new Date(p.updatedAt).getTime() >= weekAgo);
    const action = authored.filter(needsAction);
    const ready = authored.filter((p) => !needsAction(p) && readyToMerge(p));
    const waiting = authored.filter((p) => !needsAction(p) && !readyToMerge(p));
    const teamPrs = (team ?? []).filter(match);
    return { action, ready, waiting, done, teamPrs };
  }, [mine, team, match]);

  if (error && !mine && !team) {
    return (
      <div className="gh-empty">
        <p><b>Couldn't load pull requests</b></p>
        <p className="gh-muted">{error}</p>
        <button className="gh-retry" onClick={() => load(true)}>Retry</button>
      </div>
    );
  }
  if (!mine && !team && loading) return <div className="gh-empty">Loading pull requests…</div>;

  const myTotal = groups.action.length + groups.ready.length + groups.waiting.length + groups.done.length;

  return (
    <div className="gh-prs">
      <div className="gh-search">
        <input placeholder="Search PRs…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {refreshing && <span className="gh-dots" title="Updating…"><span /><span /><span /></span>}
        <button className="gh-icobtn" title="Refresh" onClick={() => load(true)}><RefreshIcon /></button>
      </div>
      <div className="gh-pr-repofilter">
        <select value={repoFilter ?? ""} onChange={(e) => onRepoFilter(e.target.value || null)}>
          <option value="">All repos</option>
          {repoOptions.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <div className="gh-pr-list">
        <Section title="My PRs" count={myTotal} level={0}>
          {groups.action.length > 0 && <Section title="Needs Action" count={groups.action.length} level={1}>{groups.action.map((p) => <PrRow key={p.url} pr={p} />)}</Section>}
          {groups.ready.length > 0 && <Section title="Ready to Merge" count={groups.ready.length} level={1}>{groups.ready.map((p) => <PrRow key={p.url} pr={p} />)}</Section>}
          {groups.waiting.length > 0 && <Section title="Waiting for Review/Checks" count={groups.waiting.length} level={1}>{groups.waiting.map((p) => <PrRow key={p.url} pr={p} />)}</Section>}
          {groups.done.length > 0 && <Section title="Done" count={groups.done.length} level={1} defaultOpen={false}>{groups.done.map((p) => <PrRow key={p.url} pr={p} />)}</Section>}
          {myTotal === 0 && <div className="gh-placeholder">Nothing here. 🎉</div>}
        </Section>
        <Section title="Team PRs" count={groups.teamPrs.length} level={0}>
          {groups.teamPrs.length > 0 ? groups.teamPrs.map((p) => <PrRow key={p.url} pr={p} />) : <div className="gh-placeholder">No review requests.</div>}
        </Section>
      </div>
    </div>
  );
}
