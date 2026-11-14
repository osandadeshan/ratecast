"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "Auto", light: "Light", dark: "Dark" };

/** Cycles system → light → dark. Stored in localStorage; applied as data-theme on <html> (see globals.css). */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    const t = localStorage.getItem("theme");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (t === "light" || t === "dark") setTheme(t);
  }, []);
  const choose = (t: Theme) => {
    setTheme(t);
    if (t === "system") {
      localStorage.removeItem("theme");
      document.documentElement.removeAttribute("data-theme");
    } else {
      localStorage.setItem("theme", t);
      document.documentElement.setAttribute("data-theme", t);
    }
  };
  return (
    <button
      type="button"
      onClick={() => choose(NEXT[theme])}
      className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2 hover:text-ink"
      aria-label={`Colour theme: ${LABEL[theme]}. Change theme`}
      title="Colour theme"
    >
      {LABEL[theme]}
    </button>
  );
}
