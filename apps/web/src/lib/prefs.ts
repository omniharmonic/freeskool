/** Local-only display preferences. Never a public record, never synced. */

const KEY = 'fs.prefs.v1';

export type ThemeChoice = 'system' | 'light' | 'dark';

export interface Prefs {
  theme: ThemeChoice;
  reduceBlur: boolean;
}

export const defaultPrefs: Prefs = { theme: 'system', reduceBlur: false };

export function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultPrefs;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system',
      reduceBlur: parsed.reduceBlur === true,
    };
  } catch {
    return defaultPrefs; // private mode / blocked storage
  }
}

export function writePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* non-fatal */
  }
}

export function applyPrefs(prefs: Prefs): void {
  const root = document.documentElement;
  if (prefs.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  if (prefs.reduceBlur) root.dataset.reduceBlur = 'true';
  else delete root.dataset.reduceBlur;
}
