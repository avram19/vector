import { useEffect, useMemo, useRef, useState } from "react";

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/// A compact searchable dropdown (combobox) for picking a repo to filter the PR
/// inbox by. Type to filter, ↑/↓ to move, Enter to choose, Esc / click-outside
/// to close. When a repo is selected the trigger shows a ✕ to clear in place.
export function RepoFilterDropdown({ value, options, onChange }: {
  value: string | null;
  options: string[];
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc, true);
    return () => document.removeEventListener("mousedown", onDoc, true);
  }, [open]);

  useEffect(() => {
    if (open) { setQuery(""); setHighlight(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  }, [query, options]);

  // null = "All repos" at the top of the list.
  const items = useMemo<(string | null)[]>(() => [null, ...filtered], [filtered]);

  useEffect(() => { setHighlight(0); }, [query]);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [highlight, open]);

  const select = (v: string | null) => { onChange(v); setOpen(false); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); select(items[highlight] ?? null); }
  };

  return (
    <div className="gh-combo" ref={ref}>
      <button className="gh-combo-trigger" onClick={() => setOpen((v) => !v)} title={value ?? "All repos"}>
        <span className={`gh-combo-val${value ? "" : " placeholder"}`}>{value ?? "All repos"}</span>
        {value ? (
          <span
            className="gh-combo-clear"
            title="Clear repo filter"
            onClick={(e) => { e.stopPropagation(); onChange(null); }}
          >✕</span>
        ) : (
          <span className="gh-combo-caret"><Chevron /></span>
        )}
      </button>
      {open && (
        <div className="gh-combo-pop">
          <input
            ref={inputRef}
            className="gh-combo-search"
            placeholder="Search repos…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="gh-combo-list">
            {items.map((o, i) => (
              <button
                key={o ?? "__all__"}
                ref={i === highlight ? activeRef : null}
                className={`gh-combo-opt${value === o ? " sel" : ""}${i === highlight ? " active" : ""}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => select(o)}
                title={o ?? "All repos"}
              >
                {o ?? "All repos"}
              </button>
            ))}
            {filtered.length === 0 && <div className="gh-combo-empty">No matching repos</div>}
          </div>
        </div>
      )}
    </div>
  );
}
