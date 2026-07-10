import { useEffect } from "react";

/**
 * Dismiss a modal/overlay on Escape.
 *
 * Registered on `document` in the capture phase and calls `preventDefault()` so
 * the keypress can't fall through to WKWebView's default handling — on macOS a
 * bare Escape while the window is in native fullscreen pops it OUT of
 * fullscreen, which is what used to happen instead of the open modal closing.
 * `stopPropagation()` keeps a single Escape from also firing element-level
 * handlers inside the modal.
 *
 * `active` lets inline overlays — rendered by a parent that can't itself be
 * conditionally mounted (so it can't conditionally call the hook) — gate the
 * listener on their own open state.
 */
export function useEscapeToClose(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, active]);
}
