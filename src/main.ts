import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  aspireRunning,
  aspireStop,
  buildStatus,
  detectRun,
  emptyBuildConfig,
  emptyPrsConfig,
  emptyRunConfig,
  getSession,
  listProjects,
  matchesSubsequence,
  projectSettingsAll,
  projectStatus,
  saveProjectSettings,
  saveSession,
  type BuildState,
  type BuildStatus,
  type Project,
  type ProjectSettings,
  type ProjectStatus,
  type RunningAppHost,
  worktreeName,
} from "./projects";
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
  if (modalEl.classList.contains("hidden")) currentView()?.active.focus();
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

function closeModal(): void {
  modalEl.classList.add("hidden");
  modalEl.replaceChildren();
  if (activeId) views.get(activeId)?.active.focus();
}

function openModal(build: (body: HTMLDivElement) => void, title: string): HTMLDivElement {
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
  dismiss.onclick = closeModal;
  header.append(heading, dismiss);

  const body = document.createElement("div");
  body.className = "sheet-body";
  build(body);

  sheet.append(header, body);
  modalEl.appendChild(sheet);
  modalEl.classList.remove("hidden");
  modalEl.onclick = (e) => {
    if (e.target === modalEl) closeModal();
  };
  return body;
}

async function showProjectPicker(): Promise<void> {
  const root = getSettings().scanRoot;
  let projects: Project[] = [];
  let loadError: string | null = null;
  try {
    projects = await listProjects(root);
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
  };
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

function showProjectSettings(id: string): void {
  const view = views.get(id);
  if (!view) return;
  const current = projectSettingsFor(id).builds;
  const currentRun = projectSettingsFor(id).run;
  const currentPrs = projectSettingsFor(id).prs;
  const detectedCommand = detectedRun.get(id) ?? null;
  const build = builds.get(id);
  // `org / project / repo` as the poll resolved it, so the override boxes can
  // show what they'd be overriding.
  const detected = (build?.source ?? "").split(" / ");

  openModal((body) => {
    const form = document.createElement("div");
    form.className = "form";

    const field = (label: string, hint: string, control: HTMLElement): void => {
      const row = document.createElement("label");
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
    };

    const textbox = (value: string | null, placeholder: string): HTMLInputElement => {
      const el = document.createElement("input");
      el.className = "form-input";
      el.value = value ?? "";
      el.placeholder = placeholder;
      el.spellcheck = false;
      return el;
    };

    const select = (options: string[][]): HTMLSelectElement => {
      const el = document.createElement("select");
      el.className = "form-input";
      for (const [value, label] of options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        el.appendChild(option);
      }
      return el;
    };

    const runMode = select([
      ["button", "A ▶ button on the TUI"],
      ["auto", "Start when the tab opens"],
      ["off", "Off"],
    ]);
    runMode.value = currentRun.mode ?? "button";
    const runCommand = textbox(currentRun.command, detectedCommand ?? "e.g. npm run dev");

    field(
      "Run",
      detectedCommand
        ? "Found an Aspire AppHost. Runs in a pane on the right."
        : "A long-running command, in a pane on the right.",
      runMode,
    );
    field("Run command", "Through your shell. Blank uses what was detected.", runCommand);

    const prsMode = select([
      ["closed", "Closed until Ctrl+Shift+P"],
      ["open", "Open when the tab opens"],
    ]);
    prsMode.value = currentPrs.open ? "open" : "closed";
    field("PRs & builds", "Open PRs, their checks, and recent pipeline runs, from the remote.", prsMode);

    const mode = select([
      ["auto", "Auto — on when the remote is Azure DevOps"],
      ["on", "Always on"],
      ["off", "Off"],
    ]);
    mode.value = current.enabled === null ? "auto" : current.enabled ? "on" : "off";

    const organization = textbox(current.organization, detected[0] || "from the remote");
    const project = textbox(current.project, detected[1] || "from the remote");
    const repository = textbox(current.repository, detected[2] || "from the remote");
    const definitions = textbox(current.definitions.join(", "), "every pipeline building this repo");
    const branch = textbox(current.branch, "whichever branch built last");

    field("Build badge", "A third badge with the latest Azure DevOps build.", mode);
    field("Organisation", "dev.azure.com/<organisation>", organization);
    field("Project", "The team project the pipelines live in.", project);
    field("Repository", "The repository name in Azure DevOps.", repository);
    field("Pipelines", "Definition ids, comma separated. Blank finds them by repository.", definitions);
    field("Branch", "Only report builds of this branch.", branch);
    body.appendChild(form);

    const status = document.createElement("p");
    status.className = "muted form-note";
    status.textContent = buildSummary(build);
    body.appendChild(status);

    const actions = document.createElement("div");
    actions.className = "sheet-actions end";
    const save = document.createElement("button");
    save.className = "btn primary";
    save.textContent = "Save";
    save.onclick = async () => {
      const next: ProjectSettings = {
        builds: {
          enabled: mode.value === "auto" ? null : mode.value === "on",
          organization: trimmed(organization.value),
          project: trimmed(project.value),
          repository: trimmed(repository.value),
          // Anything that isn't a positive integer was never a definition id.
          definitions: definitions.value
            .split(/[\s,]+/)
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0),
          branch: trimmed(branch.value),
        },
        run: {
          // A button is the default, so it's stored as no choice at all.
          mode: runMode.value === "button" ? null : (runMode.value as "auto" | "off"),
          command: trimmed(runCommand.value),
        },
        // Closed is the default, so it's stored as no choice at all.
        prs: { open: prsMode.value === "open" ? true : null },
      };
      projectSettings.set(id, next);
      closeModal();
      view.configureRun(runSpecFor(id));
      if (next.prs.open && !currentPrs.open) view.togglePrs(true);
      if (id === activeId) view.activated();
      // Drop the old answer rather than leaving a badge that the new settings
      // no longer stand behind.
      builds.delete(id);
      lastPolled.delete(id);
      renderTabs();
      await saveProjectSettings(id, next).catch(showFatal);
      await refreshStatuses();
    };
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    cancel.onclick = closeModal;
    actions.append(save, cancel);
    body.appendChild(actions);

    setTimeout(() => runMode.focus(), 0);
  }, `${view.project.name} settings`);
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
  if (e.key === "Escape" && !modalEl.classList.contains("hidden")) closeModal();
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
  if (await restoreSession(projects)) return;
  emptyEl.classList.remove("hidden");
  void showProjectPicker();
}

void boot().then(startStatusPolling).catch(showFatal);
