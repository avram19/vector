import React, { useRef } from "react";
import { useSidebarState, SidebarTab } from "./sidebarState";
import { FileViewer } from "./FileViewer";
import { WorktreesView } from "./WorktreesView";
import { GithubPanel } from "../github/GithubPanel";

const RAIL_WIDTH = 42;

function FilesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

function WorktreesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.09.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.56 2.36 1.11 2.94.85.09-.66.35-1.11.63-1.37-2.22-.26-4.55-1.14-4.55-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.27 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.59.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.2l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function EyeIcon({ closed }: { closed: boolean }) {
  return closed ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function Sidebar({
  onOpenSettings,
  projectRoot,
  sessionId,
  onOpenPreview,
  activePreviewPath,
  pinnedPaths,
  pinEnabled,
  onTogglePin,
}: {
  onOpenSettings?: () => void;
  projectRoot?: string | null;
  sessionId?: string | null;
  onOpenPreview?: (filePath: string, line: number | undefined, col: number | undefined, opts: { pin: boolean; mode?: "file" | "diff"; baseRef?: string }) => void;
  activePreviewPath?: string | null;
  pinnedPaths: string[];
  pinEnabled: boolean;
  onTogglePin: (path: string) => void;
}) {
  const { state, update, hydrated } = useSidebarState();
  const { sidebar_collapsed, sidebar_active_tab, sidebar_width } = state;

  // Expose sidebar offset as a CSS variable on the document root so topbar/shell
  // can shift right without needing prop drilling.
  const offset = RAIL_WIDTH + (sidebar_collapsed ? 0 : sidebar_width);
  React.useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-offset", `${offset}px`);
  }, [offset]);

  if (!hydrated) return null; // avoid flicker on first render

  const onIconClick = (tab: SidebarTab) => {
    if (tab === sidebar_active_tab && !sidebar_collapsed) {
      update({ sidebar_collapsed: true });
    } else {
      update({ sidebar_active_tab: tab, sidebar_collapsed: false });
    }
  };

  return (
    <>
      <div className="sidebar-rail">
        <button
          className={`sidebar-rail-icon${sidebar_active_tab === "files" && !sidebar_collapsed ? " active" : ""}`}
          onClick={() => onIconClick("files")}
          title="Files"
        ><FilesIcon /></button>
        <button
          className={`sidebar-rail-icon${sidebar_active_tab === "worktrees" && !sidebar_collapsed ? " active" : ""}`}
          onClick={() => onIconClick("worktrees")}
          title="Worktrees"
        ><WorktreesIcon /></button>
        <button
          className={`sidebar-rail-icon${sidebar_active_tab === "github" && !sidebar_collapsed ? " active" : ""}`}
          onClick={() => onIconClick("github")}
          title="GitHub"
        ><GithubIcon /></button>
        <div className="sidebar-rail-spacer" />
        {onOpenSettings && (
          <button
            className="sidebar-rail-icon"
            onClick={onOpenSettings}
            title="Settings (⌘,)"
            aria-label="Settings"
          ><SettingsIcon /></button>
        )}
      </div>

      {!sidebar_collapsed && (
        <div className="sidebar-panel" style={{ width: sidebar_width }}>
          <div className="sidebar-panel-header">
            <span className="sidebar-panel-title" title={sidebar_active_tab === "github" ? "" : (projectRoot ?? "")}>
              {sidebar_active_tab === "github"
                ? "GitHub"
                : (projectRoot ? basename(projectRoot) : (sidebar_active_tab === "files" ? "Files" : "Worktrees"))}
            </span>
            {sidebar_active_tab === "files" && (
              <button
                className="sidebar-panel-action"
                title={state.show_hidden_files ? "Hide hidden files" : "Show hidden files"}
                onClick={() => update({ show_hidden_files: !state.show_hidden_files })}
              >
                <EyeIcon closed={!state.show_hidden_files} />
              </button>
            )}
          </div>
          <div className="sidebar-panel-content">
            {sidebar_active_tab === "files" && (
              <FileViewer
                projectRoot={projectRoot ?? null}
                showHidden={state.show_hidden_files}
                sessionId={sessionId ?? null}
                onOpenPreview={onOpenPreview}
                activePath={activePreviewPath ?? null}
              />
            )}
            {sidebar_active_tab === "worktrees" && (
              <WorktreesView
                projectRoot={projectRoot ?? null}
                sessionId={sessionId ?? null}
                onOpenPreview={onOpenPreview}
                changesView={state.worktrees_view_mode}
                onChangesView={(m) => update({ worktrees_view_mode: m })}
                activePath={activePreviewPath ?? null}
                pinnedPaths={pinnedPaths}
                pinEnabled={pinEnabled}
                onTogglePin={onTogglePin}
              />
            )}
            {sidebar_active_tab === "github" && (
              <GithubPanel
                subview={state.github_subview}
                onSubview={(v) => update({ github_subview: v })}
                repoState={{
                  pinned: state.github_pinned_repos,
                  customGroups: state.github_custom_groups,
                  repoGroup: state.github_repo_group,
                  collapsed: state.github_collapsed_groups,
                }}
                onRepoUpdate={(patch) => update(patch)}
                favoritedWorkflows={state.github_favorited_workflows}
                onFavoritedWorkflows={(next) => update({ github_favorited_workflows: next })}
                onOpenPreview={onOpenPreview ?? (() => {})}
              />
            )}
          </div>
          <SidebarDivider
            sidebarWidth={sidebar_width}
            onChange={(w) => update({ sidebar_width: w })}
          />
        </div>
      )}
    </>
  );
}

function basename(p: string): string {
  if (!p) return "";
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function SidebarDivider({
  sidebarWidth,
  onChange,
}: {
  sidebarWidth: number;
  onChange: (w: number) => void;
}) {
  const startXRef = useRef<number | null>(null);
  const startWidthRef = useRef<number>(sidebarWidth);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (startXRef.current === null) return;
      const delta = ev.clientX - startXRef.current;
      const next = Math.min(600, Math.max(160, startWidthRef.current + delta));
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
