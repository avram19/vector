import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Terminal, ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import logoUrl from "./logo.png";

type AgentMeta = { id: string; label: string; available: boolean };
type Tab = { id: string; agentId: string; cwd: string; epoch: number };
type Theme = "dark" | "light";
type Orientation = "horizontal" | "vertical";
type PickerState = { open: boolean; forTabId?: string };

const darkTheme: ITheme = { background: "#0b0b0f", foreground: "#e6e6e6", cursor: "#e6e6e6" };
// Solarized Light: easy on the eyes
const lightTheme: ITheme = {
  background: "#fdf6e3",
  foreground: "#586e75",
  cursor: "#586e75",
  black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
  blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
  brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
  brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
};

const AGENT_COLORS: Record<string, string> = {
  claude: "#ff8a4c",
  codex: "#10a37f",
  cursor: "#6a8dff",
  copilot: "#7c5bf6",
  aider: "#ffc857",
  __shell__: "#8a8aa0",
};

const RECENTS_KEY = "vector.recents";
const MAX_RECENTS = 8;

function loadPref<T extends string>(key: string, fallback: T): T {
  try { return (localStorage.getItem(key) as T) || fallback; } catch { return fallback; }
}
function loadRecents(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]"); } catch { return []; }
}
function saveRecents(list: string[]) {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS))); } catch {}
}
function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}
function agentColor(id: string): string {
  return AGENT_COLORS[id] ?? "#8a8aa0";
}

function AgentIcon({ id, size = 14 }: { id: string; size?: number }) {
  const color = agentColor(id);
  const common = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true as const };
  switch (id) {
    case "claude":
      // sparkle / 4-point star (Anthropic-ish)
      return (
        <svg {...common}><path d="M12 2 L13.8 10.2 L22 12 L13.8 13.8 L12 22 L10.2 13.8 L2 12 L10.2 10.2 Z" fill={color} /></svg>
      );
    case "codex":
      // hexagon rosette (OpenAI-ish)
      return (
        <svg {...common} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12,2 21,7 21,17 12,22 3,17 3,7" />
          <path d="M12 7 L17 10 L17 14 L12 17 L7 14 L7 10 Z" />
        </svg>
      );
    case "cursor":
      // arrow cursor
      return (
        <svg {...common} fill={color}><path d="M5 3 L19 13 L12 13.5 L14.5 20 L12 21 L9 14.5 L4 17 Z" /></svg>
      );
    case "copilot":
      // infinity mark
      return (
        <svg {...common} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
          <path d="M7 12 C7 8.5 9 7 11 9 L13 15 C15 17 17 15.5 17 12 C17 8.5 15 7 13 9 L11 15 C9 17 7 15.5 7 12 Z" />
        </svg>
      );
    case "aider":
      // stylized A
      return (
        <svg {...common} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 20 L12 4 L20 20" />
          <path d="M7 14 L17 14" />
        </svg>
      );
    case "__shell__":
      // terminal prompt ">_"
      return (
        <svg {...common} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 7 L10 12 L5 17" />
          <path d="M13 18 L19 18" />
        </svg>
      );
    default:
      // fallback: filled circle with first letter
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" fill={color} />
          <text x="12" y="16" textAnchor="middle" fontSize="13" fontWeight="700" fill="#0b0b0f" fontFamily="ui-monospace, Menlo, monospace">
            {(id[0] ?? "?").toUpperCase()}
          </text>
        </svg>
      );
  }
}

async function ensureNotifPermission() {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    return granted;
  } catch { return false; }
}

export default function App() {
  const [agents, setAgents] = useState<AgentMeta[]>([]);
  const [defaultAgent, setDefaultAgent] = useState<string>("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [theme, setTheme] = useState<Theme>(() => loadPref<Theme>("vector.theme", "dark"));
  const [orientation, setOrientation] = useState<Orientation>(() => loadPref<Orientation>("vector.orientation", "horizontal"));
  const [bellTabs, setBellTabs] = useState<Set<string>>(new Set());
  const [tabTitles, setTabTitles] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [picker, setPicker] = useState<PickerState>({ open: true });
  const [recents, setRecents] = useState<string[]>([]);
  const notifReady = useRef(false);

  useEffect(() => { document.body.className = theme === "light" ? "theme-light" : "theme-dark"; try { localStorage.setItem("vector.theme", theme); } catch {} }, [theme]);
  useEffect(() => { try { localStorage.setItem("vector.orientation", orientation); } catch {} }, [orientation]);

  useEffect(() => {
    (async () => {
      const [list, def] = await Promise.all([
        invoke<AgentMeta[]>("list_agents"),
        invoke<string>("default_agent"),
      ]);
      setAgents(list);
      const defAvailable = list.some((a) => a.id === def && a.available);
      const firstInstalled = list.find((a) => a.available)?.id;
      setDefaultAgent(defAvailable ? def : (firstInstalled ?? "__shell__"));
      setRecents(loadRecents());
      notifReady.current = await ensureNotifPermission();
    })();
  }, []);

  const pushRecent = useCallback((path: string) => {
    setRecents((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, MAX_RECENTS);
      saveRecents(next);
      return next;
    });
  }, []);

  const openPickerForNewTab = useCallback(() => setPicker({ open: true }), []);
  const openPickerForTab = useCallback((tabId: string) => setPicker({ open: true, forTabId: tabId }), []);
  const closePicker = useCallback(() => {
    setPicker((p) => ({ ...p, open: false }));
  }, []);

  const applyPick = useCallback((path: string) => {
    pushRecent(path);
    setPicker((p) => {
      if (p.forTabId) {
        const id = p.forTabId;
        setTabs((prev) => prev.map((t) => t.id === id ? { ...t, cwd: path, epoch: t.epoch + 1 } : t));
      } else {
        const t: Tab = { id: crypto.randomUUID(), agentId: defaultAgent, cwd: path, epoch: 0 };
        setTabs((prev) => [...prev, t]);
        setActiveId(t.id);
      }
      return { open: false };
    });
  }, [defaultAgent, pushRecent]);

  const pickFolder = useCallback(async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === "string") applyPick(selected);
    } catch {}
  }, [applyPick]);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (id === activeId && next.length) setActiveId(next[next.length - 1].id);
      if (!next.length) setPicker({ open: true });
      return next;
    });
    setBellTabs((b) => { const n = new Set(b); n.delete(id); return n; });
    setTabTitles((m) => { if (!(id in m)) return m; const n = { ...m }; delete n[id]; return n; });
  }, [activeId]);

  const reloadActive = useCallback(() => {
    setTabs((prev) => prev.map((t) => t.id === activeId ? { ...t, epoch: t.epoch + 1 } : t));
  }, [activeId]);

  const changeActiveAgent = useCallback((agentId: string) => {
    setTabs((prev) => prev.map((t) => t.id === activeId ? { ...t, agentId, epoch: t.epoch + 1 } : t));
  }, [activeId]);

  const onTitle = useCallback((tabId: string, title: string) => {
    setTabTitles((m) => (m[tabId] === title ? m : { ...m, [tabId]: title }));
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setBellTabs((b) => { if (!b.has(activeId)) return b; const n = new Set(b); n.delete(activeId); return n; });
  }, [activeId]);

  const onBell = useCallback((tabId: string) => {
    const windowFocused = document.hasFocus();
    const isActive = tabId === activeId;
    if (!windowFocused || !isActive) {
      setBellTabs((b) => { const n = new Set(b); n.add(tabId); return n; });
      const tab = tabs.find((t) => t.id === tabId);
      const agent = agents.find((a) => a.id === tab?.agentId);
      const label = agent?.label ?? tab?.agentId ?? "Agent";
      if (notifReady.current) {
        try { sendNotification({ title: "Vector", body: `${label} needs input` }); } catch {}
      }
    }
  }, [activeId, tabs, agents]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "t" && !e.shiftKey) { e.preventDefault(); openPickerForNewTab(); }
      else if (e.key === "w" && !e.shiftKey) { e.preventDefault(); if (activeId) closeTab(activeId); }
      else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        if (e.shiftKey) reloadActive();
      }
      else if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (tabs[idx]) { e.preventDefault(); setActiveId(tabs[idx].id); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPickerForNewTab, closeTab, reloadActive, tabs, activeId]);

  const activeTab = tabs.find((t) => t.id === activeId);
  const xtermTheme = theme === "light" ? lightTheme : darkTheme;

  const tabBar = (
    <div className="tabs-container">
      <div className="tabs">
        {tabs.map((t, i) => {
          const agent = agents.find((a) => a.id === t.agentId);
          const agentLabel = agent?.label ?? (t.agentId === "__shell__" ? "shell" : t.agentId);
          const rawTitle = tabTitles[t.id] || "";
          const stripped = rawTitle
            .replace(new RegExp(`^\\s*${agentLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[–—\\-:·|·]?\\s*`, "i"), "")
            .trim();
          const title = stripped || basename(t.cwd);
          const classes = ["tab"];
          if (t.id === activeId) classes.push("active");
          if (bellTabs.has(t.id)) classes.push("bell");
          return (
            <div key={t.id} className={classes.join(" ")} onClick={() => setActiveId(t.id)} title={`⌘${i + 1} · ${agentLabel} · ${t.cwd}`}>
              <span className="agent-chip"><AgentIcon id={t.agentId} size={14} /></span>
              <span className="tab-label">{title}</span>
              <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</span>
            </div>
          );
        })}
        <button className="tab-new" onClick={openPickerForNewTab} title="New tab (⌘T)">+</button>
      </div>
    </div>
  );

  return (
    <>
      <div className="topbar">
        {activeTab ? (
          <button className="project-btn" onClick={() => openPickerForTab(activeTab.id)} title={activeTab.cwd}>
            <span className="project-dot" /> {basename(activeTab.cwd)}
          </button>
        ) : <div style={{ flex: "0 0 auto" }} />}
        <select
          value={activeTab?.agentId ?? ""}
          onChange={(e) => changeActiveAgent(e.target.value)}
          disabled={!activeTab}
        >
          {agents.filter((a) => a.available).map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
          <option value="__shell__">shell</option>
        </select>
        <button className="icon-btn" onClick={reloadActive} title="Reload agent (⌘⇧R)" disabled={!activeTab}>↻</button>
        <div className="spacer" />
        <div className="settings">
          <button className="icon-btn" onClick={() => setSettingsOpen((o) => !o)} title="Settings" aria-label="Settings">
            <GearIcon />
          </button>
          {settingsOpen && (
            <div className="settings-panel" onMouseLeave={() => setSettingsOpen(false)}>
              <div className="settings-row">
                <span>Theme</span>
                <div className="seg">
                  <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")}>Dark</button>
                  <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")}>Light</button>
                </div>
              </div>
              <div className="settings-row">
                <span>Tabs</span>
                <div className="seg">
                  <button className={orientation === "horizontal" ? "on" : ""} onClick={() => setOrientation("horizontal")}>Top</button>
                  <button className={orientation === "vertical" ? "on" : ""} onClick={() => setOrientation("vertical")}>Side</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className={`shell ${orientation}`}>
        {tabs.length > 0 && tabBar}
        <div className="terms">
          {tabs.map((t) => (
            <TerminalView
              key={`${t.id}-${t.epoch}`}
              tabId={t.id}
              agentId={t.agentId}
              cwd={t.cwd}
              visible={t.id === activeId}
              theme={xtermTheme}
              onBell={onBell}
              onTitle={onTitle}
              onExit={closeTab}
            />
          ))}
          {!tabs.length && !picker.open && <div className="empty">No tabs. ⌘T to open one.</div>}
        </div>
      </div>
      {picker.open && (
        <PickerModal
          recents={recents}
          onPick={applyPick}
          onBrowse={pickFolder}
          onRemoveRecent={(p) => { const next = recents.filter((r) => r !== p); setRecents(next); saveRecents(next); }}
          onClose={tabs.length > 0 ? closePicker : undefined}
          title={picker.forTabId ? "Change project for this tab" : "Open a project"}
        />
      )}
    </>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.2l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function VectorMark({ size = 24 }: { size?: number }) {
  return <img src={logoUrl} width={size} height={size} alt="Vector" style={{ display: "block" }} />;
}

function PickerModal({
  recents,
  onPick,
  onBrowse,
  onRemoveRecent,
  onClose,
  title,
}: {
  recents: string[];
  onPick: (p: string) => void;
  onBrowse: () => void;
  onRemoveRecent: (p: string) => void;
  onClose?: () => void;
  title: string;
}) {
  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-card" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <div className="picker-brand"><VectorMark /> <span>Vector</span></div>
          {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>}
        </div>
        <h2>{title}</h2>
        <p className="picker-sub">Choose the directory the agent should work in.</p>
        <button className="picker-primary" onClick={onBrowse}>Choose folder…</button>
        {recents.length > 0 && (
          <>
            <div className="picker-section">Recent</div>
            <ul className="picker-list">
              {recents.map((p) => (
                <li key={p}>
                  <button className="recent-row" onClick={() => onPick(p)} title={p}>
                    <span className="recent-name">{basename(p)}</span>
                    <span className="recent-path">{p}</span>
                  </button>
                  <button className="recent-x" onClick={() => onRemoveRecent(p)} title="Remove from recents">×</button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function TerminalView({
  tabId,
  agentId,
  cwd,
  visible,
  theme,
  onBell,
  onTitle,
  onExit,
}: {
  tabId: string;
  agentId: string;
  cwd: string;
  visible: boolean;
  theme: ITheme;
  onBell: (tabId: string) => void;
  onTitle: (tabId: string, title: string) => void;
  onExit: (tabId: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);

  useEffect(() => { if (termRef.current) termRef.current.options.theme = theme; }, [theme]);

  useEffect(() => {
    if (!wrapRef.current) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(wrapRef.current);
    termRef.current = term;
    fitRef.current = fit;
    term.onBell(() => onBell(tabId));
    term.onTitleChange((t) => { if (t) onTitle(tabId, t); });

    const sessionId = crypto.randomUUID();
    sessionRef.current = sessionId;

    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let disposed = false;
    let started = false;
    let fontsReady = false;
    let lastCols = -1, lastRows = -1, stableCount = 0;

    const doStart = async () => {
      started = true;
      try { fit.fit(); } catch {}
      const cols = term.cols || 100;
      const rows = term.rows || 30;
      try {
        await invoke("start_session", { sessionId, agentId, cols, rows, cwd });
      } catch (err) {
        term.writeln(`\r\n\x1b[31m[failed to start agent: ${err}]\x1b[0m`);
      }
      if (visible) term.focus();
      // Post-start nudge: some agents (e.g. Claude Code) draw their welcome
      // banner once at launch and never redraw unless SIGWINCH changes size.
      // Send cols-1 then cols back so a redraw is triggered.
      window.setTimeout(async () => {
        if (disposed) return;
        const c = term.cols, r = term.rows;
        if (c > 20 && r > 5) {
          try { await invoke("resize_pty", { sessionId, cols: c - 1, rows: r }); } catch {}
          window.setTimeout(() => {
            if (disposed) return;
            invoke("resize_pty", { sessionId, cols: c, rows: r }).catch(() => {});
          }, 40);
        }
      }, 450);
    };

    const poll = () => {
      if (started || disposed || !fontsReady) return;
      const el = wrapRef.current;
      if (!el || el.clientWidth < 20 || el.clientHeight < 20) return;
      try { fit.fit(); } catch {}
      const c = term.cols, r = term.rows;
      if (c < 20 || r < 5) return;
      if (c === lastCols && r === lastRows) stableCount++;
      else { lastCols = c; lastRows = r; stableCount = 0; }
      if (stableCount >= 2) doStart();
    };

    (async () => {
      unlistenData = await listen<string>(`pty-data-${sessionId}`, (e) => term.write(e.payload));
      unlistenExit = await listen<number>(`pty-exit-${sessionId}`, () => {
        onExit(tabId);
      });

      term.onData((data) => { invoke("write_stdin", { sessionId, data }).catch(() => {}); });
      term.onResize(({ cols, rows }) => {
        if (started) invoke("resize_pty", { sessionId, cols, rows }).catch(() => {});
      });

      // wait for fonts to avoid measuring char width before they load
      try { await (document as any).fonts?.ready; } catch {}
      fontsReady = true;
      poll();
      // safety net: start after 500ms even if we never observe two identical measurements
      window.setTimeout(() => { if (!started && !disposed && fontsReady) doStart(); }, 500);
    })();

    let pollTimer: number | null = null;
    const schedulePoll = () => {
      if (pollTimer != null) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(poll, 60);
    };
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
      if (!started) schedulePoll();
    });
    if (wrapRef.current) ro.observe(wrapRef.current);

    const onWinFocus = () => { if (wrapRef.current?.style.display !== "none") term.focus(); };
    window.addEventListener("focus", onWinFocus);

    return () => {
      disposed = true;
      ro.disconnect();
      if (pollTimer != null) window.clearTimeout(pollTimer);
      window.removeEventListener("focus", onWinFocus);
      unlistenData?.();
      unlistenExit?.();
      if (sessionRef.current) invoke("kill_session", { sessionId: sessionRef.current }).catch(() => {});
      term.dispose();
      termRef.current = null;
    };
  }, [tabId, agentId, cwd]);

  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch {}
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  return (
    <div
      className="term-wrap"
      ref={wrapRef}
      style={{ display: visible ? "block" : "none" }}
      onClick={() => termRef.current?.focus()}
    />
  );
}
