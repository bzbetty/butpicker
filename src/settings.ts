export interface Settings {
  /** Executable for the right-hand terminals. */
  shell: string;
  shellArgs: string[];
  shellLabel: string;
  /** Executable and args for the left-hand GitButler TUI. */
  butCommand: string;
  butArgs: string[];
  /** Environment for the TUI pane. */
  butEnv: Record<string, string>;
  /** Branch names the tab badges should not count. */
  statusIgnoreBranches: string[];
  /** Directory whose immediate subfolders are the project list. */
  scanRoot: string;
}

const KEY = "butpicker.settings";

const DEFAULTS: Settings = {
  shell: "pwsh.exe",
  shellArgs: ["-NoLogo"],
  shellLabel: "pwsh",
  butCommand: "but.exe",
  butArgs: ["tui"],
  // The TUI pane is always a real terminal, so say so outright rather than
  // letting `but` infer a machine-readable format and refuse to start.
  butEnv: { BUT_OUTPUT_FORMAT: "human" },
  // Plans get pushed but never merged, so they are not outstanding work.
  statusIgnoreBranches: ["plans"],
  scanRoot: "C:\\git",
};

let cached: Settings | null = null;

export function getSettings(): Settings {
  if (cached) return cached;
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
  } catch {
    // Corrupt or absent; the defaults below are the answer either way.
  }
  const settings: Settings = { ...DEFAULTS, ...stored };
  cached = settings;
  return settings;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  cached = { ...getSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(cached));
  return cached;
}

export const SETTINGS_DEFAULTS = DEFAULTS;
