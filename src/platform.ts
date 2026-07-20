import { platform } from "@tauri-apps/plugin-os";

// platform() is synchronous in plugin-os v2 and returns e.g. "macos" | "linux" | "windows".
export const isMac = platform() === "macos";

/** The app-action modifier: ⌘ on macOS, Ctrl+Shift elsewhere (Ctrl alone
 *  belongs to the terminal — Ctrl+C/D/U must reach the shell). */
export function isMod(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey && e.shiftKey;
}
