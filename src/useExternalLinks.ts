import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

// Sends clicks on links inside `ref` to the system browser instead of letting
// them navigate the app window.
//
// Any container rendering untrusted HTML (PR comments, markdown previews) needs
// this: a bare <a href> inside a WKWebView navigates the app window itself, and
// Vector has no back button to recover with.
//
// Delegated from the container so it keeps working as innerHTML changes.
export function useExternalLinks(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      // Decide on the *raw* attribute, not `anchor.href`: the DOM resolves a
      // relative href against the app origin (tauri://localhost in a release
      // build), which would slip past an http(s) test and then navigate the
      // webview — the very bug this hook exists to prevent.
      const raw = anchor.getAttribute("href") ?? "";
      // In-page anchors (#section) are harmless — let the default handler run.
      if (raw.startsWith("#")) return;
      // Nothing else may navigate the window. An explicit external scheme opens
      // in the system browser (DOMPurify already stripped javascript:); a
      // relative or scheme-less href is swallowed rather than allowed to hijack
      // the app.
      e.preventDefault();
      if (/^(https?|mailto):/i.test(raw)) {
        invoke("open_path", { path: raw }).catch(() => {});
      }
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [ref]);
}
