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
  /** Names of the applied branches. */
  applied: string[];
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

/** The PRs & builds pane. */
export interface PrsConfig {
  /** null is the default: closed until Ctrl+Shift+P. true opens it with the tab. */
  open: boolean | null;
}

/** Release tracking: what's on the default branch but not in prod. */
export interface ReleasesConfig {
  /** null is the default: not tracked. */
  track: boolean | null;
  /** The Azure DevOps environment that counts as prod; null is `Production`. */
  environment: string | null;
  /** Days before a nudge; null is the default (14), 0 never nudges. */
  nudgeDays: number | null;
}

export interface ProjectSettings {
  builds: BuildConfig;
  run: RunConfig;
  prs: PrsConfig;
  releases: ReleasesConfig;
}

export interface RunRef {
  id: number;
  number: string;
  time: string | null;
  url: string;
}

export interface ReleaseCommit {
  sha: string;
  message: string;
  author: string;
  time: string;
}

/** Where one tracked project stands against its prod environment. */
export interface Release {
  /** The project id: its path. */
  id: string;
  name: string;
  /** `none`: nothing from the default branch has deployed to the environment yet. */
  state: "level" | "behind" | "none" | "error";
  environment: string;
  pipeline: string;
  pipelineUrl: string;
  definition: number | null;
  branch: string;
  prod: RunRef | null;
  head: RunRef | null;
  /** What the newest run is doing about prod. Empty when level. */
  hold: "" | "waiting" | "running" | "queued" | "failed" | "canceled" | "skipped";
  canApprove: boolean;
  /** When the oldest run that isn't in prod was queued. */
  since: string | null;
  /** Newest first, merges left out. */
  commits: ReleaseCommit[];
  runsBehind: number;
  error: string | null;
}

export type CheckState =
  | "succeeded"
  | "failed"
  | "partial"
  | "running"
  | "queued"
  | "waiting"
  | "expired"
  | "canceled"
  | "skipped"
  | "unknown";

export interface Reviewer {
  name: string;
  vote: "approved" | "suggestions" | "waiting" | "rejected" | "none";
  me: boolean;
  required: boolean;
}

export interface Check {
  name: string;
  /** `build` for a pipeline or check run; `policy` for reviewer counts and the like. */
  kind: "build" | "policy";
  state: CheckState;
  detail: string;
  url: string;
  blocking: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  mine: boolean;
  reviewRequested: boolean;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
  conflicts: boolean;
  created: string;
  reviewers: Reviewer[];
  checks: Check[];
  ready: boolean;
}

export interface PipelineRun {
  /** The provider's run id; Azure's rise with queue order. */
  id: number;
  /** Azure's build definition, which release tracking matches on. */
  definition: number | null;
  /** `waiting` is held at an approval gate: nothing is running. */
  state: CheckState;
  number: string;
  branch: string;
  url: string;
  time: string | null;
  /** You're one of the approvers it's waiting on. */
  canApprove: boolean;
}

export interface Pipeline {
  name: string;
  url: string;
  /** Newest first. */
  runs: PipelineRun[];
}

/** What the PRs & builds pane shows for one repository. */
export interface Activity {
  provider: "azure" | "github" | "none";
  source: string;
  remote: string;
  repoUrl: string;
  defaultBranch: string;
  prs: PullRequest[];
  pipelines: Pipeline[];
  error: string | null;
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
  | "waiting"
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
export const emptyReleasesConfig = (): ReleasesConfig => ({ track: null, environment: null, nudgeDays: null });

/** Every tracked project against its prod environment. `force` skips the few minutes' cache. */
export const releasesAll = (force: boolean) => invoke<Release[]>("releases_all", { force });

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
