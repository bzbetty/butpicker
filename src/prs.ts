import { openUrl } from "@tauri-apps/plugin-opener";
import {
  repoActivity,
  type Activity,
  type Check,
  type CheckState,
  type PipelineRun,
  type PullRequest,
  type Reviewer,
} from "./projects";

/** The pane keeps itself current while it's in view. The Rust side caches for the same minute. */
const REFRESH_MS = 60_000;

/** What the tab badge makes of the pane, once it has loaded. */
export interface PrSummary {
  /** Open PRs that are yours or waiting on your review. */
  yours: number;
  /** One of your PRs has a failing build. */
  failing: boolean;
  /** PRs waiting on your review. */
  toReview: number;
}

/** "5h" — the rows are narrow, and the tooltip has the date. */
function age(iso: string | null): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = (Date.now() - then) / 60_000;
  if (minutes < 1.5) return "now";
  if (minutes < 90) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const GLYPH: Record<CheckState, string> = {
  succeeded: "✓",
  failed: "✗",
  partial: "◐",
  running: "●",
  queued: "◌",
  expired: "↻",
  canceled: "⊘",
  skipped: "–",
  unknown: "?",
};

/** A policy that hasn't passed yet is waiting on people, not running. */
const POLICY_WORD: Partial<Record<CheckState, string>> = {
  queued: "waiting",
  expired: "expired",
};

/**
 * The checks that are builds, rolled into one pill: the worst one wins, so a
 * red build isn't hidden behind a green one.
 */
function buildRollup(checks: Check[]): { state: CheckState; label: string; title: string } | null {
  const builds = checks.filter((c) => c.kind === "build");
  if (builds.length === 0) return null;
  const order: CheckState[] = ["failed", "expired", "running", "queued", "partial", "canceled", "unknown", "succeeded", "skipped"];
  const worst = [...builds].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))[0];
  const label = builds.length === 1 ? worst.name : `${builds.filter((b) => b.state === "succeeded" || b.state === "skipped").length}/${builds.length} checks`;
  return {
    state: worst.state,
    label,
    title: builds.map((b) => `${GLYPH[b.state]} ${b.name} — ${b.state}${b.detail ? `: ${b.detail}` : ""}`).join("\n"),
  };
}

function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ._-]/gu, "").split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const VOTE_MARK: Record<Reviewer["vote"], string> = {
  approved: "✓",
  suggestions: "✓",
  waiting: "!",
  rejected: "✕",
  none: "",
};

const VOTE_WORD: Record<Reviewer["vote"], string> = {
  approved: "approved",
  suggestions: "approved with suggestions",
  waiting: "waiting for the author",
  rejected: "wants changes",
  none: "hasn't voted",
};

/** Characters that would end or expand the quoted prompt in pwsh, cmd or bash. */
const unquotable = (text: string) => text.replace(/["`$\\%!]/g, "");

/**
 * The PRs & builds pane: this repository's open pull requests, each with its
 * checks and votes, and the recent runs of each pipeline. Docked to the right
 * of the project's terminals rather than in the split tree, since it isn't a
 * terminal and wants a steady column of its own.
 */
export class PrsPanel {
  readonly element: HTMLDivElement;
  private body: HTMLDivElement;
  private sourceEl: HTMLSpanElement;
  private refreshButton: HTMLButtonElement;
  private activity: Activity | null = null;
  private applied: string[] = [];
  private ignored: string[] = [];
  private expanded = new Set<number>();
  private loading = false;
  private loadedAt = 0;
  private timer: number | undefined;

  /** Called when the summary the tab badge shows may have changed. */
  onChange?: () => void;
  /** Ask Claude, in a pane of this project, to look at a failed check. */
  onFix?: (prompt: string) => void;
  /** The × button. */
  onClose?: () => void;

  constructor(private readonly path: string) {
    this.element = el("div", "prs-panel");

    const header = el("div", "prs-header");
    const title = el("span", "prs-title", "PRs & builds");
    this.sourceEl = el("span", "prs-source");
    this.refreshButton = el("button", "pane-btn prs-refresh", "⟳");
    this.refreshButton.title = "Refresh";
    this.refreshButton.onclick = () => void this.refresh(true);
    const close = el("button", "pane-btn", "×");
    close.title = "Close (Ctrl+Shift+P)";
    close.onclick = () => this.onClose?.();
    header.append(title, this.sourceEl, this.refreshButton, close);

    this.body = el("div", "prs-body");
    this.body.append(el("div", "prs-empty", "Loading…"));
    this.element.append(header, this.body);

    this.timer = setInterval(() => {
      if (this.visible() && document.hasFocus()) void this.refresh(false);
      else this.renderAge();
    }, REFRESH_MS / 4);
  }

  private visible(): boolean {
    return this.element.isConnected && this.element.offsetParent !== null;
  }

  /** Applied GitButler branches, to tag their PRs and offer a PR for the ones without. */
  setApplied(branches: string[], ignored: string[]): void {
    const key = (list: string[]) => list.join("\n");
    if (key(branches) === key(this.applied) && key(ignored) === key(this.ignored)) return;
    this.applied = branches;
    this.ignored = ignored.map((b) => b.toLowerCase());
    if (this.activity) this.render();
  }

  /** Fetches unless the last answer is under a minute old, or `force`. */
  async refresh(force: boolean): Promise<void> {
    if (this.loading) return;
    if (!force && Date.now() - this.loadedAt < REFRESH_MS) return;
    this.loading = true;
    this.refreshButton.classList.add("spinning");
    try {
      this.activity = await repoActivity(this.path, force);
      this.loadedAt = Date.now();
    } catch (err) {
      this.activity = {
        provider: "none",
        source: "",
        remote: "",
        repoUrl: "",
        defaultBranch: "",
        prs: [],
        pipelines: [],
        error: String(err),
      };
    } finally {
      this.loading = false;
      this.refreshButton.classList.remove("spinning");
    }
    this.render();
    this.onChange?.();
  }

  summary(): PrSummary | null {
    const prs = this.activity?.prs;
    if (!prs) return null;
    const failing = (pr: PullRequest) => pr.checks.some((c) => c.kind === "build" && c.state === "failed");
    return {
      yours: prs.filter((p) => p.mine || p.reviewRequested).length,
      toReview: prs.filter((p) => p.reviewRequested).length,
      failing: prs.some((p) => p.mine && failing(p)),
    };
  }

  private renderAge(): void {
    this.refreshButton.textContent = this.loadedAt ? `⟳ ${age(new Date(this.loadedAt).toISOString())}` : "⟳";
  }

  private render(): void {
    const activity = this.activity;
    if (!activity) return;
    this.renderAge();
    this.sourceEl.textContent = activity.source ? `· ${activity.source}` : "";
    this.body.replaceChildren();

    if (activity.error) {
      const box = el("div", "prs-empty");
      box.append(el("div", "prs-error", activity.error));
      if (activity.remote) box.append(el("div", "prs-remote", activity.remote));
      this.body.append(box);
      return;
    }

    this.renderPrs(activity);
    this.renderPipelines(activity);

    const foot = el("div", "prs-foot");
    foot.textContent = `${activity.remote} · ${activity.provider === "azure" ? "az" : "gh"} login`;
    this.body.append(foot);
  }

  private prefix(): string {
    return this.activity?.provider === "azure" ? "!" : "#";
  }

  /** A link to open a PR from `branch`, in whichever form the provider takes. */
  private newPrUrl(branch: string): string {
    const a = this.activity!;
    const target = a.defaultBranch || "main";
    if (a.provider === "azure") {
      return `${a.repoUrl}/pullrequestcreate?sourceRef=${encodeURIComponent(branch)}&targetRef=${encodeURIComponent(target)}`;
    }
    return `${a.repoUrl}/compare/${encodeURIComponent(target)}...${encodeURIComponent(branch)}?expand=1`;
  }

  private renderPrs(activity: Activity): void {
    const head = el("div", "prs-section", "Pull requests");
    const withPr = new Set(activity.prs.map((p) => p.sourceBranch));
    const missing = this.applied.filter(
      (b) => !withPr.has(b) && b !== activity.defaultBranch && !this.ignored.includes(b.toLowerCase()),
    );
    if (missing.length) {
      const link = el("button", "prs-link", `+ New PR from ${missing[0]}`);
      link.title = missing.length > 1 ? `Also without a PR: ${missing.slice(1).join(", ")}` : "Opens the create page";
      link.onclick = () => void openUrl(this.newPrUrl(missing[0]));
      head.append(link);
    }
    this.body.append(head);

    if (activity.prs.length === 0) {
      this.body.append(el("div", "prs-none", "No open pull requests."));
      return;
    }

    // Waiting on you, then yours, then everyone else's; newest first within each.
    const rank = (p: PullRequest) => (p.reviewRequested ? 0 : p.mine ? 1 : 2);
    const sorted = [...activity.prs].sort(
      (a, b) => rank(a) - rank(b) || Date.parse(b.created) - Date.parse(a.created),
    );
    for (const pr of sorted) this.body.append(...this.renderPr(pr));
  }

  private renderPr(pr: PullRequest): HTMLElement[] {
    const row = el("div", "prs-row");
    const open = this.expanded.has(pr.number);
    row.classList.toggle("open", open);
    if (pr.reviewRequested) row.classList.add("to-review");
    row.onclick = () => {
      if (open) this.expanded.delete(pr.number);
      else this.expanded.add(pr.number);
      this.render();
    };

    const title = el("div", "prs-pr-title");
    // The text truncates; the tags after it don't, so a long title can't hide them.
    const text = el("span", "prs-pr-text");
    text.append(el("span", "prs-id", `${this.prefix()}${pr.number} `), document.createTextNode(pr.title));
    title.append(text);
    if (this.applied.includes(pr.sourceBranch)) {
      const tag = el("span", "prs-tag applied", "⎇ applied");
      tag.title = "This branch is applied in your GitButler workspace";
      title.append(tag);
    }
    if (pr.draft) title.append(el("span", "prs-tag", "draft"));
    title.title = pr.title;

    const meta = el("div", "prs-meta");
    const who = pr.mine ? "you" : pr.author;
    meta.append(document.createTextNode(`${who} · `));
    if (pr.reviewRequested) meta.append(el("span", "prs-ask", "your review"), document.createTextNode(" · "));
    meta.append(el("span", "prs-branch", `${pr.sourceBranch} → ${pr.targetBranch}`));
    meta.append(document.createTextNode(` · ${age(pr.created)}`));
    if (pr.conflicts) meta.append(document.createTextNode(" · "), el("span", "prs-warn", "⚠ conflicts"));

    const right = el("div", "prs-right");
    if (pr.ready && pr.mine) {
      const ready = el("span", "prs-ready", "Ready");
      ready.title = "Every blocking policy passes";
      right.append(ready);
    }
    const rollup = buildRollup(pr.checks);
    if (rollup) {
      const pill = el("span", `prs-pill ${rollup.state}`, `${GLYPH[rollup.state]} ${rollup.label}`);
      pill.title = rollup.title;
      right.append(pill);
    }
    if (pr.reviewers.length) right.append(this.renderVotes(pr.reviewers));

    row.append(title, right, meta);
    return open ? [row, this.renderDetail(pr)] : [row];
  }

  private renderVotes(reviewers: Reviewer[]): HTMLElement {
    const votes = el("span", "prs-votes");
    // Decisions first, so the faces that matter aren't the ones cut off.
    const sorted = [...reviewers].sort((a, b) => Number(a.vote === "none") - Number(b.vote === "none"));
    for (const r of sorted.slice(0, 4)) {
      const av = el("span", `prs-av${r.me ? " me" : ""}`, initials(r.name));
      av.title = `${r.name}${r.required ? " (required)" : ""} — ${VOTE_WORD[r.vote]}`;
      if (VOTE_MARK[r.vote]) av.append(el("i", `vote-${r.vote}`, VOTE_MARK[r.vote]));
      votes.append(av);
    }
    if (sorted.length > 4) votes.append(el("span", "prs-more", `+${sorted.length - 4}`));
    return votes;
  }

  private renderDetail(pr: PullRequest): HTMLElement {
    const detail = el("div", "prs-detail");
    const checks = [...pr.checks].sort((a, b) => Number(a.kind !== "build") - Number(b.kind !== "build"));
    for (const check of checks) {
      const line = el("div", `prs-check ${check.state}`);
      line.append(el("span", "prs-check-glyph", GLYPH[check.state]));
      const name = el("span", "prs-check-name", check.name);
      const word = check.kind === "policy" ? (POLICY_WORD[check.state] ?? check.state) : check.state;
      const sub = [word, check.detail, check.blocking ? "" : "optional"].filter(Boolean).join(" · ");
      name.append(el("span", "prs-check-sub", ` ${sub}`));
      line.append(name);
      if (check.url) {
        const log = el("button", "prs-btn", "Log");
        log.onclick = (e) => {
          e.stopPropagation();
          void openUrl(check.url);
        };
        line.append(log);
      }
      detail.append(line);
    }
    if (pr.reviewers.length) {
      const line = el("div", "prs-check");
      line.append(el("span", "prs-check-glyph", "☺"));
      line.append(
        el(
          "span",
          "prs-check-name",
          pr.reviewers
            .map((r) =>
              r.me
                ? `you ${r.vote === "none" ? "haven't voted" : VOTE_WORD[r.vote].replace(/^wants/, "want")}`
                : `${r.name} ${VOTE_WORD[r.vote]}`,
            )
            .join(" · "),
        ),
      );
      detail.append(line);
    }

    const actions = el("div", "prs-actions");
    const browser = el("button", "prs-btn primary", "Open in browser");
    browser.onclick = (e) => {
      e.stopPropagation();
      void openUrl(pr.url);
    };
    actions.append(browser);
    const failed = pr.checks.find((c) => c.kind === "build" && c.state === "failed");
    if (failed && this.onFix) {
      const fix = el("button", "prs-btn claude", "✦ Fix with Claude");
      fix.title = "Opens claude in this repository with the failure to look at";
      fix.onclick = (e) => {
        e.stopPropagation();
        const prompt = [
          `The ${failed.name} check failed on pull request ${this.prefix()}${pr.number} (${pr.title}),`,
          `branch ${pr.sourceBranch} into ${pr.targetBranch}.`,
          failed.url ? `The build is ${failed.url}.` : "",
          failed.detail ? `It reported: ${failed.detail}.` : "",
          "Read the build log, find the cause and fix it on that branch.",
        ]
          .filter(Boolean)
          .join(" ");
        this.onFix?.(unquotable(prompt));
      };
      actions.append(fix);
    }
    detail.append(actions);
    detail.onclick = (e) => e.stopPropagation();
    return detail;
  }

  private renderPipelines(activity: Activity): void {
    if (activity.pipelines.length === 0) return;
    this.body.append(el("div", "prs-section", activity.provider === "azure" ? "Pipelines" : "Workflows"));
    for (const pipeline of activity.pipelines) {
      const row = el("div", "prs-pipe");
      const name = el("button", "prs-pipe-name", pipeline.name);
      name.title = "Open the pipeline";
      name.onclick = () => void openUrl(pipeline.url);

      const strip = el("span", "prs-runs");
      // Oldest on the left, so the newest sits by the summary.
      for (const run of [...pipeline.runs].reverse()) strip.append(this.renderRun(run));

      const latest = pipeline.runs[0];
      const info = el("span", `prs-pipe-info ${latest?.state ?? ""}`);
      if (latest) info.textContent = [latest.state, latest.branch, age(latest.time)].filter(Boolean).join(" · ");
      row.append(name, strip, info);
      this.body.append(row);
    }
  }

  private renderRun(run: PipelineRun): HTMLElement {
    const square = el("button", `prs-run ${run.state}`);
    square.title = [run.number, run.state, run.branch, age(run.time)].filter(Boolean).join(" · ");
    square.onclick = () => void openUrl(run.url);
    return square;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.element.remove();
  }
}
