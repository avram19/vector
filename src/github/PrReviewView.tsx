import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseDiff, DiffLine } from "../preview/DiffRenderer";

type ReviewComment = { id: string; author: string; authorAvatar: string | null; body: string; createdAt: string };
type ReviewThread = { id: string; path: string; line: number | null; isResolved: boolean; comments: ReviewComment[] };
type DraftComment = { path: string; line: number; body: string };

type FileDiff = { path: string; lines: DiffLine[]; lineNumbers: (number | null)[] };

// Computes GitHub's real new-file line number for each rendered diff row, so
// review threads/comments (which the backend keys by that real line number,
// not by array index) can be matched/created correctly.
function computeLineNumbers(lines: DiffLine[]): (number | null)[] {
  let newLineNum = 0;
  return lines.map((line) => {
    if (line.kind === "hunk") {
      const m = line.text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLineNum = m ? parseInt(m[1], 10) - 1 : newLineNum;
      return null;
    }
    if (line.kind === "meta") return null;
    if (line.kind === "del") return null;
    newLineNum += 1;
    return newLineNum;
  });
}

function splitIntoFiles(raw: string): FileDiff[] {
  const files: { path: string; lines: DiffLine[] }[] = [];
  let current: { path: string; lines: DiffLine[] } | null = null;
  for (const rawLine of raw.split("\n")) {
    if (rawLine.startsWith("diff --git")) {
      const m = rawLine.match(/^diff --git a\/(.+) b\/(.+)$/);
      current = { path: m ? m[2] : rawLine, lines: [] };
      files.push(current);
    }
    if (current) current.lines.push(...parseDiff(rawLine));
  }
  return files.map((f) => ({ ...f, lineNumbers: computeLineNumbers(f.lines) }));
}

export function PrReviewView({ repo, number, standalone }: { repo: string; number: number; standalone?: boolean }) {
  const [diffFiles, setDiffFiles] = useState<FileDiff[] | null>(null);
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftComment[]>([]);

  const load = useCallback(() => {
    setError(null);
    invoke<string>("get_pr_diff", { repo, number })
      .then((raw) => setDiffFiles(splitIntoFiles(raw)))
      .catch((e) => setError(String(e)));
    invoke<ReviewThread[]>("get_pr_review_threads", { repo, number })
      .then(setThreads)
      .catch((e) => setError(String(e)));
  }, [repo, number]);

  useEffect(() => { load(); }, [load]);

  const threadsByLine = useMemo(() => {
    const m = new Map<string, ReviewThread[]>();
    for (const t of threads) {
      if (t.line == null) continue;
      const key = `${t.path}:${t.line}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(t);
    }
    return m;
  }, [threads]);

  const ensureReviewId = useCallback(async (): Promise<string> => {
    if (reviewId) return reviewId;
    const id = await invoke<string>("start_or_get_pending_review", { repo, number });
    setReviewId(id);
    return id;
  }, [reviewId, repo, number]);

  const addDraft = (path: string, line: number) => {
    setDrafts((prev) => [...prev, { path, line, body: "" }]);
  };
  const updateDraft = (idx: number, body: string) => {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, body } : d)));
  };
  const removeDraft = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
  };

  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const resolveThread = async (threadId: string) => {
    setResolvingIds((prev) => new Set(prev).add(threadId));
    try {
      await invoke("resolve_review_thread", { threadId });
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, isResolved: true } : t)));
    } catch (e) {
      setError(String(e));
    } finally {
      setResolvingIds((prev) => { const next = new Set(prev); next.delete(threadId); return next; });
    }
  };

  const [reviewDialog, setReviewDialog] = useState<{ event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitReview = async (summaryBody: string) => {
    if (!reviewDialog) return;
    setSubmitting(true);
    try {
      const id = await ensureReviewId();
      for (const d of drafts) {
        if (d.body.trim()) await invoke("add_review_comment", { reviewId: id, path: d.path, line: d.line, body: d.body });
      }
      await invoke("submit_pr_review", { reviewId: id, event: reviewDialog.event, body: summaryBody });
      setDrafts([]);
      setReviewDialog(null);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [merging, setMerging] = useState(false);
  const doMerge = async () => {
    setMerging(true);
    try {
      await invoke("merge_pr", { repo, number, method: mergeMethod });
      setMergeDialogOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setMerging(false);
    }
  };

  if (error && !diffFiles) {
    return (
      <div className="prv-empty">
        <p><b>Couldn't load PR #{number}</b></p>
        <p className="gh-muted">{error}</p>
        <button className="gh-retry" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!diffFiles) return <div className="prv-empty">Loading PR #{number}…</div>;

  return (
    <div className="prv">
      <div className="prv-head">
        <div className="prv-h1">
          <span className="t">PR #{number}</span>
          {!standalone && (
            <a className="ext-link" onClick={() => invoke("open_pr_review_window", { repo, number })}>⧉ New window</a>
          )}
          <a className="ext-link" onClick={() => invoke("open_path", { path: `https://github.com/${repo}/pull/${number}` })}>↗ Open on GitHub</a>
        </div>
        {error && <div className="prv-error" onClick={() => setError(null)}>{error}</div>}
      </div>
      <div className="prv-body">
        {diffFiles.map((f) => (
          <div className="diff-file" key={f.path}>
            <div className="diff-fh">{f.path}</div>
            {f.lines.map((line, i) => {
              if (line.kind === "hunk" || line.kind === "meta") {
                return <div key={i} className={`diff-line diff-${line.kind}`}>{line.text}</div>;
              }
              const lineNum = f.lineNumbers[i];
              const commentable = lineNum != null;
              const lineMatches = commentable ? (threadsByLine.get(`${f.path}:${lineNum}`) ?? []) : [];
              return (
                <div key={i} className="diff-line-wrap">
                  <div className={`diff-line diff-${line.kind}`} onClick={() => commentable && addDraft(f.path, lineNum)}>
                    <span className="diff-gutter">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
                    <span className="diff-content">{line.text}</span>
                    {commentable && (
                      <span className="diff-addc" onClick={(e) => { e.stopPropagation(); addDraft(f.path, lineNum); }}>+</span>
                    )}
                  </div>
                  {lineMatches.map((t) => (
                    <div className={`thread${t.isResolved ? " resolved" : ""}`} key={t.id}>
                      <div className="thread-h">
                        <span>{t.comments.length} comment{t.comments.length === 1 ? "" : "s"}</span>
                        {!t.isResolved && (
                          <button className="rs" disabled={resolvingIds.has(t.id)} onClick={() => resolveThread(t.id)}>
                            {resolvingIds.has(t.id) ? "Resolving…" : "Resolve"}
                          </button>
                        )}
                        {t.isResolved && <span className="resolved-tag">✓ Resolved</span>}
                      </div>
                      {t.comments.map((c) => (
                        <div className="cmt" key={c.id}>
                          <div><b>{c.author}</b> <span className="when">{c.createdAt}</span><div className="body2">{c.body}</div></div>
                        </div>
                      ))}
                    </div>
                  ))}
                  {drafts.map((d, di) => d.path === f.path && d.line === lineNum ? (
                    <div className="draft-note" key={di}>
                      <textarea value={d.body} onChange={(e) => updateDraft(di, e.target.value)} placeholder="Pending comment…" />
                      <button onClick={() => removeDraft(di)}>Remove</button>
                    </div>
                  ) : null)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="prv-bar">
        <span className="cnt2">{drafts.length} pending comment{drafts.length === 1 ? "" : "s"}</span>
        <button className="btn-review" onClick={() => setReviewDialog({ event: "COMMENT" })}>Comment</button>
        <button className="btn-review request" onClick={() => setReviewDialog({ event: "REQUEST_CHANGES" })}>Request changes</button>
        <button className="btn-review approve" onClick={() => setReviewDialog({ event: "APPROVE" })}>Approve</button>
        <button className="btn-merge" onClick={() => setMergeDialogOpen(true)}>Merge…</button>
      </div>

      {reviewDialog && (
        <ReviewSummaryDialog
          kind={reviewDialog.event}
          submitting={submitting}
          onCancel={() => setReviewDialog(null)}
          onSubmit={submitReview}
        />
      )}
      {mergeDialogOpen && (
        <MergeDialog
          repo={repo}
          number={number}
          method={mergeMethod}
          onMethod={setMergeMethod}
          merging={merging}
          onCancel={() => setMergeDialogOpen(false)}
          onConfirm={doMerge}
        />
      )}
    </div>
  );
}

function ReviewSummaryDialog({ kind, submitting, onCancel, onSubmit }: {
  kind: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  const titles: Record<string, string> = { APPROVE: "Approve", REQUEST_CHANGES: "Request changes", COMMENT: "Comment" };
  return (
    <div className="prv-overlay">
      <div className="prv-dialog">
        <h3>Submit review — {titles[kind]}</h3>
        <textarea placeholder="Summary comment (optional)…" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="prv-dialog-actions">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" disabled={submitting} onClick={() => onSubmit(body)}>
            {submitting ? "Submitting…" : "Submit review"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MergeDialog({ repo, number, method, onMethod, merging, onCancel, onConfirm }: {
  repo: string;
  number: number;
  method: "merge" | "squash" | "rebase";
  onMethod: (m: "merge" | "squash" | "rebase") => void;
  merging: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const labels: Record<string, string> = { merge: "Merge commit", squash: "Squash & merge", rebase: "Rebase" };
  return (
    <div className="prv-overlay">
      <div className="prv-dialog">
        <h3>Merge pull request</h3>
        <div className="pr-ref">#{number} · {repo}</div>
        <div className="methodrow">
          {(["squash", "merge", "rebase"] as const).map((m) => (
            <div key={m} className={`method${method === m ? " sel" : ""}`} onClick={() => onMethod(m)}>{labels[m]}</div>
          ))}
        </div>
        <div className="prv-dialog-actions">
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-merge" disabled={merging} onClick={onConfirm}>
            {merging ? "Merging…" : `${labels[method]} #${number}`}
          </button>
        </div>
      </div>
    </div>
  );
}
