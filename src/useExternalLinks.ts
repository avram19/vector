import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

// Sends clicks on http(s) anchors inside `ref` to the system browser.
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
      // `anchor.href` is already absolute-resolved by the DOM. DOMPurify strips
      // javascript: hrefs upstream; this guard is defence in depth, and also
      // leaves mailto:/anchor links to the default handler.
      const href = anchor.href;
      if (!/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      invoke("open_path", { path: href }).catch(() => {});
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [ref]);
}
