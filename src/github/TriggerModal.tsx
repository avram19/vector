import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Workflow } from "./ActionsView";
import { useEscapeToClose } from "../useEscapeToClose";

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
  useEscapeToClose(onClose);
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
            {inputs?.filter((i) => i.type !== "boolean").map((i) => (
              <label className="gh-field" key={i.name}>
                <span>{i.name}{i.required ? " *" : ""}{i.description ? ` — ${i.description}` : ""}</span>
                {i.type === "choice" && i.options.length ? (
                  <select value={values[i.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))}>
                    {i.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input value={values[i.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))} autoComplete="off" spellCheck={false} />
                )}
              </label>
            ))}
            {(() => {
              const booleans = (inputs ?? []).filter((i) => i.type === "boolean");
              if (!booleans.length) return null;
              const on = booleans.filter((b) => values[b.name] === "true").length;
              return (
                <div className="gh-field">
                  <span>Toggles ({on}/{booleans.length} on)</span>
                  <BooleanMultiSelect
                    items={booleans}
                    values={values}
                    onToggle={(name, isOn) => setValues((v) => ({ ...v, [name]: isOn ? "true" : "false" }))}
                  />
                </div>
              );
            })()}
            <button className="gh-modal-run" disabled={!wf || busy} onClick={run}>{busy ? "Running…" : "Run workflow"}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/// Groups many boolean workflow inputs into one searchable multi-select
/// (checked = "true"), instead of a column of true/false dropdowns.
function BooleanMultiSelect({ items, values, onToggle }: {
  items: DispatchInput[];
  values: Record<string, string>;
  onToggle: (name: string, on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [coords, setCoords] = useState<{ left: number; top: number; width: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc, true);
    return () => document.removeEventListener("mousedown", onDoc, true);
  }, [open]);

  // Anchor the popover with position:fixed so it escapes the modal's overflow.
  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setCoords({ left: r.left, top: r.bottom + 4, width: r.width });
    setOpen(true);
  };

  const selected = items.filter((i) => values[i.name] === "true").length;
  const ql = q.trim().toLowerCase();
  const filtered = ql ? items.filter((i) => i.name.toLowerCase().includes(ql) || (i.description ?? "").toLowerCase().includes(ql)) : items;

  return (
    <div className="gh-combo" ref={ref}>
      <button type="button" ref={btnRef} className="gh-combo-trigger" onClick={toggle}>
        <span className={`gh-combo-val${selected ? "" : " placeholder"}`}>{selected ? `${selected} selected` : "None selected"}</span>
        <span className="gh-combo-caret"><Chevron /></span>
      </button>
      {open && (
        <div className="gh-combo-pop gh-combo-pop--fixed" style={{ left: coords?.left, top: coords?.top, width: coords?.width }}>
          <input className="gh-combo-search" placeholder="Search options…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} />
          <div className="gh-combo-list">
            {filtered.map((i) => (
              <label key={i.name} className="gh-ms-opt" title={i.description ?? i.name}>
                <input type="checkbox" checked={values[i.name] === "true"} onChange={(e) => onToggle(i.name, e.target.checked)} />
                <span>{i.name}{i.description ? ` — ${i.description}` : ""}</span>
              </label>
            ))}
            {filtered.length === 0 && <div className="gh-combo-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}
