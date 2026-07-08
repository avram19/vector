import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { parseDiff, DiffLine } from "../preview/DiffRenderer";
import { GithubIcon } from "../sidebar/Sidebar";

// Same relative-time convention used across the other GitHub views
// (PrInboxView, ActionsView) — human-readable instead of a raw ISO string.
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

// Comment bodies are Markdown and frequently contain inline HTML (bot
// badges, links, images) — render them properly instead of as raw text.
// Same marked→DOMPurify pattern as src/preview/MarkdownRenderer.tsx, minus
// its line-tracking/Mermaid machinery, which a short comment body never needs.
// Deterministic per-author accent color (same username -> same color every
// time, since it's a pure hash of the name) — distinguishes commenters at a
// glance without needing avatar images.
const AUTHOR_COLORS = ["#ff8a4c", "#5ba8d1", "#8a7fd1", "#5fbf8f", "#d18fc4", "#c9a227", "#4fc3c7", "#e0757a"];
function authorColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AUTHOR_COLORS[Math.abs(hash) % AUTHOR_COLORS.length];
}

function CommentBody({ body }: { body: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(body, { async: false }) as string), [body]);
  return <div className="cmt-html" dangerouslySetInnerHTML={{ __html: html }} />;
}

type DiffSide = "LEFT" | "RIGHT";
type LineRef = { line: number; side: DiffSide };

type ReviewComment = { id: string; author: string; authorAvatar: string | null; body: string; createdAt: string };
type ReviewThread = { id: string; path: string; line: number | null; side: DiffSide; isResolved: boolean; comments: ReviewComment[] };
type DraftComment = { path: string; line: number; side: DiffSide; body: string };

type FileDiff = { path: string; lines: DiffLine[]; lineRefs: (LineRef | null)[] };

// Computes GitHub's real line reference for each rendered diff row — a
// deleted line only exists on the LEFT (old-file) side, an added line only
// on the RIGHT (new-file) side, and a context line exists on both but we
// comment on RIGHT for it (GitHub's own default). Review threads/comments
// are keyed by (side, line), not by array index or a single line-number
// space, since GitHub tracks old- and new-file line numbers independently.
function computeLineNumbers(lines: DiffLine[]): (LineRef | null)[] {
  let oldLineNum = 0;
  let newLineNum = 0;
  return lines.map((line) => {
    if (line.kind === "hunk") {
      const m = line.text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLineNum = m ? parseInt(m[1], 10) - 1 : oldLineNum;
      newLineNum = m ? parseInt(m[2], 10) - 1 : newLineNum;
      return null;
    }
    if (line.kind === "meta") return null;
    if (line.kind === "del") {
      oldLineNum += 1;
      return { line: oldLineNum, side: "LEFT" };
    }
    if (line.kind === "add") {
      newLineNum += 1;
      return { line: newLineNum, side: "RIGHT" };
    }
    // context — exists on both sides; advance both counters, comment on RIGHT.
    oldLineNum += 1;
    newLineNum += 1;
    return { line: newLineNum, side: "RIGHT" };
  });
}

type TreeNode = { name: string; path: string; isFile: boolean; children: TreeNode[] };

// Groups flat file paths into a directory tree (folders first, alphabetical
// within each level) for the file sidebar — mirrors GitHub's own PR
// "Files changed" tree instead of a flat, repeatedly-truncated path list.
function buildFileTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const path of paths) {
    const parts = path.split("/");
    let level = root;
    let acc = "";
    parts.forEach((part, idx) => {
      acc = acc ? `${acc}/${part}` : part;
      const isFile = idx === parts.length - 1;
      let node = level.find((n) => n.name === part && n.isFile === isFile);
      if (!node) {
        node = { name: part, path: acc, isFile, children: [] };
        level.push(node);
      }
      level = node.children;
    });
  }
  const sortTree = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1));
    nodes.forEach((n) => sortTree(n.children));
  };
  sortTree(root);
  return root;
}

// Same drag-to-resize behavior as src/sidebar/Sidebar.tsx's SidebarDivider,
// reusing its `.sidebar-divider` styling (absolutely positioned against a
// `position: relative` ancestor) rather than duplicating CSS.
function FilelistDivider({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const startXRef = useRef<number | null>(null);
  const startWidthRef = useRef<number>(width);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = width;

    const onMouseMove = (ev: MouseEvent) => {
      if (startXRef.current === null) return;
      const delta = ev.clientX - startXRef.current;
      const next = Math.min(480, Math.max(160, startWidthRef.current + delta));
      onChange(next);
    };
    const onMouseUp = () => {
      startXRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  return <div className="sidebar-divider" onMouseDown={onMouseDown} />;
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#dcb67a" aria-hidden="true">
      <path d="M3 6a2 2 0 0 1 2-2h4.5l2 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

// A small colored extension badge, approximating a VS Code file-icon theme
// without needing real icon assets — each extension gets a stable color +
// 1-2 letter label so file types are visually distinct at a glance.
const EXT_BADGES: Record<string, { label: string; color: string }> = {
  md: { label: "M↓", color: "#519aba" },
  mdx: { label: "M↓", color: "#519aba" },
  ts: { label: "TS", color: "#3178c6" },
  tsx: { label: "TSX", color: "#3178c6" },
  js: { label: "JS", color: "#cbcb41" },
  jsx: { label: "JSX", color: "#cbcb41" },
  mjs: { label: "JS", color: "#cbcb41" },
  cjs: { label: "JS", color: "#cbcb41" },
  json: { label: "{}", color: "#8bc34a" },
  py: { label: "PY", color: "#3572a5" },
  rs: { label: "RS", color: "#dea584" },
  go: { label: "GO", color: "#00add8" },
  css: { label: "#", color: "#563d7c" },
  scss: { label: "#", color: "#c6538c" },
  html: { label: "<>", color: "#e34c26" },
  yml: { label: "YM", color: "#cb171e" },
  yaml: { label: "YM", color: "#cb171e" },
  toml: { label: "TM", color: "#9c4221" },
  lock: { label: "🔒", color: "#8a8a8a" },
  sh: { label: "SH", color: "#89e051" },
  sql: { label: "DB", color: "#e38c00" },
};

function fileIcon(name: string): { label: string; color: string } {
  const lower = name.toLowerCase();
  if (lower === "readme.md" || lower === "readme") return { label: "ⓘ", color: "#519aba" };
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  return EXT_BADGES[ext] ?? { label: "▤", color: "#8a8a8a" };
}

function FileTree({ nodes, depth, activeFile, collapsed, onToggleFolder, onSelectFile }: {
  nodes: TreeNode[];
  depth: number;
  activeFile: string | null;
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((n) => {
        if (n.isFile) {
          const icon = fileIcon(n.name);
          return (
            <div
              key={n.path}
              className={`prv-file-item${activeFile === n.path ? " active" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onSelectFile(n.path)}
              title={n.path}
            >
              <span className="prv-file-icon" style={{ color: icon.color }}>{icon.label}</span>
              <span className="prv-file-name">{n.name}</span>
            </div>
          );
        }
        const isCollapsed = collapsed.has(n.path);
        return (
          <div key={n.path}>
            <div
              className="prv-folder-item"
              style={{ paddingLeft: 4 + depth * 14 }}
              onClick={() => onToggleFolder(n.path)}
              title={n.path}
            >
              <span className={`prv-folder-caret${isCollapsed ? "" : " open"}`}>▸</span>
              <FolderIcon />
              <span className="prv-file-name">{n.name}</span>
            </div>
            {!isCollapsed && (
              <FileTree
                nodes={n.children}
                depth={depth + 1}
                activeFile={activeFile}
                collapsed={collapsed}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
              />
            )}
          </div>
        );
      })}
    </>
  );
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
  return files.map((f) => ({ ...f, lineRefs: computeLineNumbers(f.lines) }));
}

function NewWindowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.38 8.5 8.5 0 0 1-4-.94L3 20l1.06-5.5a8.38 8.38 0 0 1-.56-3 8.5 8.5 0 0 1 17-.06z" />
    </svg>
  );
}

// Same anchored-to-the-far-edge drag pattern as FilelistDivider, mirrored:
// the comments sidebar is pinned to the RIGHT edge, so dragging left grows it.
function CommentsSidebarDivider({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const startXRef = useRef<number | null>(null);
  const startWidthRef = useRef<number>(width);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = width;

    const onMouseMove = (ev: MouseEvent) => {
      if (startXRef.current === null) return;
      const delta = startXRef.current - ev.clientX;
      const next = Math.max(280, startWidthRef.current + delta);
      onChange(next);
    };
    const onMouseUp = () => {
      startXRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  return <div className="prv-comments-divider" onMouseDown={onMouseDown} />;
}

export function PrReviewView({ repo, number, standalone, onCloseTab }: { repo: string; number: number; standalone?: boolean; onCloseTab?: () => void }) {
  const [title, setTitle] = useState<string | null>(null);
  const [prBody, setPrBody] = useState<string>("");
  const [reviewers, setReviewers] = useState<{ login: string; state: string }[]>([]);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [diffFiles, setDiffFiles] = useState<FileDiff[] | null>(null);
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftComment[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [filelistWidth, setFilelistWidth] = useState(220);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [prComments, setPrComments] = useState<ReviewComment[]>([]);
  const [commentsSidebarOpen, setCommentsSidebarOpen] = useState(false);
  const [commentsSidebarWidth, setCommentsSidebarWidth] = useState(380);
  const [newCommentBody, setNewCommentBody] = useState("");
  const [postingComment, setPostingComment] = useState(false);

  const load = useCallback(() => {
    setError(null);
    invoke<{ title: string; body: string; reviewers: { login: string; state: string }[] }>("get_pr_details", { repo, number })
      .then((d) => { setTitle(d.title); setPrBody(d.body); setReviewers(d.reviewers); })
      .catch(() => {});
    invoke<string>("get_pr_diff", { repo, number })
      .then((raw) => {
        const files = splitIntoFiles(raw);
        setDiffFiles(files);
        setActiveFile((prev) => prev ?? files[0]?.path ?? null);
      })
      .catch((e) => setError(String(e)));
    invoke<ReviewThread[]>("get_pr_review_threads", { repo, number })
      .then(setThreads)
      .catch((e) => setError(String(e)));
    invoke<ReviewComment[]>("get_pr_comments", { repo, number })
      .then(setPrComments)
      .catch((e) => setError(String(e)));
  }, [repo, number]);

  useEffect(() => { load(); }, [load]);

  const selectFile = (path: string) => {
    setActiveFile(path);
    bodyRef.current?.scrollTo({ top: 0 });
  };

  const toggleFolder = (path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const fileTree = useMemo(() => buildFileTree((diffFiles ?? []).map((f) => f.path)), [diffFiles]);

  const threadsByLine = useMemo(() => {
    const m = new Map<string, ReviewThread[]>();
    for (const t of threads) {
      if (t.line == null) continue;
      const key = `${t.path}:${t.side}:${t.line}`;
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

  const addDraft = (path: string, ref: LineRef) => {
    setDrafts((prev) => [...prev, { path, line: ref.line, side: ref.side, body: "" }]);
  };
  const updateDraft = (idx: number, body: string) => {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, body } : d)));
  };
  const removeDraft = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
  };

  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  // Threads collapse by default once resolved, expanded otherwise. `threadCollapseOverrides`
  // holds only the threads where the user manually clicked the opposite of that default —
  // a resolve/unresolve action clears its override so the default takes over again.
  const [threadCollapseOverrides, setThreadCollapseOverrides] = useState<Record<string, boolean>>({});
  const isThreadCollapsed = (t: ReviewThread) => threadCollapseOverrides[t.id] ?? t.isResolved;
  const toggleThreadCollapse = (t: ReviewThread) => {
    setThreadCollapseOverrides((prev) => ({ ...prev, [t.id]: !isThreadCollapsed(t) }));
  };
  const clearThreadCollapseOverride = (threadId: string) => {
    setThreadCollapseOverrides((prev) => {
      if (!(threadId in prev)) return prev;
      const next = { ...prev };
      delete next[threadId];
      return next;
    });
  };

  const resolveThread = async (threadId: string) => {
    setResolvingIds((prev) => new Set(prev).add(threadId));
    try {
      await invoke("resolve_review_thread", { threadId });
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, isResolved: true } : t)));
      clearThreadCollapseOverride(threadId);
    } catch (e) {
      setError(String(e));
    } finally {
      setResolvingIds((prev) => { const next = new Set(prev); next.delete(threadId); return next; });
    }
  };
  const unresolveThread = async (threadId: string) => {
    setResolvingIds((prev) => new Set(prev).add(threadId));
    try {
      await invoke("unresolve_review_thread", { threadId });
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, isResolved: false } : t)));
      clearThreadCollapseOverride(threadId);
    } catch (e) {
      setError(String(e));
    } finally {
      setResolvingIds((prev) => { const next = new Set(prev); next.delete(threadId); return next; });
    }
  };

  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyingIds, setReplyingIds] = useState<Set<string>>(new Set());
  const submitReply = async (threadId: string) => {
    const body = (replyDrafts[threadId] ?? "").trim();
    if (!body) return;
    setReplyingIds((prev) => new Set(prev).add(threadId));
    try {
      const comment = await invoke<ReviewComment>("reply_to_review_thread", { threadId, body });
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, comments: [...t.comments, comment] } : t)));
      setReplyDrafts((prev) => ({ ...prev, [threadId]: "" }));
    } catch (e) {
      setError(String(e));
    } finally {
      setReplyingIds((prev) => { const next = new Set(prev); next.delete(threadId); return next; });
    }
  };

  const postComment = async () => {
    const body = newCommentBody.trim();
    if (!body) return;
    setPostingComment(true);
    try {
      const comment = await invoke<ReviewComment>("add_pr_comment", { repo, number, body });
      setPrComments((prev) => [...prev, comment]);
      setNewCommentBody("");
    } catch (e) {
      setError(String(e));
    } finally {
      setPostingComment(false);
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
        if (d.body.trim()) await invoke("add_review_comment", { reviewId: id, path: d.path, line: d.line, side: d.side, body: d.body });
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
          <span className="t">{title ?? `PR #${number}`}{title && <span className="prv-num">#{number}</span>}</span>
          <button
            type="button"
            className="prv-details-toggle"
            title={detailsExpanded ? "Hide PR description" : "View PR description"}
            onClick={() => setDetailsExpanded((v) => !v)}
          >
            <span className="thread-caret">{detailsExpanded ? "▾" : "▸"}</span> Details
          </button>
          {!standalone && (
            <button
              type="button"
              className="prv-icobtn"
              title="Show PR in new window"
              onClick={() => { invoke("open_pr_review_window", { repo, number }); onCloseTab?.(); }}
            >
              <NewWindowIcon />
            </button>
          )}
          <button
            type="button"
            className="prv-icobtn prv-icobtn-badge"
            title={commentsSidebarOpen ? "Hide comments outside the diff" : "Show comments outside the diff"}
            onClick={() => setCommentsSidebarOpen((v) => !v)}
          >
            <MessageIcon />
            {prComments.length > 0 && <span className="prv-badge">{prComments.length > 99 ? "99+" : prComments.length}</span>}
          </button>
          <button
            type="button"
            className="prv-icobtn"
            title="Show PR in GitHub"
            onClick={() => invoke("open_path", { path: `https://github.com/${repo}/pull/${number}` })}
          >
            <GithubIcon />
          </button>
        </div>
        {detailsExpanded && (
          <div className="prv-details-body">
            {prBody.trim() ? <CommentBody body={prBody} /> : <span className="gh-muted">No description provided.</span>}
          </div>
        )}
        {error && <div className="prv-error" onClick={() => setError(null)}>{error}</div>}
      </div>
      <div className="prv-content">
        <div className="prv-filelist" style={{ width: filelistWidth, flex: `0 0 ${filelistWidth}px` }}>
          <FileTree
            nodes={fileTree}
            depth={0}
            activeFile={activeFile}
            collapsed={collapsedFolders}
            onToggleFolder={toggleFolder}
            onSelectFile={selectFile}
          />
          <FilelistDivider width={filelistWidth} onChange={setFilelistWidth} />
        </div>
        <div className="prv-body" ref={bodyRef}>
        {(() => {
          const f = diffFiles.find((d) => d.path === activeFile) ?? diffFiles[0];
          if (!f) return <div className="prv-empty">No files changed.</div>;
          return (
          <div className="diff-file" key={f.path}>
            <div className="diff-fh">{f.path}</div>
            {f.lines.map((line, i) => {
              // Raw diff-header metadata (`diff --git`, `index …`, `--- /+++ `)
              // is redundant with the file-header row above — skip it.
              if (line.kind === "meta") return null;
              if (line.kind === "hunk") {
                return <div key={i} className="diff-line diff-hunk">{line.text}</div>;
              }
              const lineRef = f.lineRefs[i];
              const commentable = lineRef != null;
              const lineMatches = lineRef ? (threadsByLine.get(`${f.path}:${lineRef.side}:${lineRef.line}`) ?? []) : [];
              return (
                <div key={i} className="diff-line-wrap">
                  <div className={`diff-line diff-${line.kind}`} onClick={() => lineRef && addDraft(f.path, lineRef)}>
                    <span className="diff-gutter">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
                    <span className="diff-content">{(() => {
                      const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
                      return line.text.startsWith(prefix) ? line.text.slice(1) : line.text;
                    })()}</span>
                    {commentable && (
                      <span className="diff-addc" onClick={(e) => { e.stopPropagation(); addDraft(f.path, lineRef); }}>+</span>
                    )}
                  </div>
                  {lineMatches.map((t) => {
                    const collapsed = isThreadCollapsed(t);
                    return (
                    <div className={`thread${t.isResolved ? " resolved" : ""}`} key={t.id}>
                      <div className="thread-h" onClick={() => toggleThreadCollapse(t)} style={{ cursor: "pointer" }}>
                        <span className="thread-caret">{collapsed ? "▸" : "▾"}</span>
                        <span>{t.comments.length} comment{t.comments.length === 1 ? "" : "s"}</span>
                        {t.isResolved && <span className="resolved-tag">✓ Resolved</span>}
                        <button
                          className="rs"
                          disabled={resolvingIds.has(t.id)}
                          onClick={(e) => { e.stopPropagation(); t.isResolved ? unresolveThread(t.id) : resolveThread(t.id); }}
                        >
                          {resolvingIds.has(t.id) ? "…" : t.isResolved ? "Unresolve" : "Resolve"}
                        </button>
                      </div>
                      {!collapsed && (
                        <>
                          {t.comments.map((c) => (
                            <div className="cmt" key={c.id}>
                              <div><b style={{ color: authorColor(c.author) }}>{c.author}</b> <span className="when" title={c.createdAt}>{relTime(c.createdAt)}</span><div className="body2"><CommentBody body={c.body} /></div></div>
                            </div>
                          ))}
                          <div className="thread-reply">
                            <input
                              value={replyDrafts[t.id] ?? ""}
                              onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === "Enter") submitReply(t.id); }}
                              placeholder="Reply…"
                            />
                            <button disabled={replyingIds.has(t.id) || !(replyDrafts[t.id] ?? "").trim()} onClick={() => submitReply(t.id)}>
                              {replyingIds.has(t.id) ? "…" : "Reply"}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                    );
                  })}
                  {drafts.map((d, di) => (lineRef && d.path === f.path && d.line === lineRef.line && d.side === lineRef.side) ? (
                    <div className="draft-note" key={di}>
                      <textarea value={d.body} onChange={(e) => updateDraft(di, e.target.value)} placeholder="Pending comment…" />
                      <button onClick={() => removeDraft(di)}>Remove</button>
                    </div>
                  ) : null)}
                </div>
              );
            })}
          </div>
          );
        })()}
        </div>
        {commentsSidebarOpen && (
          <div className="prv-comments-sidebar" style={{ width: commentsSidebarWidth }}>
            <CommentsSidebarDivider width={commentsSidebarWidth} onChange={setCommentsSidebarWidth} />
            <div className="prv-comments-head">
              <span>{prComments.length} comment{prComments.length === 1 ? "" : "s"} outside the diff</span>
              <button type="button" className="prv-icobtn" title="Close" onClick={() => setCommentsSidebarOpen(false)}>✕</button>
            </div>
            <div className="prv-comments-list">
              {prComments.length === 0 && <div className="gh-placeholder">No conversation comments yet.</div>}
              {prComments.map((c) => (
                <div className="cmt" key={c.id}>
                  <div>
                    <b style={{ color: authorColor(c.author) }}>{c.author}</b>{" "}
                    <span className="when" title={c.createdAt}>{relTime(c.createdAt)}</span>
                    <div className="body2"><CommentBody body={c.body} /></div>
                  </div>
                </div>
              ))}
            </div>
            <div className="prv-comments-compose">
              <textarea
                value={newCommentBody}
                onChange={(e) => setNewCommentBody(e.target.value)}
                placeholder="Add a comment…"
              />
              <button className="btn-primary" disabled={postingComment || !newCommentBody.trim()} onClick={postComment}>
                {postingComment ? "Posting…" : "Comment"}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="prv-bar">
        <div className="prv-bar-left">
          <span className="cnt2">{drafts.length} pending comment{drafts.length === 1 ? "" : "s"}</span>
          {reviewers.map((r) => (
            <span key={r.login} className={`prv-review-chip ${r.state === "APPROVED" ? "ok" : "req"}`} title={`${r.login}: ${r.state === "APPROVED" ? "Approved" : "Changes requested"}`}>
              {r.state === "APPROVED" ? "✓" : "✕"} {r.login}
            </span>
          ))}
        </div>
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
