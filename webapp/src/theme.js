// Light or dark theme: users pick "system" (the default, follows their OS), "light" or "dark".
// Blueprint styles everything under `.bp6-dark`: we put the class on <html>, so that portals (popovers, dialogs, toasts) follow.
// index.html and files.html apply the saved choice before the first paint, to avoid flashing a light page.
import { useEffect, useSyncExternalStore } from "react";
import { Classes } from "@blueprintjs/core";
import { usePrefsStore } from "./stores/prefs";

export const themes = ["system", "light", "dark"];

const dark_query = "(prefers-color-scheme: dark)";
const media = () => typeof window !== "undefined" && window.matchMedia ? window.matchMedia(dark_query) : null;

const subscribeSystem = callback => {
  const query = media();
  query?.addEventListener?.("change", callback);
  return () => query?.removeEventListener?.("change", callback);
};
const systemIsDark = () => !!media()?.matches;

export const resolveTheme = (preference, system_dark) =>
  preference === "dark" || (preference !== "light" && system_dark) ? "dark" : "light";

export const applyTheme = theme => {
  const root = document.documentElement;
  root.classList.toggle(Classes.DARK, theme === "dark");
  root.style.colorScheme = theme;
};

// "light" or "dark", following the user's choice and their OS
export const useTheme = () => {
  const preference = usePrefsStore(state => state.theme);
  const system_dark = useSyncExternalStore(subscribeSystem, systemIsDark, () => false);
  return resolveTheme(preference, system_dark);
};

export const useIsDark = () => useTheme() === "dark";

// Rendered once near the root of each app
export const ThemeSync = () => {
  const theme = useTheme();
  useEffect(() => applyTheme(theme), [theme]);
  return null;
};
