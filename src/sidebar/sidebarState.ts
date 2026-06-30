import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

// SidebarTab values match the backend's #[serde(rename_all = "lowercase")] enum.
export type SidebarTab = "files" | "worktrees" | "github";
export type GhNotification = { threadId: string; repo: string; number: number; title: string; reason: string; updatedAt: string };
export type WorktreesViewMode = "flat" | "tree";

// UiConfig has no rename_all — Rust serializes fields as snake_case.
// get_ui_config returns snake_case JSON keys.
export type SidebarState = {
  sidebar_collapsed: boolean;
  sidebar_active_tab: SidebarTab;
  sidebar_width: number;
  show_hidden_files: boolean;
  worktrees_view_mode: WorktreesViewMode;
  github_subview: string;
  github_custom_groups: string[];
  github_repo_group: Record<string, string>;
  github_pinned_repos: string[];
  github_collapsed_groups: string[];
  github_favorited_workflows: string[];
  github_notifications_seen_at: string;
};


const DEFAULT: SidebarState = {
  sidebar_collapsed: false,
  sidebar_active_tab: "files",
  sidebar_width: 240,
  show_hidden_files: false,
  worktrees_view_mode: "flat",
  github_subview: "repos",
  github_custom_groups: [],
  github_repo_group: {},
  github_pinned_repos: [],
  github_collapsed_groups: [],
  github_favorited_workflows: [],
  github_notifications_seen_at: "",
};

export function useSidebarState() {
  const [state, setState] = useState<SidebarState>(DEFAULT);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    invoke<SidebarState>("get_ui_config")
      .then((s) => { setState(s); setHydrated(true); })
      .catch(() => setHydrated(true)); // fall back to defaults
  }, []);

  const update = (patch: Partial<SidebarState>) => {
    setState((prev) => ({ ...prev, ...patch }));
    if (hydrated) {
      invoke("update_sidebar_config", { patch }).catch(console.error);
    }
  };

  return { state, update, hydrated };
}
