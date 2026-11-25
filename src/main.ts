import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  aspireRunning,
  aspireStop,
  azureOptions,
  buildStatus,
  detectRun,
  emptyBuildConfig,
  emptyPrsConfig,
  emptyReleasesConfig,
  emptyRunConfig,
  getSession,
  listProjects,
  matchesSubsequence,
  projectSettingsAll,
  projectStatus,
  myPrs,
  releasesAll,
  saveProjectSettings,
  saveSession,
  type BuildState,
  type BuildStatus,
  type Project,
  type ProjectSettings,
  type ProjectStatus,
  type MyPr,
  type Release,
  type RunningAppHost,
  worktreeName,
} from "./projects";
import {
  ageClass,
  ageText,
  daysWaiting,
  DEFAULT_NUDGE_DAYS,
  lastKnown,
  lastKnownPrs,
  needsAttention,
  prCounts,
  releaseChip,
  remember,
  rememberPrs,
  renderPanel,
  showNudge,
  takeNudges,
} from "./releases";
import { getSettings } from "./settings";
import { ProjectView, type RunSpec } from "./workspace";

const tabsEl = document.getElementById("tabs") as HTMLDivElement;
const viewsEl = document.getElementById("views") as HTMLDivElement;
const emptyEl = document.getElementById("empty") as HTMLDivElement;
const modalEl = document.getElementById("modal") as HTMLDivElement;

const views = new Map<string, ProjectView>();
let order: string[] = [];
let activeId: string | null = null;
let restoring = false;

/* ------------------------------------------------------------------ session */

let sessionTimer: number | undefined;

/**
 * Persist the open tabs on every change rather than only on close: a crash or a
 * kill shouldn't cost the workspace. Coalesced, because activating a tab while
 * cycling would otherwise write once per keystroke.
 */
function rememberSession(): void {
  if (restoring) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    void saveSession([...order], activeId);
  }, 250);
}

/* ---------------------------------------------------------------- projects */

async function openProject(project: Project): Promise<void> {
  if (views.has(project.id)) {
    activate(project.id);
    return;
  }
  const view = new ProjectView(project);
  // A click on ▶ should decide between running and attaching on what's true
  // now, not on a poll from half a minute ago.
  view.beforeRun = () => refreshAspire(0);
  view.onStopAspire = async (appHostPath) => {
    await aspireStop(appHostPath).catch(() => {});
    await refreshAspire(0);
  };
  view.element.classList.add("hidden");
  viewsEl.appendChild(view.element);
  views.set(project.id, view);
  order.push(project.id);
  renderTabs();
  // Make it visible before starting, so the ptys get honest dimensions.
  activate(project.id);
  rememberSession();
  const detecting = detectRun(project.path).catch(() => null);
  await view.start();
  view.fitAll();
  detectedRun.set(project.id, await detecting);
  view.configureRun(runSpecFor(project.id));
  // The pane's answer feeds the tab's PR badge.
  view.prs.onChange = renderTabs;
  view.prs.setRelease(releaseFor(project.id) ?? null);
  if (projectSettingsFor(project.id).prs.open) view.togglePrs(true);
  void view.refreshWorktrees();
  // Restore activates every tab in turn on the way through; only the one you
  // end up looking at should get its run started.
  if (activeId === project.id && !restoring) view.activated();
  void refreshStatuses();
}

function activate(id: string): void {
  if (!views.has(id)) return;
  activeId = id;
  for (const [key, view] of views) {
    view.element.classList.toggle("hidden", key !== id);
  }
  emptyEl.classList.toggle("hidden", views.size > 0);
  const view = views.get(id)!;
  view.fitAll();
  view.active.focus();
  void getCurrentWindow().setTitle(`${view.project.name} — ButPicker`);
  if (!restoring) view.activated();
  void refreshAspire(ASPIRE_ACTIVATE_MS);
  renderTabs();
  rememberSession();
}

function closeProject(id: string): void {
  const view = views.get(id);
  if (!view) return;
  view.dispose();
  views.delete(id);
  statuses.delete(id);
  builds.delete(id);
  lastPolled.delete(id);
  detectedRun.delete(id);
  aspireState.delete(id);
  const index = order.indexOf(id);
  order = order.filter((x) => x !== id);
  renderTabs();
  rememberSession();
  if (activeId !== id) return;
  const next = order[Math.min(index, order.length - 1)];
  if (next) {
    activate(next);
  } else {
    activeId = null;
    emptyEl.classList.remove("hidden");
    void getCurrentWindow().setTitle("ButPicker");
    rememberSession();
  }
}

function cycleProject(direction: 1 | -1): void {
  if (order.length < 2 || !activeId) return;
  const index = order.indexOf(activeId);
  activate(order[(index + direction + order.length) % order.length]);
}

/* ------------------------------------------------------------------ status */

const statuses = new Map<string, ProjectStatus>();
const builds = new Map<string, BuildStatus>();
let statusTimer: number | undefined;
/** When each tab was last asked, so a tick only spawns for the ones that are due. */
const lastPolled = new Map<string, number>();
let polling = false;

/** Background badges are the whole point: they're the only view of those repos. */
const BACKGROUND_POLL_MS = 60_000;
/** The active tab's TUI already shows its state, so its badge can lag. */
const ACTIVE_POLL_MS = 5 * 60_000;
/** How often to check what's due. Spawns nothing unless a tab is. */
const POLL_TICK_MS = 15_000;

/**
 * Polls `but status` and the Azure DevOps build for the tabs that are due. Only
 * while the window has focus — a background window spawning a process per
 * project per interval is rude. `but status` can take several seconds, so a
 * round is skipped if the last one hasn't come back rather than stacking up.
 * The build side answers from a minute-old cache in Rust.
 */
async function refreshStatuses(): Promise<void> {
  if (polling || !document.hasFocus() || views.size === 0) return;
  void refreshAspire(ASPIRE_POLL_MS);
  const now = Date.now();
  const due = [...views.values()].filter((view) => {
    const id = view.project.id;
    const every = id === activeId ? ACTIVE_POLL_MS : BACKGROUND_POLL_MS;
    return now - (lastPolled.get(id) ?? 0) >= every;
  });
  if (due.length === 0) return;
  for (const view of due) lastPolled.set(view.project.id, now);
  const { butCommand, statusIgnoreBranches } = getSettings();
  polling = true;
  const results = await Promise.all(
    due.map(async (view) => {
      const [status, build] = await Promise.all([
        projectStatus(view.project.path, butCommand, statusIgnoreBranches).catch(() => null),
        buildStatus(view.project.path, projectSettingsFor(view.project.id).builds).catch(() => null),
      ]);
      return [view.project.id, status, build] as const;
    }),
  ).finally(() => {
    polling = false;
  });
  let changed = false;
  for (const [id, status, build] of results) {
    if (status && !status.error) views.get(id)?.prs.setApplied(status.applied ?? [], statusIgnoreBranches);
    if (status) {
      const previous = statuses.get(id);
      if (
        previous?.pending !== status.pending ||
        previous?.branches !== status.branches ||
        previous?.error !== status.error
      ) {
        statuses.set(id, status);
        changed = true;
      }
    }
    if (build) {
      const previous = builds.get(id);
      builds.set(id, build);
      if (
        previous?.state !== build.state ||
        previous?.number !== build.number ||
        previous?.error !== build.error
      ) {
        changed = true;
      }
    }
  }
  if (changed) renderTabs();
}

/** Each open project's running AppHosts, its own and its worktrees', where it has any. */
const aspireState = new Map<string, RunningAppHost[]>();
let aspireCheckedAt = 0;
let aspireInFlight: Promise<void> | null = null;

/** Running apps come and go with agents, so this polls faster than `but status`. */
const ASPIRE_POLL_MS = 30_000;
/** Switching to a tab is a good moment to check, but not on every Ctrl+Tab. */
const ASPIRE_ACTIVATE_MS = 10_000;

/**
 * Asks `aspire ps` which open projects have an AppHost running, if the last
 * answer is older than `maxAgeMs`. One call covers every tab, and it's only
 * made at all when an open project has an AppHost.
 */
/** What the ◆ badge shows of a project's AppHosts, to tell when it needs redrawing. */
const badgeKey = (hosts: RunningAppHost[]) =>
  hosts.map((h) => `${h.worktree}|${h.branch}|${h.dashboardUrl}`).join("\n");

function refreshAspire(maxAgeMs: number): Promise<void> {
  if (aspireInFlight) return aspireInFlight;
  if (Date.now() - aspireCheckedAt < maxAgeMs) return Promise.resolve();
  const ids = [...views.keys()].filter((id) => detectedRun.get(id));
  if (ids.length === 0) return Promise.resolve();
  const paths = ids.map((id) => views.get(id)!.project.path);
  aspireInFlight = aspireRunning(paths)
    .then((running) => {
      aspireCheckedAt = Date.now();
      let changed = false;
      ids.forEach((id, i) => {
        const next = running[paths[i]] ?? [];
        const previous = aspireState.get(id) ?? [];
        if (next.length) aspireState.set(id, next);
        else aspireState.delete(id);
        views.get(id)?.setAspire(next);
        if (badgeKey(previous) !== badgeKey(next)) changed = true;
      });
      if (changed) renderTabs();
    })
    // No aspire CLI, or it failed: leave the last answer standing.
    .catch(() => {})
    .finally(() => {
      aspireInFlight = null;
    });
  return aspireInFlight;
}

function startStatusPolling(): void {
  clearInterval(statusTimer);
  void refreshStatuses();
  statusTimer = setInterval(() => void refreshStatuses(), POLL_TICK_MS);
}

// Coming back to the window should put the caret back in the terminal you
// were using, not leave keystrokes going nowhere.
window.addEventListener("focus", () => {
  void refreshStatuses();
  refreshWaiting(false);
  if (modalEl.classList.contains("hidden")) currentView()?.active.focus();
});

/* ---------------------------------------------------------------- releases */

const releasesBtn = document.getElementById("releases-btn") as HTMLButtonElement;
const releasesPop = document.getElementById("releases-pop") as HTMLDivElement;
const toastsEl = document.getElementById("toasts") as HTMLDivElement;

/**
 * Where every tracked project stands against prod, open or not. Starts from
 * the last answer so the chips are there before the first check returns.
 */
let releases: Release[] = lastKnown();
let releasesCheckedAt: number | null = null;
let releasesLoading = false;

/** Deployments are slow to change, and each check is a few Azure requests per team project. */
const RELEASES_POLL_MS = 5 * 60_000;

const releaseFor = (id: string) => releases.find((r) => r.id === id);

const nudgeDaysFor = (id: string) => projectSettingsFor(id).releases.nudgeDays ?? DEFAULT_NUDGE_DAYS;

/** Your PRs and review requests everywhere, and the sources that couldn't be asked. */
let prs: MyPr[] = lastKnownPrs();
let prErrors: string[] = [];
let prsCheckedAt: number | null = null;
let prsLoading = false;
/** Every scanned project's path: they say which Azure orgs to ask and what's cloned. */
let knownPaths: string[] = [];

async function refreshPrs(force: boolean): Promise<void> {
  if (prsLoading || knownPaths.length === 0) return;
  if (!force && prsCheckedAt && Date.now() - prsCheckedAt < RELEASES_POLL_MS) return;
  prsLoading = true;
  renderReleases();
  try {
    const answer = await myPrs(knownPaths, force);
    prs = answer.prs;
    prErrors = answer.errors;
    prsCheckedAt = Date.now();
    rememberPrs(prs);
  } catch (err) {
    prErrors = [String(err)];
  } finally {
    prsLoading = false;
  }
  renderReleases();
}

/** Both halves of the panel; what the ⟳ button and the poll ask for. */
function refreshWaiting(force: boolean): void {
  void refreshReleases(force);
  void refreshPrs(force);
}

async function refreshReleases(force: boolean): Promise<void> {
  if (releasesLoading) return;
  if (!force && releasesCheckedAt && Date.now() - releasesCheckedAt < RELEASES_POLL_MS) return;
  if (![...projectSettings.values()].some((s) => s.releases?.track)) {
    releases = [];
    remember(releases);
    applyReleases();
    return;
  }
  releasesLoading = true;
  renderReleases();
  try {
    releases = await releasesAll(force);
    releasesCheckedAt = Date.now();
    remember(releases);
  } catch {
    // No az, no network: the last answer stands until the next check.
  } finally {
    releasesLoading = false;
  }
  applyReleases();
  for (const release of takeNudges(releases, nudgeDaysFor)) {
    showNudge(toastsEl, release, () => toggleReleases(true));
  }
}

/** Hands the answer to everything that shows it. */
function applyReleases(): void {
  for (const [id, view] of views) view.prs.setRelease(releaseFor(id) ?? null);
  renderReleases();
  renderTabs();
  redrawPicker?.();
}

/** The open picker's redraw, so its chips catch up when a check comes back. */
let redrawPicker: (() => void) | null = null;

/** The tab bar's count of tracked projects behind prod, and the panel if it's open. */
function renderReleases(): void {
  const waiting = releases.filter(needsAttention);
  const oldest = Math.max(0, ...waiting.map(daysWaiting));
  const counts = prCounts(prs);
  // The colour is the releases' age when any are behind; review requests
  // otherwise read as blue, the "someone needs you" colour.
  const tone = waiting.length ? ageClass(oldest) : counts.review ? "age-fresh" : "age-clear";
  releasesBtn.className = `rel-btn ${tone}`;
  releasesBtn.classList.toggle("on", !releasesPop.classList.contains("hidden"));
  const parts: string[] = [];
  if (waiting.length) parts.push(`⇡ ${waiting.length} not in prod · ${ageText(oldest)}`);
  if (counts.review) parts.push(`${counts.review} to review`);
  if (counts.ready) parts.push(`${counts.ready} ready`);
  releasesBtn.textContent = parts.length ? parts.join("  ·  ") : "✓ Nothing waiting";
  releasesBtn.title = [
    ...waiting.map((r) => `${r.name} — not in prod for ${ageText(daysWaiting(r))}`),
    counts.review ? `${counts.review} review request${counts.review === 1 ? "" : "s"}` : "",
    counts.ready ? `${counts.ready} of your PRs ready to complete` : "",
    "Click for everything waiting on you",
  ]
    .filter(Boolean)
    .join("\n");
  if (!releasesPop.classList.contains("hidden")) {
    // The older of the two answers is how fresh the panel is.
    const times = [releasesCheckedAt, prsCheckedAt].filter((t): t is number => t !== null);
    const data = {
      releases,
      prs,
      prErrors,
      checkedAt: times.length ? Math.min(...times) : null,
      loading: releasesLoading || prsLoading,
    };
    renderPanel(releasesPop, data, {
      isOpen: (id) => views.has(id),
      openProject: (id) => {
        toggleReleases(false);
        void openProject(views.get(id)?.project ?? { id, name: folderName(id), path: id });
      },
      settings: (id) => {
        toggleReleases(false);
        showProjectSettings(id);
      },
      refresh: () => refreshWaiting(true),
      close: () => toggleReleases(false),
      changed: () => {
        renderReleases();
        renderTabs();
      },
    });
  }
}

function toggleReleases(open = releasesPop.classList.contains("hidden")): void {
  releasesPop.classList.toggle("hidden", !open);
  renderReleases();
  if (open) refreshWaiting(false);
  else currentView()?.active.focus();
}

releasesBtn.onclick = () => toggleReleases();
// A click anywhere else puts the panel away, as a menu would.
document.addEventListener("pointerdown", (e) => {
  if (releasesPop.classList.contains("hidden")) return;
  const target = e.target as Node;
  if (!releasesPop.contains(target) && !releasesBtn.contains(target)) toggleReleases(false);
});

/* -------------------------------------------------------------------- tabs */

let draggingId: string | null = null;

/** A glyph per build state; the states with no glyph get no badge at all. */
const BUILD_GLYPH: Partial<Record<BuildState, string>> = {
  succeeded: "✓",
  failed: "✗",
  partial: "!",
  canceled: "⊘",
  running: "●",
  queued: "◌",
  waiting: "⏸",
  unknown: "?",
  error: "?",
};

const BUILD_WORD: Partial<Record<BuildState, string>> = {
  succeeded: "Succeeded",
  failed: "Failed",
  partial: "Partially succeeded",
  canceled: "Canceled",
  running: "Running",
  queued: "Queued",
  waiting: "Waiting for approval",
  unknown: "Finished",
};

/** "4m ago" — the badge has room for a glyph, the tooltip carries the rest. */
function ago(iso: string | null): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = (Date.now() - then) / 60_000;
  if (minutes < 1.5) return "just now";
  if (minutes < 90) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The build badge. Clicking opens the build in the browser — or, when there
 * isn't one to open, the settings sheet that explains why.
 */
function buildBadge(id: string): HTMLElement | null {
  const build = builds.get(id);
  const glyph = build && BUILD_GLYPH[build.state];
  if (!build || !glyph) return null;

  const badge = document.createElement("span");
  badge.className = `badge build ${build.state}`;
  badge.textContent = glyph;
  badge.title = build.error
    ? `Build status unavailable — ${build.error}`
    : [
        `${build.pipeline} ${build.number}`.trim(),
        [BUILD_WORD[build.state], build.branch, ago(build.time)].filter(Boolean).join(" · "),
        build.pipelines > 1 ? `Latest of ${build.pipelines} pipelines` : build.source,
      ]
        .filter(Boolean)
        .join("\n");
  // The tab underneath activates on pointerdown and starts a drag with it.
  badge.addEventListener("pointerdown", (e) => e.stopPropagation());
  badge.onclick = (e) => {
    e.stopPropagation();
    if (build.url) void openUrl(build.url);
    else showProjectSettings(id);
  };
  return badge;
}

/**
 * PRs that are yours or waiting on your review, once the PRs pane has loaded
 * for this tab. Red when one of yours has a failing build. Clicking opens the pane.
 */
function prBadge(id: string): HTMLElement | null {
  const view = views.get(id);
  const summary = view?.prs.summary();
  if (!view || !summary || summary.yours === 0) return null;
  const badge = document.createElement("span");
  badge.className = "badge prs" + (summary.failing ? " failing" : "") + (summary.toReview ? " review" : "");
  badge.textContent = `PR ${summary.yours}`;
  badge.title = [
    `${summary.yours} open PR${summary.yours === 1 ? "" : "s"} of yours or waiting on you`,
    summary.toReview ? `${summary.toReview} waiting on your review` : "",
    summary.failing ? "One of yours has a failing build" : "",
    "Click for PRs & builds",
  ]
    .filter(Boolean)
    .join("\n");
  badge.addEventListener("pointerdown", (e) => e.stopPropagation());
  badge.onclick = (e) => {
    e.stopPropagation();
    activate(id);
    view.togglePrs(true);
  };
  return badge;
}

/** The pending-changes, branch-count and build badges after the tab name. */
function statusBadges(id: string): HTMLElement | null {
  const status = statuses.get(id);

  const wrap = document.createElement("span");
  wrap.className = "tab-badges";

  if (status && !status.error && status.pending > 0) {
    const pending = document.createElement("span");
    pending.className = "badge pending";
    pending.textContent = String(status.pending);
    pending.title = `${status.pending} uncommitted file${status.pending === 1 ? "" : "s"}`;
    wrap.appendChild(pending);
  }
  if (status && !status.error && status.branches > 0) {
    const branches = document.createElement("span");
    branches.className = "badge branches";
    branches.textContent = `⎇${status.branches}`;
    branches.title =
      `${status.branches} applied branch${status.branches === 1 ? "" : "es"}` +
      ` across ${status.stacks} stack${status.stacks === 1 ? "" : "s"}`;
    wrap.appendChild(branches);
  }
  const hosts = aspireState.get(id) ?? [];
  if (hosts.length) {
    // The project's own checkout first: its dashboard is the one a click opens.
    const sorted = [...hosts].sort((a, b) => Number(!!a.worktree) - Number(!!b.worktree));
    const target = sorted.find((h) => h.dashboardUrl);
    const running = document.createElement("span");
    running.className = "badge aspire";
    running.textContent = hosts.length > 1 ? `◆${hosts.length}` : "◆";
    const lines = sorted.map((h) => `${worktreeName(h)}${h.dashboardUrl ? ` · ${h.dashboardUrl}` : ""}`);
    running.title =
      `Aspire is running\n${lines.join("\n")}` +
      (target ? `\nClick for ${worktreeName(target)}'s dashboard` : "");
    running.addEventListener("pointerdown", (e) => e.stopPropagation());
    running.onclick = (e) => {
      e.stopPropagation();
      if (target?.dashboardUrl) void openUrl(target.dashboardUrl);
    };
    wrap.appendChild(running);
  }
  const prs = prBadge(id);
  if (prs) wrap.appendChild(prs);
  const build = buildBadge(id);
  if (build) wrap.appendChild(build);
  const release = releaseChip(releaseFor(id), () => toggleReleases(true));
  if (release) wrap.appendChild(release);
  return wrap.childElementCount ? wrap : null;
}

function renderTabs(): void {
  tabsEl.replaceChildren();
  order.forEach((id, i) => {
    const view = views.get(id)!;
    const tab = document.createElement("div");
    tab.className = "tab" + (id === activeId ? " active" : "");
    if (id === draggingId) tab.classList.add("dragging");
    tab.title = `${view.project.path}\nCtrl+${i + 1} · right-click for settings`;
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showProjectSettings(id);
    });
    // Activate on press rather than click: the same gesture starts a drag, and
    // waiting for mouseup to switch tabs feels laggy.
    tab.addEventListener("pointerdown", (e) => {
      if (e.button === 1) {
        closeProject(id);
        return;
      }
      if (e.button !== 0) return;
      activate(id);
      beginTabDrag(id, e);
    });

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = view.project.name;

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "Close project (Ctrl+W)";
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    close.onclick = (e) => {
      e.stopPropagation();
      closeProject(id);
    };

    const badges = statusBadges(id);
    if (badges) tab.append(label, badges, close);
    else tab.append(label, close);
    tabsEl.appendChild(tab);
  });
}

/** Index the pointer currently sits over, by tab midpoints. */
function tabIndexAt(x: number): number {
  const tabs = [...tabsEl.children] as HTMLElement[];
  for (let i = 0; i < tabs.length; i++) {
    const rect = tabs[i].getBoundingClientRect();
    if (x < rect.left + rect.width / 2) return i;
  }
  return tabs.length - 1;
}

function moveTab(id: string, to: number): boolean {
  const from = order.indexOf(id);
  const target = Math.max(0, Math.min(order.length - 1, to));
  if (from < 0 || from === target) return false;
  order.splice(target, 0, ...order.splice(from, 1));
  renderTabs();
  return true;
}

/**
 * Reorders live while the pointer moves, so the strip always shows where the
 * tab will land. The drag only engages past a few pixels — otherwise every
 * tab click with a twitchy hand would count as a reorder.
 */
function beginTabDrag(id: string, down: PointerEvent): void {
  const originX = down.clientX;
  let engaged = false;

  const onMove = (move: PointerEvent) => {
    if (!engaged) {
      if (Math.abs(move.clientX - originX) < 5) return;
      engaged = true;
      draggingId = id;
      document.body.classList.add("dragging-tab");
      renderTabs();
    }
    moveTab(id, tabIndexAt(move.clientX));
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    if (!engaged) return;
    draggingId = null;
    document.body.classList.remove("dragging-tab");
    renderTabs();
    rememberSession();
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function shiftActiveTab(direction: 1 | -1): void {
  if (!activeId) return;
  if (moveTab(activeId, order.indexOf(activeId) + direction)) rememberSession();
}

/* ------------------------------------------------------------------- modal */

/**
 * A sheet with edits in it can refuse a close (Esc, ×, a backdrop click) by
 * returning false, so unsaved changes take a second Esc to throw away.
 */
let modalGuard: (() => boolean) | null = null;
/** Where a sheet goes back to when it's dismissed: the picker, for settings opened from it. */
let modalBack: (() => void) | null = null;

function requestCloseModal(): void {
  if (modalGuard && !modalGuard()) return;
  const back = modalBack;
  closeModal();
  back?.();
}

function closeModal(): void {
  redrawPicker = null;
  modalGuard = null;
  modalBack = null;
  modalEl.classList.add("hidden");
  modalEl.replaceChildren();
  if (activeId) views.get(activeId)?.active.focus();
}

/** `build` fills the body, and may hand back a footer that stays put while the body scrolls. */
function openModal(build: (body: HTMLDivElement) => HTMLElement | void, title: string): HTMLDivElement {
  redrawPicker = null;
  modalGuard = null;
  modalBack = null;
  modalEl.replaceChildren();
  const sheet = document.createElement("div");
  sheet.className = "sheet";

  const header = document.createElement("div");
  header.className = "sheet-header";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const dismiss = document.createElement("button");
  dismiss.className = "sheet-close";
  dismiss.textContent = "×";
  dismiss.onclick = requestCloseModal;
  header.append(heading, dismiss);

  const body = document.createElement("div");
  body.className = "sheet-body";
  const footer = build(body);

  sheet.append(header, body);
  if (footer) sheet.append(footer);
  modalEl.appendChild(sheet);
  modalEl.classList.remove("hidden");
  modalEl.onclick = (e) => {
    if (e.target === modalEl) requestCloseModal();
  };
  return body;
}

async function showProjectPicker(): Promise<void> {
  const root = getSettings().scanRoot;
  let projects: Project[] = [];
  let loadError: string | null = null;
  try {
    projects = await listProjects(root);
    knownPaths = projects.map((p) => p.path);
  } catch (err) {
    loadError = String(err);
  }

  openModal((body) => {
    if (loadError || projects.length === 0) {
      const hint = document.createElement("p");
      hint.className = "muted";
      hint.textContent = loadError ?? `No git repositories directly under ${root}.`;
      body.appendChild(hint);
      return;
    }

    const filter = document.createElement("input");
    filter.className = "filter";
    filter.placeholder = `Filter ${projects.length} repos in ${root}…`;
    body.appendChild(filter);

    const list = document.createElement("div");
    list.className = "list";
    body.appendChild(list);

    let matches: Project[] = [];
    let cursor = 0;

    const draw = (raw: string) => {
      const needle = raw.toLowerCase();
      // Repos already open sort last: the picker is for the ones you haven't
      // got in front of you yet.
      matches = projects
        .filter((p) => matchesSubsequence(needle, p.name))
        .sort((a, b) => Number(views.has(a.id)) - Number(views.has(b.id)));
      cursor = Math.min(cursor, Math.max(0, matches.length - 1));

      list.replaceChildren();
      matches.forEach((project, index) => {
        const row = document.createElement("div");
        row.className = "row" + (views.has(project.id) ? " open" : "");
        row.classList.toggle("cursor", index === cursor);
        row.onclick = async () => {
          closeModal();
          await openProject(project);
        };

        const name = document.createElement("div");
        name.className = "row-name";
        name.textContent = project.name;
        row.appendChild(name);

        // Release tracking is set here as well as in settings, because the
        // projects it matters most for are the ones that aren't open.
        const rowButton = (label: string, title: string, onClick: () => void) => {
          const button = document.createElement("button");
          button.className = "row-btn";
          button.textContent = label;
          button.title = title;
          button.onclick = (e) => {
            e.stopPropagation();
            onClick();
          };
          row.appendChild(button);
        };
        if (projectSettingsFor(project.id).releases.track) {
          const chip = releaseChip(releaseFor(project.id), () => {
            closeModal();
            toggleReleases(true);
          });
          if (chip) row.appendChild(chip);
        } else {
          rowButton("Track releases", "Show what's on the default branch but not in prod, open or not", () => {
            void setTracked(project.id, true).then(() => draw(filter.value));
            draw(filter.value);
          });
        }
        rowButton("⚙", "Project settings", () =>
          showProjectSettings(project.id, { back: () => void showProjectPicker() }),
        );
        list.appendChild(row);
      });
    };

    filter.oninput = () => {
      cursor = 0;
      draw(filter.value);
    };
    filter.onkeydown = async (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        cursor = Math.max(0, Math.min(matches.length - 1, cursor + step));
        draw(filter.value);
        list.children[cursor]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && matches[cursor]) {
        e.preventDefault();
        const project = matches[cursor];
        closeModal();
        await openProject(project);
      }
    };
    draw("");
    redrawPicker = () => draw(filter.value);
    setTimeout(() => filter.focus(), 0);
  }, "Open a project");
}

/* -------------------------------------------------------- project settings */

/**
 * Settings that belong to one repository rather than the app. They're keyed by
 * repository path and kept beside the session in the app's config dir, not in a
 * dotfile inside the repo: these are work repos shared with other people, and a
 * tool's preferences have no business dirtying them.
 */
const projectSettings = new Map<string, ProjectSettings>();

function projectSettingsFor(id: string): ProjectSettings {
  const stored = projectSettings.get(id);
  return {
    builds: stored?.builds ?? emptyBuildConfig(),
    // Settings saved before the run pane existed have no `run` at all.
    run: stored?.run ?? emptyRunConfig(),
    prs: stored?.prs ?? emptyPrsConfig(),
    releases: stored?.releases ?? emptyReleasesConfig(),
  };
}

/** A project's folder name, for one that isn't open and so has no Project to ask. */
const folderName = (id: string) => id.split(/[\\/]/).filter(Boolean).pop() ?? id;

/** Turns release tracking on or off for a project, open or not. */
async function setTracked(id: string, on: boolean): Promise<void> {
  const current = projectSettingsFor(id);
  const next: ProjectSettings = { ...current, releases: { ...current.releases, track: on ? true : null } };
  projectSettings.set(id, next);
  await saveProjectSettings(id, next).catch(showFatal);
  await refreshReleases(true);
}

/** What each open project would run with no command of its own: `aspire run` for an AppHost. */
const detectedRun = new Map<string, string | null>();

/** The run pane's command for a project, or null when it has no ▶ button. */
function runSpecFor(id: string): RunSpec | null {
  const { mode, command } = projectSettingsFor(id).run;
  if (mode === "off") return null;
  const resolved = command ?? detectedRun.get(id) ?? null;
  return resolved ? { command: resolved, auto: mode === "auto" } : null;
}

/** A blank field means "not set", rather than "set to empty". */
const trimmed = (value: string): string | null => value.trim() || null;

/** What the poll last made of this project, in a sentence. */
function buildSummary(build: BuildStatus | undefined): string {
  if (!build) return "Nothing polled yet.";
  if (build.state === "off") return "Turned off for this project.";
  if (build.error) return build.source ? `${build.source} — ${build.error}` : build.error;
  if (build.state === "none") return "No Azure DevOps remote on this repository.";
  const word = (BUILD_WORD[build.state] ?? build.state).toLowerCase();
  return `${build.source} — ${build.pipeline} ${build.number} ${word} ${ago(build.time)}`.trim();
}

/**
 * A project's settings, open or not: release tracking is set from the picker
 * for projects that aren't. Grouped by what each setting drives, with the
 * Azure DevOps coordinates (needed only when detection is wrong) folded away
 * behind the line that says what was detected. Enter saves; Esc asks before
 * throwing edits away. `back` is where Cancel and Save return to.
 */
function showProjectSettings(id: string, opts: { back?: () => void } = {}): void {
  const view = views.get(id);
  const { builds: current, run: currentRun, prs: currentPrs, releases: currentReleases } = projectSettingsFor(id);
  const detectedCommand = detectedRun.get(id) ?? null;
  const build = builds.get(id);
  const name = view?.project.name ?? folderName(id);

  openModal((body) => {
    const form = document.createElement("div");
    form.className = "form";
    body.appendChild(form);

    const section = (title: string): void => {
      const head = document.createElement("div");
      head.className = "form-sep";
      head.textContent = title;
      form.appendChild(head);
    };

    /** A label row, or a plain div for controls a label would misdirect clicks in (lists). */
    const field = (label: string, hint: string, control: HTMLElement, asLabel = true): HTMLElement => {
      const row = document.createElement(asLabel ? "label" : "div");
      row.className = "form-row";
      const heading = document.createElement("div");
      heading.className = "form-label";
      heading.textContent = label;
      const note = document.createElement("div");
      note.className = "form-hint";
      note.textContent = hint;
      heading.appendChild(note);
      row.append(heading, control);
      form.appendChild(row);
      return row;
    };

    const note = (text: string): HTMLParagraphElement => {
      const p = document.createElement("p");
      p.className = "form-note";
      p.textContent = text;
      form.appendChild(p);
      return p;
    };

    const textbox = (value: string | null, placeholder: string): HTMLInputElement => {
      const el = document.createElement("input");
      el.className = "form-input";
      el.value = value ?? "";
      el.placeholder = placeholder;
      el.spellcheck = false;
      return el;
    };

    const select = (options: string[][], value: string): HTMLSelectElement => {
      const el = document.createElement("select");
      el.className = "form-input";
      for (const [v, label] of options) {
        const option = document.createElement("option");
        option.value = v;
        option.textContent = label;
        el.appendChild(option);
      }
      el.value = value;
      return el;
    };

    /** An on/off switch; returns the checkbox inside it. */
    const toggle = (checked: boolean): [HTMLElement, HTMLInputElement] => {
      const wrap = document.createElement("span");
      wrap.className = "toggle";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = checked;
      wrap.append(input, Object.assign(document.createElement("span"), { className: "toggle-track" }));
      return [wrap, input];
    };

    /* Where the Azure DevOps coordinates come from. Most projects never
       need the overrides, so they stay folded until asked for or in use. */
    const sourceRow = document.createElement("div");
    sourceRow.className = "form-source";
    const sourceText = document.createElement("span");
    sourceText.className = "form-source-text";
    sourceText.textContent = "Azure DevOps: looking…";
    const change = document.createElement("button");
    change.className = "link-btn";
    change.type = "button";
    sourceRow.append(sourceText, change);
    form.appendChild(sourceRow);

    const overrides = document.createElement("div");
    overrides.className = "form form-overrides";
    form.appendChild(overrides);
    const overridden = [current.organization, current.project, current.repository].some(Boolean);
    const setOverridesOpen = (open: boolean) => {
      overrides.classList.toggle("hidden", !open);
      change.textContent = open ? "Hide overrides" : "Change…";
    };
    setOverridesOpen(overridden);
    change.onclick = () => setOverridesOpen(overrides.classList.contains("hidden"));

    const organization = textbox(current.organization, "from the remote");
    const project = textbox(current.project, "from the remote");
    const repository = textbox(current.repository, "from the remote");
    // Rows go into the fold, not the main form.
    const fold = (label: string, hint: string, control: HTMLElement) => overrides.appendChild(field(label, hint, control));
    fold("Organisation", "dev.azure.com/<organisation>", organization);
    fold("Project", "The team project the pipelines live in.", project);
    fold("Repository", "The repository's name in Azure DevOps.", repository);

    section("Run");
    const runMode = select(
      [
        ["button", "A ▶ button on the TUI"],
        ["auto", "Start when the tab opens"],
        ["off", "Off"],
      ],
      currentRun.mode ?? "button",
    );
    const runCommand = textbox(currentRun.command, detectedCommand ?? "e.g. npm run dev");
    field(
      "Run",
      detectedCommand ? "Found an Aspire AppHost. Runs in a pane on the right." : "A long-running command, in a pane on the right.",
      runMode,
    );
    const commandRow = field("Command", "Through your shell. Blank uses what was detected.", runCommand);

    section("PRs & builds");
    const [prsToggle, prsOpen] = toggle(currentPrs.open === true);
    field("Open with the tab", "The PRs & builds pane opens when the tab does. Ctrl+Shift+P either way.", prsToggle);
    const badgeMode = select(
      [
        ["auto", "Auto — on for Azure DevOps"],
        ["on", "Always on"],
        ["off", "Off"],
      ],
      current.enabled === null ? "auto" : current.enabled ? "on" : "off",
    );
    field("Build badge", "The latest build, on the tab.", badgeMode);

    // Pipelines: ticked by name once Azure answers; ids typed by hand until then.
    const picked = new Set(current.definitions);
    const pipelinesBox = document.createElement("div");
    pipelinesBox.className = "pick-list";
    const idsBox = textbox(current.definitions.join(", "), "every pipeline building this repo");
    pipelinesBox.appendChild(idsBox);
    let pipelinesListed = false;
    const pipelinesRow = field("Pipelines", "None ticked follows every pipeline that builds this repository.", pipelinesBox, false);
    const branch = textbox(current.branch, "whichever branch built last");
    const branchRow = field("Branch", "Only report builds of this branch.", branch);
    if (view) note(buildSummary(build));

    section("Releases");
    const [trackToggle, track] = toggle(currentReleases.track === true);
    field("Track releases", "What's on the default branch but not in prod. Watched whether or not the project is open.", trackToggle);
    const environment = textbox(currentReleases.environment, "Production");
    const environments = document.createElement("datalist");
    environments.id = "environment-options";
    environment.setAttribute("list", environments.id);
    body.appendChild(environments);
    const environmentRow = field("Environment", "The Azure DevOps environment that counts as prod.", environment);
    const nudge = select(
      [
        ["", `After ${DEFAULT_NUDGE_DAYS} days`],
        ["7", "After 7 days"],
        ["30", "After 30 days"],
        ["0", "Never"],
      ],
      currentReleases.nudgeDays === null ? "" : String(currentReleases.nudgeDays),
    );
    const nudgeRow = field("Nudge", "A notification once the oldest unreleased work is this old.", nudge);
    note(releaseSummary(releaseFor(id), currentReleases.track === true));

    /* Settings that only matter when another is on say so by greying out. */
    const sync = () => {
      const setOff = (row: HTMLElement, off: boolean) => {
        row.classList.toggle("disabled", off);
        row.querySelectorAll("input, select").forEach((c) => ((c as HTMLInputElement).disabled = off));
      };
      setOff(commandRow, runMode.value === "off");
      setOff(pipelinesRow, badgeMode.value === "off");
      setOff(branchRow, badgeMode.value === "off");
      setOff(environmentRow, !track.checked);
      setOff(nudgeRow, !track.checked);
    };
    form.addEventListener("change", sync);
    sync();

    const collectBuilds = () => ({
      enabled: badgeMode.value === "auto" ? null : badgeMode.value === "on",
      organization: trimmed(organization.value),
      project: trimmed(project.value),
      repository: trimmed(repository.value),
      definitions: pipelinesListed
        ? [...picked].sort((a, b) => a - b)
        : // Anything that isn't a positive integer was never a definition id.
          idsBox.value
            .split(/[\s,]+/)
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0),
      branch: trimmed(branch.value),
    });

    const collect = (): ProjectSettings => ({
      builds: collectBuilds(),
      run: {
        // A button is the default, so it's stored as no choice at all.
        mode: runMode.value === "button" ? null : (runMode.value as "auto" | "off"),
        command: trimmed(runCommand.value),
      },
      // Off and the defaults are stored as no choice at all.
      prs: { open: prsOpen.checked ? true : null },
      releases: {
        track: track.checked ? true : null,
        environment: trimmed(environment.value),
        nudgeDays: nudge.value === "" ? null : Number(nudge.value),
      },
    });

    /* Ask Azure what there is to pick from, and say where the coordinates came
       from. Again when an override changes, since that changes the answer. */
    let asked = 0;
    const loadOptions = async () => {
      const ticket = ++asked;
      const options = await azureOptions(id, collectBuilds()).catch((err) => ({
        source: "",
        detected: [] as string[],
        remote: "",
        pipelines: [],
        environments: [] as string[],
        error: String(err),
      }));
      if (ticket !== asked) return;
      const [org, proj, repo] = options.detected;
      organization.placeholder = org || "from the remote";
      project.placeholder = proj || "from the remote";
      repository.placeholder = repo || "from the remote";
      const anyOverride = [organization.value, project.value, repository.value].some((v) => v.trim());
      sourceText.replaceChildren();
      const label = document.createElement("b");
      label.textContent = "Azure DevOps ";
      sourceText.append(label, options.source || "not found");
      const from = document.createElement("span");
      from.className = "muted";
      from.textContent = options.source
        ? anyOverride
          ? " · overridden here"
          : ` · from ${options.remote || "the remote"}`
        : "";
      sourceText.appendChild(from);
      if (options.error) {
        const err = document.createElement("div");
        err.className = "form-source-error";
        err.textContent = options.error;
        sourceText.appendChild(err);
        if (!options.source) setOverridesOpen(true);
      }

      environments.replaceChildren(
        ...options.environments.map((e) => Object.assign(document.createElement("option"), { value: e })),
      );

      if (options.pipelines.length) {
        pipelinesListed = true;
        pipelinesBox.replaceChildren();
        for (const p of options.pipelines) {
          const item = document.createElement("label");
          item.className = "pick";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = picked.has(p.id);
          box.onchange = () => (box.checked ? picked.add(p.id) : picked.delete(p.id));
          item.append(box, document.createTextNode(` ${p.name}`));
          item.title = `Definition ${p.id}`;
          pipelinesBox.appendChild(item);
        }
        sync();
      }
    };
    for (const box of [organization, project, repository]) box.addEventListener("change", () => void loadOptions());
    void loadOptions();

    /* Footer: stays in view however far the body scrolls. */
    const footer = document.createElement("div");
    footer.className = "sheet-footer";
    const hint = document.createElement("span");
    hint.className = "sheet-hint";
    hint.textContent = "Enter saves · Esc cancels";
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    cancel.onclick = requestCloseModal;
    const saveButton = document.createElement("button");
    saveButton.className = "btn primary";
    saveButton.textContent = "Save";
    footer.append(hint, cancel, saveButton);

    const initial = JSON.stringify(collect());
    let discardArmed = false;
    modalGuard = () => {
      if (discardArmed || JSON.stringify(collect()) === initial) return true;
      discardArmed = true;
      hint.textContent = "Unsaved changes — Esc again to discard";
      hint.classList.add("warn");
      return false;
    };
    modalBack = opts.back ?? null;

    const save = async () => {
      const next = collect();
      projectSettings.set(id, next);
      const back = opts.back;
      closeModal();
      if (view) {
        view.configureRun(runSpecFor(id));
        if (next.prs.open && !currentPrs.open) view.togglePrs(true);
        if (id === activeId) view.activated();
      }
      // Drop the old answer rather than leaving a badge that the new settings
      // no longer stand behind.
      builds.delete(id);
      lastPolled.delete(id);
      renderTabs();
      back?.();
      await saveProjectSettings(id, next).catch(showFatal);
      const releasesChanged = JSON.stringify(next.releases) !== JSON.stringify(currentReleases);
      // The overrides also say where releases and PRs are read from.
      const coordsChanged = JSON.stringify(next.builds) !== JSON.stringify(current);
      if (releasesChanged || (next.releases.track && coordsChanged)) await refreshReleases(true);
      if (coordsChanged) void view?.prs.refresh(true);
      await refreshStatuses();
    };
    saveButton.onclick = () => void save();
    body.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement;
      if (e.key !== "Enter" || e.isComposing || target.tagName === "BUTTON") return;
      e.preventDefault();
      void save();
    });

    setTimeout(() => runMode.focus(), 0);
    return footer;
  }, `${name} settings`);
}

/** Where the release tracker last left this project, in a sentence. */
function releaseSummary(release: Release | undefined, tracked: boolean): string {
  if (!tracked) return "Not tracked. Turn it on to see what's on the default branch but not in prod.";
  if (!release) return "Not checked yet.";
  if (release.state === "error" || release.state === "none") return release.error ?? "Release status unavailable.";
  const prod = `${release.environment} has ${release.prod?.number ?? "?"}`;
  if (release.state === "level") return `${prod}, level with ${release.branch}.`;
  const count = release.commits.length || release.runsBehind;
  const unit = release.commits.length ? "commit" : "run";
  return `${prod}. ${release.branch} is ${count} ${unit}${count === 1 ? "" : "s"} ahead; the oldest has waited ${ageText(daysWaiting(release))}.`;
}

/* --------------------------------------------------------------- shortcuts */

function currentView(): ProjectView | null {
  return activeId ? (views.get(activeId) ?? null) : null;
}

window.addEventListener(
  "keydown",
  (e) => {
    // AltGr arrives as Ctrl+Alt on Windows; it's typing, not a shortcut.
    if (!e.ctrlKey || e.getModifierState("AltGraph")) return;
    const view = currentView();
    const take = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    // New terminals: T a tab, D right, E down. Alt makes it the second
    // profile (claude) rather than the shell.
    const place = ({ KeyT: "tab", KeyD: "x", KeyE: "y" } as const)[e.code as "KeyT" | "KeyD" | "KeyE"];
    if (e.shiftKey && place) {
      take();
      view?.newTerminal(place, e.altKey ? 1 : 0);
      return;
    }
    if (e.altKey) return;

    if (e.shiftKey && e.code === "KeyW") {
      take();
      view?.closeActivePane();
    } else if (!e.shiftKey && (e.code === "PageUp" || e.code === "PageDown")) {
      take();
      view?.cycleTab(e.code === "PageDown" ? 1 : -1);
    } else if (!e.shiftKey && e.code === "F5") {
      take();
      void view?.openRun();
    } else if (e.shiftKey && e.code === "KeyP") {
      take();
      view?.togglePrs();
    } else if (e.shiftKey && e.code === "KeyR") {
      take();
      void view?.tui.restart();
    } else if (e.shiftKey && (e.code === "PageUp" || e.code === "PageDown")) {
      take();
      shiftActiveTab(e.code === "PageDown" ? 1 : -1);
    } else if (e.code === "Tab") {
      take();
      cycleProject(e.shiftKey ? -1 : 1);
    } else if (!e.shiftKey && e.code === "KeyT") {
      take();
      void showProjectPicker();
    } else if (!e.shiftKey && e.code === "KeyW") {
      take();
      if (activeId) closeProject(activeId);
    } else if (e.code === "Comma") {
      take();
      if (activeId) showProjectSettings(activeId);
    } else if (e.code === "BracketRight" || (e.shiftKey && e.code === "Backquote")) {
      take();
      view?.cyclePane(1);
    } else if (/^Digit[1-9]$/.test(e.code)) {
      take();
      const index = Number(e.code.slice(5)) - 1;
      if (order[index]) activate(order[index]);
    }
  },
  { capture: true },
);

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!modalEl.classList.contains("hidden")) requestCloseModal();
  else if (!releasesPop.classList.contains("hidden")) toggleReleases(false);
});

window.addEventListener("resize", () => currentView()?.fitAll());

// The debounced write may still be pending when the window goes; flush it.
void getCurrentWindow().onCloseRequested(async () => {
  clearTimeout(sessionTimer);
  await saveSession([...order], activeId).catch(() => {});
});

/* ------------------------------------------------------------------- start */

(document.getElementById("add-tab") as HTMLButtonElement).onclick = () => void showProjectPicker();
(document.getElementById("empty-add") as HTMLButtonElement).onclick = () =>
  void showProjectPicker();

/**
 * Anything that escapes to the top level would otherwise leave a blank window
 * with no clue why, so put it on screen.
 */
function showFatal(detail: unknown): void {
  emptyEl.classList.remove("hidden");
  const existing = emptyEl.querySelector(".fatal");
  const box = existing ?? document.createElement("pre");
  box.className = "fatal";
  box.textContent = String(
    detail instanceof Error ? (detail.stack ?? detail.message) : detail,
  );
  if (!existing) emptyEl.appendChild(box);
}

window.addEventListener("error", (e) => showFatal(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => showFatal(e.reason));

/** Reopens last run's tabs, in their old order. Returns how many came back. */
async function restoreSession(projects: Project[]): Promise<number> {
  const session = await getSession().catch(() => null);
  if (!session?.open.length) return 0;

  const byId = new Map(projects.map((p) => [p.id, p]));
  restoring = true;
  try {
    for (const id of session.open) {
      const project = byId.get(id);
      // Sequential, not Promise.all: a dozen ptys starting at once makes for a
      // slow, flickery launch.
      if (project) await openProject(project);
    }
  } finally {
    restoring = false;
  }
  if (session.active && views.has(session.active)) activate(session.active);
  // Whichever tab restore left in front gets the start it was held back from.
  currentView()?.activated();
  return views.size;
}

async function boot(): Promise<void> {
  // A dev-server reload drops the panes but not the processes behind them.
  await invoke("pty_kill_all").catch(() => {});
  // Before any tab opens: the first status poll needs each project's settings.
  for (const [id, settings] of Object.entries(await projectSettingsAll().catch(() => ({})))) {
    projectSettings.set(id, settings);
  }
  const projects = await listProjects(getSettings().scanRoot);
  knownPaths = projects.map((p) => p.path);
  if (await restoreSession(projects)) return;
  emptyEl.classList.remove("hidden");
  void showProjectPicker();
}

/**
 * Release tracking polls on its own, tabs or none: the projects it watches are
 * mostly closed ones. Like the status poll, only while the window has focus.
 */
function startReleasePolling(): void {
  renderReleases();
  refreshWaiting(false);
  setInterval(() => {
    if (document.hasFocus()) refreshWaiting(false);
  }, 60_000);
}

void boot()
  .then(() => {
    startStatusPolling();
    startReleasePolling();
  })
  .catch(showFatal);
