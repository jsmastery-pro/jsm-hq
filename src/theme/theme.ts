// Themes recolour the whole app (HUD and office) without changing layout or pixel art.
// "auto" follows the system light/dark setting. Saved per browser, like the font, because
// it's a personal choice, not a team setting.

export type ThemeId = "classic" | "night";
export type ThemeChoice = "auto" | ThemeId;

export const THEME_CHOICES: { id: ThemeChoice; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Classic by day, Night when your system is in dark mode" },
  { id: "classic", label: "Classic", hint: "The original daytime office" },
  { id: "night", label: "Night", hint: "The office after dark: dim rooms, glowing screens" },
];

const KEY = "jsmhq.theme";
/** Fired on window with the resolved ThemeId whenever the active theme changes. */
export const THEME_EVENT = "jsmhq:theme";

const darkQuery = (): MediaQueryList | null => (typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null);

let active: ThemeId = "classic";

/** The theme in use right now (auto already resolved). */
export function currentTheme(): ThemeId {
  return active;
}

export function savedThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return THEME_CHOICES.some((t) => t.id === v) ? (v as ThemeChoice) : "auto";
  } catch {
    return "auto";
  }
}

function resolve(choice: ThemeChoice): ThemeId {
  if (choice !== "auto") return choice;
  return darkQuery()?.matches ? "night" : "classic";
}

/** Applies a choice: sets data-theme on <html> (CSS tokens) and tells the office to repaint. */
export function applyTheme(choice: ThemeChoice) {
  const next = resolve(choice);
  if (next === "classic") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  if (next === active) return;
  active = next;
  window.dispatchEvent(new CustomEvent<ThemeId>(THEME_EVENT, { detail: next }));
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* private window: still applies until reload */
  }
  applyTheme(choice);
}

/** Applies the saved choice now and keeps "auto" in step with the system setting. */
export function startTheme(): () => void {
  applyTheme(savedThemeChoice());
  const q = darkQuery();
  const onChange = () => savedThemeChoice() === "auto" && applyTheme("auto");
  q?.addEventListener("change", onChange);
  return () => q?.removeEventListener("change", onChange);
}
