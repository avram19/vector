import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Workflow } from "./ActionsView";

export type DispatchInput = {
  name: string; description: string | null; required: boolean;
  type: string; default: string | null; options: string[];
};

export function TriggerModal({ repo, presetRef, presetWorkflowId, onClose }: {
  repo: string;
  presetRef?: string;
  presetWorkflowId?: number;
  onClose: () => void;
}) {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [wfId, setWfId] = useState<number | null>(presetWorkflowId ?? null);
  const [inputs, setInputs] = useState<DispatchInput[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [gitRef, setGitRef] = useState(presetRef ?? "");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Workflow[]>("list_github_workflows", { repo })
      .then(setWorkflows)
      .catch((e) => setError(String(e)));
  }, [repo]);

  const wf = useMemo(() => workflows?.find((w) => w.id === wfId) ?? null, [workflows, wfId]);

  useEffect(() => {
    if (!wf) { setInputs(null); return; }
    setInputs(null);
    invoke<DispatchInput[]>("github_workflow_inputs", { repo, path: wf.path })
      .then((ins) => {
        setInputs(ins);
        const init: Record<string, string> = {};
        ins.forEach((i) => { init[i.name] = i.default ?? (i.type === "boolean" ? "false" : ""); });
        setValues(init);
      })
      .catch((e) => setError(String(e)));
  }, [wf?.id, repo]);

  const run = () => {
    if (!wf) return;
    const ref = gitRef.trim();
    if (!ref) { setError("Enter a branch/ref to run on."); return; }
    setBusy(true); setError(null);
    const tuples = (inputs ?? []).map((i) => [i.name, values[i.name] ?? ""] as [string, string]);
    invoke("github_dispatch", { repo, workflow: String(wf.id), gitRef: ref, inputs: tuples })
      .then(() => {
        const summary = tuples.length ? ` — ${tuples.map(([k, v]) => `${k}=${v}`).join(", ")}` : "";
        setDone(`Dispatched ${wf.name} on ${ref}${summary}`);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="gh-modal-backdrop" onClick={onClose}>
      <div className="gh-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gh-modal-h">
          <span>Run workflow — {repo}</span>
          <button className="gh-icobtn" onClick={onClose} title="Close">✕</button>
        </div>
        {done ? (
          <div className="gh-modal-body">
            <p className="gh-modal-ok">✓ {done}</p>
            <button className="gh-modal-run" onClick={onClose}>Close</button>
          </div>
        ) : (
          <div className="gh-modal-body">
            {error && <div className="gh-actions-err">{error}</div>}
            <label className="gh-field">
              <span>Workflow</span>
              <select value={wfId ?? ""} onChange={(e) => setWfId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Select a workflow…</option>
                {workflows?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="gh-field">
              <span>Branch / ref</span>
              <input value={gitRef} onChange={(e) => setGitRef(e.target.value)} placeholder="main" autoComplete="off" spellCheck={false} />
            </label>
            {wf && inputs === null && <div className="gh-placeholder">Loading inputs…</div>}
            {inputs?.map((i) => (
              <label className="gh-field" key={i.name}>
                <span>{i.name}{i.required ? " *" : ""}{i.description ? ` — ${i.description}` : ""}</span>
                {i.type === "boolean" ? (
                  <select value={values[i.name] ?? "false"} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}>
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                ) : i.type === "choice" && i.options.length ? (
                  <select value={values[i.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}>
                    {i.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input value={values[i.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))} autoComplete="off" spellCheck={false} />
                )}
              </label>
            ))}
            <button className="gh-modal-run" disabled={!wf || busy} onClick={run}>{busy ? "Running…" : "Run workflow"}</button>
          </div>
        )}
      </div>
    </div>
  );
}
