import { invoke } from "@tauri-apps/api/core";

export interface Project {
  id: string;
  name: string;
  path: string;
}

export interface Session {
  open: string[];
  active: string | null;
}

export interface ProjectStatus {
  pending: number;
  branches: number;
  stacks: number;
  error: string | null;
}

/** Per-project Azure DevOps configuration; every field is optional. */
export interface BuildConfig {
  /** null is auto: the badge appears when the remote points at Azure DevOps. */
  enabled: boolean | null;
  organization: string | null;
  project: string | null;
  repository: string | null;
  definitions: number[];
  branch: string | null;
}

/** What the run pane runs, and when. Every field is optional. */
export interface RunConfig {
  /** null is the default: a button when there's a command to run. */
  mode: "auto" | "off" | null;
  /** null uses whatever detection found, e.g. `aspire run` for an AppHost. */
  command: string | null;
}

export interface ProjectSettings {
  builds: BuildConfig;
  run: RunConfig;
}

export type BuildState =
  | "off"
  | "none"
  | "error"
  | "succeeded"
  | "failed"
  | "partial"
  | "canceled"
  | "running"
  | "queued"
  | "unknown";

export interface BuildStatus {
  state: BuildState;
  pipeline: string;
  number: string;
  branch: string;
  url: string;
  time: string | null;
  pipelines: number;
  /** `org / project / repo`, however it was arrived at. */
  source: string;
  error: string | null;
}

export const emptyBuildConfig = (): BuildConfig => ({
  enabled: null,
  organization: null,
  project: null,
  repository: null,
  definitions: [],
  branch: null,
});

/** A running AppHost, as `aspire ps` describes it. */
export interface RunningAppHost {
  appHostPath: string;
  dashboardUrl: string | null;
  status: string | null;
  /** The linked worktree it runs from, or null for the project's own checkout. */
  worktree: string | null;
  /** That worktree's branch, if it has one checked out. */
  branch: string | null;
}

/** A linked worktree of a project, from `git worktree list`. */
export interface Worktree {
  path: string;
  branch: string | null;
}

/** What to call a worktree: its branch, or failing that its folder. */
export function worktreeLabel(path: string | null, branch: string | null): string {
  if (!path) return "this checkout";
  return branch ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** What to call where an AppHost runs. */
export const worktreeName = (host: RunningAppHost) => worktreeLabel(host.worktree, host.branch);

export const emptyRunConfig = (): RunConfig => ({ mode: null, command: null });
export const emptyPrsConfig = (): PrsConfig => ({ open: null });

export const listProjects = (root: string) => invoke<Project[]>("projects_list", { root });
export const projectStatus = (path: string, program: string, ignoreBranches: string[]) =>
  invoke<ProjectStatus>("project_status", { path, program, ignoreBranches });
export const buildStatus = (path: string, config: BuildConfig) =>
  invoke<BuildStatus>("build_status", { path, config });
/** PRs, checks and pipeline runs for the repository's remote. `force` skips the minute's cache. */
export const repoActivity = (path: string, force: boolean) =>
  invoke<Activity>("repo_activity", { path, force });
export const projectSettingsAll = () =>
  invoke<Record<string, ProjectSettings>>("project_settings_all");
export const saveProjectSettings = (id: string, settings: ProjectSettings) =>
  invoke<void>("project_settings_save", { id, settings });
export const detectRun = (path: string) => invoke<string | null>("run_detect", { path });
/**
 * Keyed by whichever of `paths` has an AppHost running under it or under one
 * of its worktrees.
 */
export const aspireRunning = (paths: string[]) =>
  invoke<Record<string, RunningAppHost[]>>("aspire_running", { paths });
/** The project's linked worktrees, other than its own checkout. */
export const listWorktrees = (path: string) => invoke<Worktree[]>("worktrees_list", { path });
export const aspireStop = (appHostPath: string) => invoke<void>("aspire_stop", { appHostPath });
export const getSession = () => invoke<Session>("session_get");
export const saveSession = (open: string[], active: string | null) =>
  invoke<void>("session_save", { open, active });

/**
 * Subsequence match, so "biap" finds "billing-api". Returns false when the
 * needle does not fit in order.
 */
export function matchesSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  const lower = haystack.toLowerCase();
  let i = 0;
  for (const ch of lower) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}
