import { useEffect, useMemo, useRef, useState } from "react";

/// A compact searchable dropdown (combobox) for picking a repo to filter the PR
/// inbox by. Replaces the native <select>: type to filter, click to choose,
/// Escape / click-outside to close.
export function RepoFilterDropdown({ value, options, onChange }: {
  value: string | null;
  options: string[];
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc, true);
    return () => document.removeEventListener("mousedown", onDoc, true);
  }, [open]);

  useEffect(() => {
    if (open) { setQuery(""); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  }, [query, options]);

  const select = (v: string | null) => { onChange(v); setOpen(false); };

  return (
    <div className="gh-combo" ref={ref}>
      <button className="gh-combo-trigger" onClick={() => setOpen((v) => !v)} title={value ?? "All repos"}>
        <span className={`gh-combo-val${value ? "" : " placeholder"}`}>{value ?? "All repos"}</span>
        <span className="gh-combo-caret">▾</span>
      </button>
      {open && (
        <div className="gh-combo-pop">
          <input
            ref={inputRef}
            className="gh-combo-search"
            placeholder="Search repos…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter" && filtered.length) select(filtered[0]);
            }}
          />
          <div className="gh-combo-list">
            <button className={`gh-combo-opt${value === null ? " sel" : ""}`} onClick={() => select(null)}>
              All repos
            </button>
            {filtered.map((o) => (
              <button key={o} className={`gh-combo-opt${value === o ? " sel" : ""}`} onClick={() => select(o)} title={o}>
                {o}
              </button>
            ))}
            {filtered.length === 0 && <div className="gh-combo-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}
