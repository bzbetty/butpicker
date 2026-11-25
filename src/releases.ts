import { openUrl } from "@tauri-apps/plugin-opener";
import type { Release } from "./projects";

/**
 * Release tracking in the UI: the age-coloured chip on tabs and picker rows,
 * the "not in prod" panel that covers every tracked project open or not, and
 * the per-viewer conveniences around it (snooze, nudges, the last answer for a
 * fast start). The answers themselves come from `releases_all` in Rust.
 */

export const DEFAULT_NUDGE_DAYS = 14;

const SNOOZE_KEY = "butpicker.releases.snooze";
const NUDGED_KEY = "butpicker.releases.nudged";
const LAST_KEY = "butpicker.releases.last";

const DAY_MS = 86_400_000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: these are conveniences, so carry on without.
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/* -------------------------------------------------------------- age */

/** Whole days the oldest unreleased run has been waiting. */
export function daysWaiting(release: Release): number {
  const since = release.since ? Date.parse(release.since) : NaN;
  if (Number.isNaN(since)) return 0;
  return Math.max(0, Math.floor((Date.now() - since) / DAY_MS));
}

/** Colour is age, not count: a day is normal, a fortnight is drift. */
export function ageClass(days: number): string {
  if (days < 3) return "age-fresh";
  if (days <= 14) return "age-stale";
  return "age-old";
}

export const ageText = (days: number) => (days < 1 ? "<1d" : `${days}d`);

/** "3 commits", or runs when the commits couldn't be listed. */
function waitingText(release: Release): string {
  const n = release.commits.length;
  if (n) return `${n} commit${n === 1 ? "" : "s"}`;
  const runs = release.runsBehind;
  return `${runs} run${runs === 1 ? "" : "s"}`;
}

function whenText(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/* ------------------------------------------------------------ snooze */

/** When a project's snooze ends, or null when it isn't snoozed. */
export function snoozedUntil(id: string): number | null {
  const until = readJson<Record<string, number>>(SNOOZE_KEY, {})[id];
  return until && until > Date.now() ? until : null;
}

export function setSnooze(id: string, days: number | null): void {
  const all = readJson<Record<string, number>>(SNOOZE_KEY, {});
  if (days === null) delete all[id];
  else all[id] = Date.now() + days * DAY_MS;
  writeJson(SNOOZE_KEY, all);
}

/** Behind and not snoozed: what the count and the colour are about. */
export const needsAttention = (r: Release) => r.state === "behind" && snoozedUntil(r.id) === null;

/* -------------------------------------------------- last answer, nudge */

/** The last answer, so chips show at startup before the first poll returns. */
export const lastKnown = (): Release[] => readJson<Release[]>(LAST_KEY, []);
export const remember = (releases: Release[]) => writeJson(LAST_KEY, releases);

/**
 * Projects that have waited past their nudge and haven't been nudged about
 * this stretch of waiting yet. Marks them nudged: a new stretch (a different
 * `since`, after prod catches up) can nudge again.
 */
export function takeNudges(releases: Release[], thresholdFor: (id: string) => number): Release[] {
  const nudged = readJson<Record<string, string>>(NUDGED_KEY, {});
  const due = releases.filter((r) => {
    const threshold = thresholdFor(r.id);
    return (
      threshold > 0 &&
      needsAttention(r) &&
      r.since !== null &&
      daysWaiting(r) >= threshold &&
      nudged[r.id] !== r.since
    );
  });
  for (const r of due) nudged[r.id] = r.since!;
  if (due.length) writeJson(NUDGED_KEY, nudged);
  return due;
}

/* ---------------------------------------------------------------- chip */

/**
 * The chip for a tab or a picker row: `⇡3 · 55d` coloured by age, `✓ prod`
 * when level, nothing when the project isn't tracked.
 */
export function releaseChip(release: Release | undefined, onClick: () => void): HTMLElement | null {
  if (!release) return null;
  const chip = el("span", "badge release");
  if (release.state === "behind") {
    const days = daysWaiting(release);
    const snoozed = snoozedUntil(release.id);
    chip.classList.add(snoozed ? "snoozed" : ageClass(days));
    chip.textContent = `⇡${release.commits.length || release.runsBehind} · ${ageText(days)}`;
    chip.title = [
      `${waitingText(release)} on ${release.branch} not in ${release.environment}, waiting ${ageText(days)}`,
      release.prod ? `${release.environment} has ${release.prod.number}` : "",
      snoozed ? `Snoozed until ${whenText(new Date(snoozed).toISOString())}` : "",
      "Click for everything not in prod",
    ]
      .filter(Boolean)
      .join("\n");
  } else if (release.state === "level") {
    chip.classList.add("age-clear");
    chip.textContent = "✓ prod";
    chip.title = `${release.environment} has ${release.prod?.number ?? "the newest run"}, level with ${release.branch}`;
  } else {
    chip.classList.add("unknown");
    chip.textContent = "⇡?";
    chip.title = release.error ?? "Release status unavailable";
  }
  // On a tab, the tab underneath activates on pointerdown and starts a drag with it.
  chip.addEventListener("pointerdown", (e) => e.stopPropagation());
  chip.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return chip;
}

/* --------------------------------------------------------------- panel */

export interface PanelActions {
  isOpen(id: string): boolean;
  openProject(id: string): void;
  settings(id: string): void;
  refresh(): void;
  close(): void;
  /** Redraw after a snooze changes what counts. */
  changed(): void;
}

const HOLD_WORD: Record<Release["hold"], string> = {
  "": "",
  waiting: "waiting approval",
  running: "running",
  queued: "queued",
  failed: "failed",
  canceled: "canceled",
  skipped: "prod stage skipped",
};

/**
 * The "not in prod" panel: every tracked project that's behind, longest
 * waiting first, with the commits waiting and what's holding them.
 */
export function renderPanel(
  container: HTMLElement,
  releases: Release[],
  checkedAt: number | null,
  loading: boolean,
  actions: PanelActions,
): void {
  container.replaceChildren();

  const head = el("div", "rel-head");
  head.append(el("h2", "", "Not in prod"));
  head.append(el("span", "muted", `${releases.length} tracked project${releases.length === 1 ? "" : "s"}`));
  const refresh = el("button", "icon-btn" + (loading ? " spinning" : ""), "⟳");
  refresh.title = "Check now";
  refresh.onclick = () => actions.refresh();
  const close = el("button", "icon-btn", "×");
  close.title = "Close (Esc)";
  close.onclick = () => actions.close();
  head.append(refresh, close);
  container.append(head);

  const body = el("div", "rel-body");
  container.append(body);

  if (releases.length === 0) {
    body.append(
      el(
        "div",
        "rel-empty",
        "No projects are tracked yet. Turn on “Track releases” from a project's settings or its row in the picker (Ctrl+T).",
      ),
    );
    return;
  }

  const behind = releases
    .filter((r) => r.state === "behind")
    .sort(
      (a, b) =>
        Number(snoozedUntil(a.id) !== null) - Number(snoozedUntil(b.id) !== null) ||
        daysWaiting(b) - daysWaiting(a),
    );
  for (const release of behind) body.append(renderRelease(release, actions));

  const level = releases.filter((r) => r.state === "level");
  if (level.length) {
    const line = el("div", "rel-clear");
    line.append(el("span", "ok", "✓ "), document.createTextNode(`Level with prod: ${level.map((r) => r.name).join(", ")}`));
    body.append(line);
  }

  for (const release of releases.filter((r) => r.state === "none" || r.state === "error")) {
    const line = el("div", "rel-problem");
    const name = el("button", "rel-link", release.name);
    name.title = "Settings";
    name.onclick = () => actions.settings(release.id);
    line.append(name, document.createTextNode(` — ${release.error ?? "unavailable"}`));
    body.append(line);
  }

  const foot = el("div", "rel-foot");
  foot.textContent = checkedAt
    ? `Checked ${new Date(checkedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · every 5 minutes`
    : "Not checked yet";
  container.append(foot);
}

function renderRelease(release: Release, actions: PanelActions): HTMLElement {
  const days = daysWaiting(release);
  const snoozed = snoozedUntil(release.id);
  const card = el("div", "rel" + (snoozed ? " snoozed" : ""));

  const top = el("div", "rel-top");
  const name = el("button", "rel-name", release.name);
  name.title = actions.isOpen(release.id) ? "Go to its tab" : "Open the project";
  name.onclick = () => actions.openProject(release.id);
  top.append(name);
  if (actions.isOpen(release.id)) top.append(el("span", "rel-open", "· open"));
  const badge = el(
    "span",
    `badge ${snoozed ? "snoozed" : ageClass(days)}`,
    `${waitingText(release)} · waiting ${ageText(days)}`,
  );
  if (release.since) badge.title = `Since ${whenText(release.since)}`;
  top.append(badge);
  card.append(top);

  const flow = el("div", "rel-flow");
  flow.append(el("span", "env", release.environment), document.createTextNode(" has "));
  flow.append(el("span", "mono", release.prod?.number ?? "?"));
  if (release.prod?.time) flow.append(document.createTextNode(` (${whenText(release.prod.time)})`));
  flow.append(document.createTextNode(` · ${release.branch} is at `), el("span", "mono", release.head?.number ?? "?"));
  if (release.hold) {
    const word = release.hold === "waiting" && release.canApprove ? "waiting on you" : HOLD_WORD[release.hold];
    flow.append(el("span", `stage ${release.hold}`, word));
  }
  card.append(flow);

  if (release.commits.length) {
    const list = el("ul", "rel-commits");
    for (const commit of release.commits.slice(0, 8)) {
      const item = el("li");
      item.append(el("span", "sha mono", commit.sha.slice(0, 7)), el("span", "msg", commit.message));
      item.append(el("span", "who", commit.author.split(/\s+/)[0] ?? ""));
      item.title = `${commit.sha}\n${commit.author}\n${commit.message}`;
      list.append(item);
    }
    if (release.commits.length > 8) list.append(el("li", "more", `+${release.commits.length - 8} more`));
    card.append(list);
  }
  if (release.error) card.append(el("div", "rel-warn", release.error));

  const buttons = el("div", "rel-actions");
  const button = (label: string, className: string, onClick: () => void, title = "") => {
    const b = el("button", `prs-btn ${className}`.trim(), label);
    if (title) b.title = title;
    b.onclick = onClick;
    buttons.append(b);
  };
  if (release.head) {
    if (release.hold === "waiting") {
      button(
        release.canApprove ? `Approve ${release.head.number} ↗` : `Open ${release.head.number} ↗`,
        "primary",
        () => void openUrl(release.head!.url),
        "Opens the run in Azure DevOps, where the approval is",
      );
    } else {
      button(`Open ${release.head.number} ↗`, "", () => void openUrl(release.head!.url));
    }
  }
  if (release.pipelineUrl) button("Pipeline ↗", "", () => void openUrl(release.pipelineUrl));
  button(actions.isOpen(release.id) ? "Go to tab" : "Open project", "", () => actions.openProject(release.id));
  if (snoozed) {
    button("Unsnooze", "", () => {
      setSnooze(release.id, null);
      actions.changed();
    });
  } else {
    button("Snooze 7d", "", () => {
      setSnooze(release.id, 7);
      actions.changed();
    }, "Leave it out of the count for a week");
  }
  card.append(buttons);
  return card;
}

/* ---------------------------------------------------------------- toast */

/** One nudge, bottom right, until dismissed or acted on. */
export function showNudge(host: HTMLElement, release: Release, onShow: () => void): void {
  const toast = el("div", "rel-toast");
  const text = el("div");
  text.append(el("b", "", release.name), document.createTextNode(` has had ${waitingText(release)} waiting for ${release.environment} for `));
  text.append(el("b", "", `${daysWaiting(release)} days`), document.createTextNode("."));
  const buttons = el("div", "rel-actions");
  const dismiss = () => toast.remove();
  const show = el("button", "prs-btn primary", "Show");
  show.onclick = () => {
    dismiss();
    onShow();
  };
  const snooze = el("button", "prs-btn", "Snooze 7d");
  snooze.onclick = () => {
    setSnooze(release.id, 7);
    dismiss();
  };
  const close = el("button", "prs-btn", "Dismiss");
  close.onclick = dismiss;
  buttons.append(show, snooze, close);
  toast.append(text, buttons);
  host.append(toast);
}
