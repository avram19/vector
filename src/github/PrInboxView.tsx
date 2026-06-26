import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type PullRequest = {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorAvatar: string | null;
  headRef: string;
  isDraft: boolean;
  state: string;
  reviewDecision: string | null;
  mergeable: string;
  ciStatus: string | null;
  updatedAt: string;
};

export type PrInbox = { authored: PullRequest[]; review: PullRequest[]; recentlyClosed: PullRequest[] };

const EMPTY: PrInbox = { authored: [], review: [], recentlyClosed: [] };

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

function needsAttention(p: PullRequest): boolean {
  return p.reviewDecision === "CHANGES_REQUESTED"
    || p.ciStatus === "FAILURE" || p.ciStatus === "ERROR"
    || p.mergeable === "CONFLICTING";
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
  if (pr.mergeable === "CONFLICTING") chips.push({ label: "merge conflict", cls: "conflict" });
  if (pr.ciStatus === "FAILURE" || pr.ciStatus === "ERROR") chips.push({ label: "CI failed", cls: "conflict" });
  if (pr.reviewDecision === "CHANGES_REQUESTED") chips.push({ label: "changes requested", cls: "req" });
  if (pr.reviewDecision === "APPROVED") chips.push({ label: "approved", cls: "ok" });
  if (pr.isDraft) chips.push({ label: "draft", cls: "draft" });

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

export function PrInboxView({ pinned }: { pinned: string[] }) {
  const [inbox, setInbox] = useState<PrInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback((force: boolean) => {
    setRefreshing(true);
    invoke<PrInbox>("list_github_prs", { force })
      .then((r) => { setInbox(r); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => { setRefreshing(false); setLoading(false); });
  }, []);

  useEffect(() => {
    let alive = true;
    invoke<PrInbox>("get_cached_github_prs")
      .then((cached) => {
        const any = cached.authored.length || cached.review.length || cached.recentlyClosed.length;
        if (alive && any) { setInbox(cached); setLoading(false); }
      })
      .catch(() => {})
      .finally(() => { if (alive) load(false); });
    return () => { alive = false; };
  }, [load]);

  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);

  const buckets = useMemo(() => {
    const data = inbox ?? EMPTY;
    const q = filter.trim().toLowerCase();
    const visible = (p: PullRequest) =>
      (!pinnedOnly || pinnedSet.has(p.repo)) &&
      (!q || p.title.toLowerCase().includes(q) || p.repo.toLowerCase().includes(q));

    const attention = data.authored.filter((p) => needsAttention(p) && visible(p));
    const authored = data.authored.filter((p) => !needsAttention(p) && visible(p));
    const review = data.review.filter(visible);
    const weekAgo = Date.now() - 7 * 86400_000;
    const closed = data.recentlyClosed.filter((p) => visible(p) && new Date(p.updatedAt).getTime() >= weekAgo);
    return { attention, review, authored, closed };
  }, [inbox, filter, pinnedOnly, pinnedSet]);

  if (error && !inbox) {
    return (
      <div className="gh-empty">
        <p><b>Couldn't load pull requests</b></p>
        <p className="gh-muted">{error}</p>
        <button className="gh-retry" onClick={() => load(true)}>Retry</button>
      </div>
    );
  }
  if (!inbox && loading) return <div className="gh-empty">Loading pull requests…</div>;

  const total = buckets.attention.length + buckets.review.length + buckets.authored.length;

  return (
    <div className="gh-prs">
      <div className="gh-search">
        <input placeholder="Search PRs…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {refreshing && <span className="gh-dots" title="Updating…"><span /><span /><span /></span>}
        <button className={`gh-chip-btn${pinnedOnly ? " on" : ""}`} onClick={() => setPinnedOnly((v) => !v)} title="Only pinned repos">Pinned</button>
        <button className="gh-icobtn" title="Refresh" onClick={() => load(true)}><RefreshIcon /></button>
      </div>
      <div className="gh-pr-list">
        <Bucket label="⚠ Needs attention" tone="warn" prs={buckets.attention} />
        <Bucket label="👀 Needs my review" prs={buckets.review} />
        <Bucket label="✎ Authored" prs={buckets.authored} />
        <div className="gh-pr-bucket">
          <div className="gh-pr-bucket-h" onClick={() => setShowClosed((v) => !v)}>
            <span className="gh-caret">{showClosed ? "▾" : "▸"}</span>
            ✔ Recently merged/closed <span className="gh-pr-count">{buckets.closed.length}</span>
          </div>
          {showClosed && buckets.closed.map((p) => <PrRow key={p.url} pr={p} />)}
        </div>
        {total === 0 && <div className="gh-placeholder">No open pull requests. 🎉</div>}
      </div>
    </div>
  );
}

function Bucket({ label, prs, tone }: { label: string; prs: PullRequest[]; tone?: "warn" }) {
  if (prs.length === 0) return null;
  return (
    <div className="gh-pr-bucket">
      <div className={`gh-pr-bucket-h${tone === "warn" ? " warn" : ""}`}>
        {label} <span className="gh-pr-count">{prs.length}</span>
      </div>
      {prs.map((p) => <PrRow key={p.url} pr={p} />)}
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}
