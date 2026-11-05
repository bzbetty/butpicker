export interface Settings {
  /** Executable for the right-hand terminals. */
  shell: string;
  shellArgs: string[];
  shellLabel: string;
  /**
   * What a new terminal can be: the shell itself, or the shell running a
   * command first and staying open after it. The first is the default; the
   * second is what Alt adds to the new-terminal shortcuts.
   */
  profiles: Profile[];
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

export interface Profile {
  name: string;
  /** Run in the shell on start; the shell stays once it exits. None for a bare shell. */
  command?: string;
}

const KEY = "butpicker.settings";

// The webview is the only platform signal available before any command runs,
// and it is enough to pick sane executable names.
const IS_WINDOWS = navigator.userAgent.includes("Windows");

const DEFAULTS: Settings = IS_WINDOWS
  ? {
      shell: "pwsh.exe",
      shellArgs: ["-NoLogo"],
      shellLabel: "pwsh",
      profiles: [{ name: "pwsh" }, { name: "claude", command: "claude" }],
      butCommand: "but.exe",
      butArgs: ["tui"],
      // The TUI pane is always a real terminal, so say so outright rather than
      // letting `but` infer a machine-readable format and refuse to start.
      butEnv: { BUT_OUTPUT_FORMAT: "human" },
      // Plans get pushed but never merged, so they are not outstanding work.
      statusIgnoreBranches: ["plans"],
      scanRoot: "C:\\git",
    }
  : {
      shell: "bash",
      shellArgs: ["-l"],
      shellLabel: "bash",
      profiles: [{ name: "bash" }, { name: "claude", command: "claude" }],
      butCommand: "but",
      butArgs: ["tui"],
      butEnv: { BUT_OUTPUT_FORMAT: "human" },
      statusIgnoreBranches: ["plans"],
      scanRoot: "~/git",
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

/**
 * Arguments that make `shell` run one command line and exit, so a run command
 * gets the shell's PATH, quoting and aliases rather than a naive split.
 */
export function shellCommandArgs(shell: string, command: string): string[] {
  const name = shell.toLowerCase().replace(/^.*[\\/]/, "").replace(/\.exe$/, "");
  if (name === "cmd") return ["/c", command];
  if (name === "pwsh" || name === "powershell") return ["-NoLogo", "-Command", command];
  return ["-c", command];
}

/**
 * Arguments that make `shell` run `command` and then carry on as an ordinary
 * interactive shell, so quitting the command leaves a prompt rather than a
 * dead pane.
 */
export function shellThenCommandArgs(shell: string, shellArgs: string[], command: string): string[] {
  const name = shell.toLowerCase().replace(/^.*[\\/]/, "").replace(/\.exe$/, "");
  if (name === "cmd") return [...shellArgs, "/k", command];
  if (name === "pwsh" || name === "powershell") return [...shellArgs, "-NoExit", "-Command", command];
  // POSIX single quotes, so a path like C:\Program Files\Git\bin\bash.exe survives.
  const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
  return [...shellArgs, "-c", `${command}; exec ${[shell, ...shellArgs].map(quote).join(" ")}`];
}
