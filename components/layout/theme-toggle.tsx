"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const COOKIE = "ts_theme";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "Theme: follow system", light: "Theme: light", dark: "Theme: dark" };

function apply(t: Theme) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

/** Cycles system, light, dark. The choice is kept in a cookie, so the server renders the right theme from the first byte; "system" follows the operating system setting. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const saved = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`))?.split("=")[1];
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);
  const choose = () => {
    const t = NEXT[theme];
    setTheme(t);
    apply(t);
    document.cookie = t === "system" ? `${COOKIE}=; path=/; max-age=0; samesite=lax` : `${COOKIE}=${t}; path=/; max-age=31536000; samesite=lax`;
  };
  return (
    <button type="button" onClick={choose} aria-label={LABEL[theme]} title={LABEL[theme]} className="rounded-sm p-1.5 hover:bg-surface-2">
      <svg viewBox="0 0 20 20" className="size-4 text-muted" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="square" aria-hidden>
        {theme === "dark" ? <path d="M16 11.5A6.5 6.5 0 0 1 8.5 4 6.5 6.5 0 1 0 16 11.5z" /> : theme === "light" ? <><circle cx="10" cy="10" r="3.2" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></> : <><rect x="3" y="4" width="14" height="10" /><path d="M7 17h6M10 14v3" /></>}
      </svg>
    </button>
  );
}
