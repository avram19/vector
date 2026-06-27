import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RepoFilterDropdown } from "./RepoFilterDropdown";

export type Workflow = { id: number; name: string; path: string; state: string };
export type Step = { name: string; status: string; conclusion: string | null; number: number };
export type Job = { id: number; name: string; status: string; conclusion: string | null; startedAt: string | null; completedAt: string | null; steps: Step[] };
export type Run = {
  id: number; runNumber: number; workflowId: number; workflowName: string;
  status: string; conclusion: string | null; branch: string; event: string;
  actor: string; headSha: string; createdAt: string; repo: string;
};

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

function StatusGlyph({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status !== "completed") return <span className="gh-run-spin" title={status} />;
  if (conclusion === "success") return <span className="gh-run-ico ok" title="success">✔</span>;
  if (conclusion === "failure" || conclusion === "timed_out") return <span className="gh-run-ico bad" title={conclusion}>✖</span>;
  if (conclusion === "cancelled") return <span className="gh-run-ico dim" title="cancelled">⊘</span>;
  return <span className="gh-run-ico dim" title={conclusion ?? "done"}>•</span>;
}

function favKey(repo: string, path: string) { return `${repo}:${path.split("/").pop()}`; }

export function ActionsView({ favorites, onFavorites, onOpenPreview }: {
  favorites: string[];
  onFavorites: (next: string[]) => void;
  onOpenPreview: (path: string, line: number | undefined, col: number | undefined, opts: { pin: boolean }) => void;
}) {
  const [favRuns, setFavRuns] = useState<Run[] | null>(null);
  const [allRepos, setAllRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [runsByWf, setRunsByWf] = useState<Record<number, Run[]>>({});
  const [jobsByRun, setJobsByRun] = useState<Record<number, Job[]>>({});
  const [openWf, setOpenWf] = useState<number | null>(null);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFavRuns = useCallback(() => {
    if (favorites.length === 0) { setFavRuns([]); return; }
    invoke<Run[]>("list_github_favorite_runs", { favorites }).then(setFavRuns).catch((e) => setError(String(e)));
  }, [favorites]);

  useEffect(() => { loadFavRuns(); }, [loadFavRuns]);

  useEffect(() => {
    invoke<{ nameWithOwner: string }[]>("get_cached_github_repos")
      .then((rs) => setAllRepos(rs.map((r) => r.nameWithOwner)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!repo) { setWorkflows(null); return; }
    setWorkflows(null); setRunsByWf({}); setOpenWf(null); setJobsByRun({}); setOpenRun(null);
    invoke<Workflow[]>("list_github_workflows", { repo }).then(setWorkflows).catch((e) => setError(String(e)));
  }, [repo]);

  const toggleWf = (wf: Workflow) => {
    if (openWf === wf.id) { setOpenWf(null); return; }
    setOpenWf(wf.id);
    if (!runsByWf[wf.id] && repo) {
      invoke<Run[]>("list_github_runs", { repo, workflow: String(wf.id), perPage: 15 })
        .then((rs) => setRunsByWf((m) => ({ ...m, [wf.id]: rs })))
        .catch((e) => setError(String(e)));
    }
  };

  const toggleRun = (run: Run) => {
    if (openRun === run.id) { setOpenRun(null); return; }
    setOpenRun(run.id);
    if (!jobsByRun[run.id]) {
      invoke<Job[]>("list_github_jobs", { repo: run.repo, runId: run.id })
        .then((js) => setJobsByRun((m) => ({ ...m, [run.id]: js })))
        .catch((e) => setError(String(e)));
    }
  };

  const openLog = (run: Run, job: Job) => {
    invoke<string>("get_github_job_log", { repo: run.repo, jobId: job.id })
      .then((path) => onOpenPreview(path, undefined, undefined, { pin: false }))
      .catch((e) => setError(`Log not available yet: ${e}`));
  };

  const isFav = (repo: string, path: string) => favorites.includes(favKey(repo, path));
  const toggleFav = (repo: string, path: string) => {
    const k = favKey(repo, path);
    onFavorites(favorites.includes(k) ? favorites.filter((x) => x !== k) : [...favorites, k]);
  };

  const repoOptions = useMemo(() => [...allRepos].sort(), [allRepos]);

  return (
    <div className="gh-actions">
      {error && <div className="gh-actions-err" onClick={() => setError(null)}>{error}</div>}

      <div className="gh-act-section">
        <div className="gh-act-h"><span className="gh-star">★</span> Favorited workflows</div>
        {favRuns === null && <div className="gh-placeholder">Loading…</div>}
        {favRuns !== null && favRuns.length === 0 && <div className="gh-placeholder">Star a workflow below to track it here.</div>}
        {favRuns?.map((r) => (
          <div className="gh-run" key={`${r.repo}-${r.id}`} onClick={() => { setRepo(r.repo); }}>
            <StatusGlyph status={r.status} conclusion={r.conclusion} />
            <div className="gh-run-main">
              <div className="gh-run-l1"><span className="gh-run-wf">{r.workflowName}</span> <span className="gh-run-n">#{r.runNumber}</span></div>
              <div className="gh-run-l2"><span className="gh-run-repo">{r.repo}</span> · <span className="gh-run-branch">{r.branch}</span> · {r.event} · {relTime(r.createdAt)}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="gh-act-section">
        <div className="gh-act-h">Repository</div>
        <div className="gh-pr-repofilter">
          <RepoFilterDropdown value={repo} options={repoOptions} onChange={setRepo} />
        </div>
        {repo && workflows === null && <div className="gh-placeholder">Loading workflows…</div>}
        {workflows?.length === 0 && <div className="gh-placeholder">No workflows.</div>}
        {workflows?.map((wf) => (
          <div className="gh-wf" key={wf.id}>
            <div className="gh-wf-h" onClick={() => toggleWf(wf)}>
              <span className="gh-caret">{openWf === wf.id ? "▾" : "▸"}</span>
              <span className="gh-wf-name">{wf.name}</span>
              <span
                className="gh-pin"
                title={isFav(repo!, wf.path) ? "Unfavorite" : "Favorite"}
                onClick={(e) => { e.stopPropagation(); toggleFav(repo!, wf.path); }}
              >{isFav(repo!, wf.path) ? "★" : "☆"}</span>
            </div>
            {openWf === wf.id && (runsByWf[wf.id] ?? []).map((run) => (
              <div className="gh-run-wrap" key={run.id}>
                <div className="gh-run" onClick={() => toggleRun(run)}>
                  <span className="gh-caret">{openRun === run.id ? "▾" : "▸"}</span>
                  <StatusGlyph status={run.status} conclusion={run.conclusion} />
                  <div className="gh-run-main">
                    <div className="gh-run-l1"><span className="gh-run-n">#{run.runNumber}</span> <span className="gh-run-branch">{run.branch}</span></div>
                    <div className="gh-run-l2">{run.event} · {run.actor} · {relTime(run.createdAt)}</div>
                  </div>
                </div>
                {openRun === run.id && (jobsByRun[run.id] ?? []).map((job) => (
                  <div className="gh-job" key={job.id}>
                    <StatusGlyph status={job.status} conclusion={job.conclusion} />
                    <span className="gh-job-name">{job.name}</span>
                    {job.status === "completed" ? (
                      <button className="gh-job-log" onClick={() => openLog(run, job)}>Logs</button>
                    ) : (
                      <span className="gh-job-running">running…</span>
                    )}
                  </div>
                ))}
                {openRun === run.id && !jobsByRun[run.id] && <div className="gh-placeholder">Loading jobs…</div>}
              </div>
            ))}
            {openWf === wf.id && !runsByWf[wf.id] && <div className="gh-placeholder">Loading runs…</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
