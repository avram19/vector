import { useEffect, useRef, useState } from "react";

function LinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/// Copies `url` and flips to a checkmark for 1.5s. Vector has no toast system,
/// so the icon swap is the only feedback.
export function CopyLinkButton({ url, title = "Copy link", className = "gh-icobtn" }: {
  url: string;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  // The 1.5s timer outlives a fast unmount (closing the tab right after a
  // click), so clear it or React warns about setting state on a dead component.
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const copy = (e: React.MouseEvent) => {
    // Run rows and fav cards are themselves clickable — never let a copy also
    // open the row.
    e.stopPropagation();
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <button
      type="button"
      className={`${className}${copied ? " copied" : ""}`}
      title={copied ? "Copied!" : title}
      onClick={copy}
    >
      {copied ? <CheckIcon /> : <LinkIcon />}
    </button>
  );
}
