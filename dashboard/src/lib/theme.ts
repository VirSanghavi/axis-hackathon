import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "axis.dashboard.theme";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Applies the preference to <html data-theme>. index.html runs the same logic before first paint. */
export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(readPref);
  useEffect(() => {
    const root = document.documentElement;
    if (pref === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", pref);
    try {
      if (pref === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch {
      /* the choice just will not survive a reload */
    }
  }, [pref]);
  return [pref, setPref];
}
