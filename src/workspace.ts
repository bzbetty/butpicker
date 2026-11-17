import { openUrl } from "@tauri-apps/plugin-opener";
import { TerminalPane, type PaneSpec } from "./pty";
import { PrsPanel } from "./prs";
import {
  listWorktrees,
  worktreeLabel,
  worktreeName,
  type Project,
  type RunningAppHost,
  type Worktree,
} from "./projects";
import { getSettings, shellCommandArgs, shellThenCommandArgs, type Profile } from "./settings";

export type Axis = "x" | "y";

/** Where a new terminal goes: a tab beside the pane, or a split right or down of it. */
export type Placement = "tab" | Axis;

/**
 * Makes a gutter drag-resize its two neighbours by trading flex-grow between
 * them. Every pane uses `flex-basis: 0`, so grow alone decides the split.
 */
function installGutter(gutter: HTMLElement, prev: HTMLElement, next: HTMLElement, axis: Axis) {
  const MIN = 90;
  gutter.addEventListener("pointerdown", (down: PointerEvent) => {
    down.preventDefault();
    const horizontal = axis === "x";
    const prevSize = horizontal ? prev.offsetWidth : prev.offsetHeight;
    const nextSize = horizontal ? next.offsetWidth : next.offsetHeight;
    const total = prevSize + nextSize;
    if (total < MIN * 2) return;
    const totalGrow = grow(prev) + grow(next);
    const origin = horizontal ? down.clientX : down.clientY;
    document.body.classList.add(horizontal ? "resizing-x" : "resizing-y");

    const onMove = (move: PointerEvent) => {
      const delta = (horizontal ? move.clientX : move.clientY) - origin;
      const size = Math.max(MIN, Math.min(total - MIN, prevSize + delta));
      setGrow(prev, (totalGrow * size) / total);
      setGrow(next, (totalGrow * (total - size)) / total);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing-x", "resizing-y");
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}

function grow(el: HTMLElement): number {
  return parseFloat(el.style.flexGrow) || 1;
}

function setGrow(el: HTMLElement, value: number): void {
  el.style.flexGrow = String(value);
}

/**
 * Fraction of the width the TUI starts with. The TUI is the thing you read —
 * branches, commits and diffs all want the room — while the shell beside it is
 * mostly for one-line commands. The gutter still drags either way.
 */
const TUI_SHARE = 0.75;

type LayoutNode = Split | TabGroup;

/** What the run pane runs, and whether it starts on its own. */
export interface RunSpec {
  command: string;
  /** Start when the tab is first looked at, rather than on the ▶ button. */
  auto: boolean;
}

/**
 * A row (`x`) or column (`y`) of panes and nested splits, with a gutter
 * between each pair. Each child's share lives in its own `flex-grow`.
 */
class Split {
  axis: Axis;
  children: LayoutNode[] = [];
  parent: Split | null = null;
  readonly element: HTMLDivElement;

  constructor(axis: Axis, element = document.createElement("div")) {
    this.axis = axis;
    this.element = element;
  }

  render(): void {
    this.element.classList.toggle("hsplit", this.axis === "x");
    this.element.classList.toggle("vsplit", this.axis === "y");
    this.element.replaceChildren();
    // Flex leaves space empty when the grows sum to less than 1, so rescale
    // them to average 1 whatever edits got us here.
    const total = this.children.reduce((sum, c) => sum + grow(c.element), 0);
    this.children.forEach((c) => setGrow(c.element, (grow(c.element) * this.children.length) / total));
    this.children.forEach((child, i) => {
      if (i > 0) {
        const gutter = document.createElement("div");
        gutter.className = `gutter gutter-${this.axis}`;
        installGutter(gutter, this.children[i - 1].element, child.element, this.axis);
        this.element.appendChild(gutter);
      }
      this.element.appendChild(child.element);
    });
  }
}

/**
 * A leaf of the layout: one or more panes as tabs, one shown at a time. The
 * header is the tab strip, then the shown pane's own buttons, then ＋ for a
 * new terminal here.
 */
class TabGroup {
  panes: TerminalPane[] = [];
  selected: TerminalPane | null = null;
  parent!: Split;
  readonly element: HTMLDivElement;
  private tabs: HTMLDivElement;
  private actions: HTMLDivElement;
  private body: HTMLDivElement;

  constructor(onAdd: (group: TabGroup, anchor: HTMLElement) => void) {
    this.element = document.createElement("div");
    this.element.className = "pane-group";

    const header = document.createElement("div");
    header.className = "pane-header";
    this.tabs = document.createElement("div");
    this.tabs.className = "pane-tabs";
    // A wheel over a crowded strip scrolls it sideways, as there's no other way along.
    this.tabs.addEventListener("wheel", (e) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      this.tabs.scrollLeft += e.deltaY;
    });
    this.actions = document.createElement("div");
    this.actions.className = "pane-group-actions";
    const add = document.createElement("button");
    add.className = "pane-btn pane-add";
    add.title = "New terminal: tab, right or down";
    add.textContent = "+";
    add.onclick = () => onAdd(this, add);
    header.append(this.tabs, this.actions, add);

    this.body = document.createElement("div");
    this.body.className = "pane-group-body";
    this.element.append(header, this.body);
  }

  insert(pane: TerminalPane, after?: TerminalPane): void {
    const index = after ? this.panes.indexOf(after) + 1 : this.panes.length;
    this.panes.splice(index, 0, pane);
    this.tabs.insertBefore(pane.tab, this.tabs.children[index] ?? null);
    this.actions.appendChild(pane.actions);
    this.body.appendChild(pane.element);
    this.element.classList.toggle("single", this.panes.length === 1);
    this.select(pane);
  }

  /** Takes `pane` out, selecting its neighbour if it was showing. Returns that neighbour. */
  remove(pane: TerminalPane): TerminalPane | null {
    const index = this.panes.indexOf(pane);
    this.panes.splice(index, 1);
    this.element.classList.toggle("single", this.panes.length === 1);
    if (this.selected === pane) {
      this.selected = null;
      const next = this.panes[Math.min(index, this.panes.length - 1)];
      if (next) this.select(next);
    }
    return this.selected;
  }

  select(pane: TerminalPane): void {
    if (this.selected === pane) return;
    this.selected = pane;
    this.panes.forEach((p) => {
      const shown = p === pane;
      p.element.classList.toggle("hidden", !shown);
      p.actions.classList.toggle("hidden", !shown);
      p.tab.classList.toggle("selected", shown);
    });
    pane.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    // A pane that was hidden measured as nothing; now it has a size to fit.
    requestAnimationFrame(() => pane.fit());
  }

  setActive(active: boolean): void {
    this.element.classList.toggle("active", active);
  }
}

/**
 * The ＋ menu: a row per profile and a column per place, so any new terminal
 * is one click.
 */
function showAddMenu(anchor: HTMLElement, profiles: Profile[], pick: (profile: Profile, where: Placement) => void) {
  document.querySelector(".add-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "add-menu";
  const places: [Placement, string, string][] = [
    ["tab", "▭", "New tab"],
    ["x", "◫", "Split right"],
    ["y", "⊟", "Split down"],
  ];
  const head = document.createElement("div");
  head.className = "add-menu-row add-menu-head";
  head.append(document.createElement("span"));
  for (const [, , name] of places) {
    const label = document.createElement("span");
    label.textContent = name.replace(/^(New|Split) /, "");
    head.append(label);
  }
  menu.append(head);
  const keys: Record<Placement, string> = { tab: "T", x: "D", y: "E" };
  profiles.forEach((profile, i) => {
    const row = document.createElement("div");
    row.className = "add-menu-row";
    const name = document.createElement("span");
    name.className = "add-menu-name";
    name.textContent = profile.name;
    row.append(name);
    for (const [where, glyph, title] of places) {
      const button = document.createElement("button");
      button.className = "pane-btn";
      button.textContent = glyph;
      const key = i === 0 ? ` (Ctrl+Shift+${keys[where]})` : i === 1 ? ` (Ctrl+Alt+Shift+${keys[where]})` : "";
      button.title = `${title}: ${profile.name}${key}`;
      button.onclick = () => {
        close();
        pick(profile, where);
      };
      row.append(button);
    }
    menu.append(row);
  });
  const close = popMenu(anchor, menu);
}

/**
 * Shows `menu` under `anchor`, right-aligned to it, until a click lands
 * elsewhere or a key is pressed. Returns what closes it.
 */
function popMenu(anchor: HTMLElement, menu: HTMLElement): () => void {
  document.body.append(menu);

  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;

  const onDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  // Any key closes it: a shortcut may have changed the layout under it.
  const onKey = () => close();
  function close() {
    menu.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  }
  // After this click has finished, or it would close the menu it opened.
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  return close;
}

type WorktreeAction = "run" | "dashboard" | "stop";

/** A row of the worktree menu: a worktree, and what's running there if anything. */
interface WorktreeRow {
  tree: Worktree;
  host: RunningAppHost | null;
  /** A pane of ours is already running or following it. */
  open: boolean;
}

/**
 * The ⑂ menu on the TUI: a row per linked worktree, wherever the tool that
 * made it put it, with a run (or a way to the pane already there), its
 * dashboard, and a stop.
 */
function showWorktreeMenu(
  anchor: HTMLElement,
  rows: WorktreeRow[],
  runnable: boolean,
  act: (row: WorktreeRow, action: WorktreeAction) => void,
) {
  document.querySelector(".add-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "add-menu";
  const head = document.createElement("div");
  head.className = "worktree-menu-head";
  head.textContent = rows.length ? "Worktrees" : "No other worktrees";
  menu.append(head);
  for (const row of rows) {
    const { tree, host, open } = row;
    const line = document.createElement("div");
    line.className = "add-menu-row";
    const name = document.createElement("span");
    name.className = "add-menu-name";
    if (host) name.classList.add("running");
    name.textContent = (host ? "◆ " : "") + worktreeLabel(tree.path, tree.branch);
    name.title = host ? `${tree.path}\n${host.appHostPath}` : tree.path;
    line.append(name);
    const actions: [WorktreeAction, string, string, boolean][] = [
      [
        "run",
        "▶",
        open ? "Go to its pane" : host ? "Already running — follow it" : "Run it here",
        open || !!host || runnable,
      ],
      ["dashboard", "◉", "Open the Aspire dashboard", !!host?.dashboardUrl],
      ["stop", "■", "Stop the app (aspire stop)", !!host],
    ];
    for (const [action, glyph, title, enabled] of actions) {
      const button = document.createElement("button");
      button.className = "pane-btn";
      if (action === "run") button.classList.add("pane-run");
      button.textContent = glyph;
      button.title = title;
      button.disabled = !enabled;
      button.onclick = () => {
        close();
        act(row, action);
      };
      line.append(button);
    }
    menu.append(line);
  }
  const close = popMenu(anchor, menu);
}

/** An `aspire run` that would fight another copy of the same AppHost for its ports. */
const isAspireRun = (command: string) => /^\s*aspire\s+run\b/.test(command);

/**
 * `aspire run --isolated` takes random ports and its own copy of the user
 * secrets, which is what lets one AppHost run from two worktrees at once.
 */
function isolated(command: string): string {
  if (!isAspireRun(command) || /\s--isolated\b/.test(command)) return command;
  return command.replace(/^(\s*aspire\s+run)\b/, "$1 --isolated");
}

/**
 * One project: the `but tui` on the left and shells beside it, all rooted at
 * the project directory. Any pane splits right or down, so the layout is a
 * tree of rows and columns rather than a fixed pair.
 */
export class ProjectView {
  readonly project: Project;
  readonly element: HTMLDivElement;

  private root: Split;
  private groups = new Map<TerminalPane, TabGroup>();
  private butPane: TerminalPane;
  private activePane: TerminalPane;
  private run: RunSpec | null = null;
  private runPane: TerminalPane | null = null;
  private runButton: HTMLButtonElement;
  /** The run pane's dashboard button, shown once there's a URL for it. */
  private dashboardButton: HTMLButtonElement | null = null;
  /** This project's AppHost, if `aspire ps` last saw one running. */
  private aspire: RunningAppHost | null = null;
  /** The project's other worktrees, as git last listed them. */
  private worktrees: Worktree[] = [];
  /** AppHosts running in those worktrees: an agent's, usually. */
  private worktreeHosts: RunningAppHost[] = [];
  private worktreeButton: HTMLButtonElement;
  /**
   * A pane per worktree that has one, running its app or following it, by
   * the worktree's path, so ▶ twice goes to the pane there is.
   */
  private worktreePanes = new Map<string, { pane: TerminalPane; dashboard: HTMLButtonElement }>();
  /** An auto run starts once per tab, not every time the tab comes back. */
  private autoRan = false;
  /**
   * What an attached pane follows: resource states, a line per change, or
   * every resource's console output, which on a chatty app is a firehose.
   */
  private attachView: "describe" | "logs" = "describe";
  /** Set while deciding between running and attaching, so a double click opens one pane. */
  private opening = false;
  /** The PRs & builds pane, docked right of the terminals. */
  readonly prs: PrsPanel;
  private prsGutter: HTMLDivElement;
  private prsButton: HTMLButtonElement;

  /** Brings `aspire` up to date before the run pane decides what to start. */
  beforeRun?: () => Promise<void>;
  onStopAspire?: (appHostPath: string) => Promise<void>;

  constructor(project: Project) {
    this.project = project;
    const settings = getSettings();

    this.element = document.createElement("div");
    this.element.className = "project";
    // The terminals' split tree gets a box of its own, so the PRs pane can dock
    // beside it without being a leaf of the tree.
    const layout = document.createElement("div");
    layout.className = "project-layout";
    this.root = new Split("x", layout);
    this.prs = new PrsPanel(project.path);
    this.prs.onClose = () => this.togglePrs(false);
    this.prs.onFix = (prompt) => this.openClaude(prompt);
    this.prsGutter = document.createElement("div");
    this.prsGutter.className = "gutter gutter-x";
    this.installPrsGutter();
    this.prs.element.classList.add("hidden");
    this.prsGutter.classList.add("hidden");
    this.element.append(layout, this.prsGutter, this.prs.element);

    this.butPane = this.makePane({
      cwd: project.path,
      program: settings.butCommand,
      args: settings.butArgs,
      env: settings.butEnv,
      label: `but tui — ${project.name}`,
      pinned: true,
    });
    this.runButton = this.butPane.addAction("▶", "", () => void this.openRun());
    this.runButton.classList.add("pane-run", "hidden");
    this.worktreeButton = this.butPane.addAction("worktrees", "", () => void this.showWorktrees());
    this.worktreeButton.classList.add("pane-worktrees", "hidden");
    this.prsButton = this.butPane.addAction("PRs", "PRs & builds (Ctrl+Shift+P)", () => this.togglePrs());
    this.prsButton.classList.add("pane-prs");
    const group = this.makeGroup();
    group.parent = this.root;
    group.insert(this.butPane);
    this.groups.set(this.butPane, group);
    this.root.children.push(group);

    this.activePane = this.butPane;
    this.open(this.butPane, "x", { autostart: false, share: 1 - TUI_SHARE });
    this.setActivePane(this.butPane);
  }

  private makePane(spec: PaneSpec): TerminalPane {
    const pane = new TerminalPane(spec);
    pane.onFocus = (p) => this.setActivePane(p);
    pane.onClose = (p) => this.closeShell(p);
    return pane;
  }

  private makeGroup(): TabGroup {
    return new TabGroup((group, anchor) => {
      showAddMenu(anchor, getSettings().profiles, (profile, where) => {
        // The group may have closed while the menu was open.
        const target = group.selected;
        if (target && this.groups.has(target)) this.open(target, where, { spec: this.profileSpec(profile) });
      });
    });
  }

  /** A terminal in the project directory: the shell, or the shell running the profile's command first. */
  private profileSpec(profile: Profile): PaneSpec {
    const settings = getSettings();
    return {
      cwd: this.project.path,
      program: settings.shell,
      args: profile.command
        ? shellThenCommandArgs(settings.shell, settings.shellArgs, profile.command)
        : settings.shellArgs,
      label: profile.name,
    };
  }

  /** Shows or hides the PRs & builds pane; with no argument, flips it. */
  togglePrs(show = this.prs.element.classList.contains("hidden")): void {
    this.prs.element.classList.toggle("hidden", !show);
    this.prsGutter.classList.toggle("hidden", !show);
    this.prsButton.classList.toggle("on", show);
    if (show) void this.prs.refresh(false);
    this.fitAll();
  }

  get prsOpen(): boolean {
    return !this.prs.element.classList.contains("hidden");
  }

  /** Drags the PRs pane's width; the terminals take whatever's left. */
  private installPrsGutter(): void {
    const MIN = 280;
    this.prsGutter.addEventListener("pointerdown", (down: PointerEvent) => {
      down.preventDefault();
      const start = this.prs.element.offsetWidth;
      const max = this.element.offsetWidth - 300;
      document.body.classList.add("resizing-x");
      const onMove = (move: PointerEvent) => {
        const width = Math.max(MIN, Math.min(max, start - (move.clientX - down.clientX)));
        this.prs.element.style.width = `${width}px`;
        this.fitAll();
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.classList.remove("resizing-x");
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }

  /**
   * A `claude` terminal started with `prompt`, as a tab beside the last shell
   * so the TUI keeps its column. Uses the `claude` profile's command if there
   * is one, so a customised launch line still applies.
   */
  openClaude(prompt: string): TerminalPane {
    const command = getSettings().profiles.find((p) => p.name === "claude")?.command ?? "claude";
    const spec = this.profileSpec({ name: "claude", command: `${command} "${prompt}"` });
    const shells = this.shells();
    return shells.length
      ? this.open(shells[shells.length - 1], "tab", { spec })
      : this.open(this.butPane, "x", { spec, share: 1 - TUI_SHARE });
  }

  /** Starts every pty. Called once the view is attached and has real dimensions. */
  async start(): Promise<void> {
    await this.butPane.start();
    await Promise.all(this.shells().filter((s) => s !== this.runPane).map((s) => s.start()));
  }

  /**
   * What the ▶ button runs, or null for no button. A run pane already open
   * keeps running what it was started with until it's restarted from here.
   */
  configureRun(run: RunSpec | null): void {
    this.run = run;
    this.runButton.classList.toggle("hidden", !run);
    this.updateRunControls();
  }

  /**
   * What `aspire ps` makes of this project: whatever's running from its own
   * checkout, and from each of its worktrees.
   */
  setAspire(running: RunningAppHost[]): void {
    this.aspire = running.find((h) => !h.worktree) ?? null;
    this.worktreeHosts = running.filter((h) => h.worktree);
    this.updateRunControls();
  }

  /** Asks git again which worktrees the project has. */
  async refreshWorktrees(): Promise<void> {
    this.worktrees = await listWorktrees(this.project.path).catch(() => this.worktrees);
    this.updateRunControls();
  }

  /** Every worktree worth a row: git's list, plus any with an app running that git didn't list. */
  private worktreeRows(): WorktreeRow[] {
    const trees = [...this.worktrees];
    for (const host of this.worktreeHosts) {
      if (host.worktree && !trees.some((t) => t.path === host.worktree)) {
        trees.push({ path: host.worktree, branch: host.branch });
      }
    }
    return trees.map((tree) => ({
      tree,
      host: this.hostIn(tree.path),
      open: this.worktreePanes.has(tree.path),
    }));
  }

  private hostIn(worktree: string): RunningAppHost | null {
    return this.worktreeHosts.find((h) => h.worktree === worktree) ?? null;
  }

  private async showWorktrees(): Promise<void> {
    await this.refreshWorktrees();
    showWorktreeMenu(this.worktreeButton, this.worktreeRows(), !!this.run, (row, action) => {
      if (action === "run") void this.openWorktree(row.tree);
      else if (action === "dashboard") {
        if (row.host?.dashboardUrl) void openUrl(row.host.dashboardUrl);
      } else if (row.host) void this.onStopAspire?.(row.host.appHostPath);
    });
  }

  /**
   * Whether anything else of this project's is running, or about to be: an
   * `aspire run` alongside it needs `--isolated` to keep off its ports.
   * Counts our own run panes too, since a run that's still building isn't in
   * `aspire ps` yet.
   */
  private othersRunning(worktree: string | null): boolean {
    const hosts = [this.aspire, ...this.worktreeHosts].filter((h) => h && h.worktree !== worktree);
    const panes = [...this.worktreePanes.keys()].filter((path) => path !== worktree);
    return hosts.length > 0 || panes.length > 0 || (worktree !== null && this.runPane !== null);
  }

  /**
   * Opens a pane for a worktree, like the run pane does for the project's own
   * checkout: following its app if something else already started it, such
   * as an agent's `aspire start`, and otherwise running the project's command
   * there. With a pane already open, this just goes to it.
   */
  async openWorktree(tree: Worktree, { attach }: { attach?: boolean } = {}): Promise<void> {
    const existing = this.worktreePanes.get(tree.path);
    if (existing) {
      this.setActivePane(existing.pane);
      existing.pane.focus();
      return;
    }
    if (attach === undefined) {
      await this.beforeRun?.();
      if (this.worktreePanes.has(tree.path)) return;
    }
    const target = attach === false ? null : this.hostIn(tree.path);
    if (!target && !this.run) return;

    const name = worktreeLabel(tree.path, tree.branch);
    const settings = getSettings();
    const command = target
      ? `aspire describe --apphost "${target.appHostPath}" --follow`
      : this.othersRunning(tree.path)
        ? isolated(this.run!.command)
        : this.run!.command;
    const spec: PaneSpec = {
      cwd: tree.path,
      program: settings.shell,
      args: shellCommandArgs(settings.shell, command),
      label: target ? `aspire (attached) · ${name}` : `${command} · ${name}`,
      interruptToStop: !target,
    };
    const shell = this.shells()[0];
    const pane = shell
      ? this.open(shell, "y", { spec })
      : this.open(this.butPane, "x", { spec, share: 1 - TUI_SHARE });

    if (target) {
      pane.addAction("■", "Stop the app (aspire stop)", () => {
        const host = this.hostIn(tree.path);
        if (host) void this.onStopAspire?.(host.appHostPath);
      });
      pane.exitAction = {
        label: "Run here",
        run: () => {
          this.closeShell(pane);
          void this.openWorktree(tree, { attach: false });
        },
      };
    }
    const dashboard = pane.addAction("◉", "Open the Aspire dashboard", () => {
      const url = this.hostIn(tree.path)?.dashboardUrl;
      if (url) void openUrl(url);
    });
    this.worktreePanes.set(tree.path, { pane, dashboard });
    this.updateRunControls();
  }

  private updateRunControls(): void {
    this.dashboardButton?.classList.toggle("hidden", !this.aspire?.dashboardUrl);
    for (const [path, { dashboard }] of this.worktreePanes) {
      dashboard.classList.toggle("hidden", !this.hostIn(path)?.dashboardUrl);
    }
    const running = this.worktreeHosts.length;
    // Only a project with a run, or with something already running, has a use for the menu.
    this.worktreeButton.classList.toggle(
      "hidden",
      this.worktrees.length + running === 0 || (!this.run && running === 0),
    );
    this.worktreeButton.classList.toggle("running", running > 0);
    // Words rather than a glyph: there's no fork symbol that reads at this size.
    const count = this.worktreeRows().length;
    this.worktreeButton.textContent =
      (running ? "◆ " : "") + `${count} worktree${count === 1 ? "" : "s"}`;
    const names = this.worktreeHosts.map(worktreeName);
    this.worktreeButton.title = running
      ? `Aspire running in ${names.join(", ")} — worktrees`
      : `Run in a worktree (${this.worktrees.length})`;
    if (!this.run) return;
    this.runButton.title = this.runPane
      ? `Go to ${this.runPane.spec.label} (Ctrl+F5)`
      : this.aspire
        ? "Already running — attach to it (Ctrl+F5)"
        : `Run ${this.run.command} (Ctrl+F5)`;
  }

  /** The tab has come into view, other than during session restore. */
  activated(): void {
    if (!this.run?.auto || this.autoRan) return;
    this.autoRan = true;
    if (!this.runPane) void this.openRun({ focus: false });
  }

  /**
   * Opens the run pane: under the first shell if there is one, so the TUI
   * keeps its column, otherwise beside the TUI. With the pane already open,
   * this just goes to it.
   *
   * If the AppHost is already running — an agent's `aspire start`, say — a
   * second copy would only fight it for ports, so the pane follows the
   * running one instead. `attach` forces the choice either way.
   */
  async openRun({ focus = true, attach }: { focus?: boolean; attach?: boolean } = {}): Promise<void> {
    if (!this.run || this.opening) return;
    if (this.runPane) {
      this.setActivePane(this.runPane);
      this.runPane.focus();
      return;
    }
    if (attach === undefined) {
      this.opening = true;
      try {
        await this.beforeRun?.();
      } finally {
        this.opening = false;
      }
      if (!this.run || this.runPane) return;
      attach = this.aspire !== null;
    }
    const target = attach ? this.aspire : null;

    const settings = getSettings();
    const apphost = `--apphost "${target?.appHostPath}"`;
    const logs = this.attachView === "logs";
    const command = !target
      ? this.othersRunning(null)
        ? isolated(this.run.command)
        : this.run.command
      : logs
        ? `aspire logs ${apphost} --follow --tail 200`
        : `aspire describe ${apphost} --follow`;
    const spec: PaneSpec = {
      cwd: this.project.path,
      program: settings.shell,
      args: shellCommandArgs(settings.shell, command),
      label: !target ? this.run.command : logs ? "aspire logs (attached)" : "aspire (attached)",
      // Ctrl+C on the logs only stops watching, but on a run it's how the app
      // gets to shut down cleanly.
      interruptToStop: !target,
    };
    const shell = this.shells()[0];
    const pane = shell
      ? this.open(shell, "y", { spec, focus })
      : this.open(this.butPane, "x", { spec, focus, share: 1 - TUI_SHARE });
    this.runPane = pane;

    if (target) {
      pane.addAction("■", "Stop the app (aspire stop)", () => {
        void this.onStopAspire?.(target.appHostPath);
      });
      pane.addAction(
        logs ? "☷" : "≡",
        logs ? "Show resource states instead" : "Show every resource's logs instead",
        () => this.reattach(logs ? "describe" : "logs"),
      );
      // The stream ends when the app does, and then there's nothing to attach to.
      pane.exitAction = { label: "Run here", run: () => this.runHere() };
    }
    this.dashboardButton = pane.addAction("◉", "Open the Aspire dashboard", () => {
      if (this.aspire?.dashboardUrl) void openUrl(this.aspire.dashboardUrl);
    });
    this.updateRunControls();
  }

  /** Swaps what an attached pane follows. */
  private reattach(view: "describe" | "logs"): void {
    // With nothing running any more, reopening would start a run instead.
    if (!this.aspire) return;
    this.attachView = view;
    if (this.runPane) this.closeShell(this.runPane);
    void this.openRun({ attach: true });
  }

  /** Swaps an attached pane, whose app has stopped, for one that runs it. */
  private runHere(): void {
    if (this.runPane) this.closeShell(this.runPane);
    this.aspire = null;
    void this.openRun({ attach: false });
  }

  /**
   * Opens a pane as a tab beside `target`, or split off its group taking
   * `share` of the room the group had: a shell unless `spec` says otherwise.
   * Splitting along the axis the group already sits in adds a sibling; across
   * it, the group becomes a nested split of its own.
   */
  open(
    target: TerminalPane,
    where: Placement,
    {
      autostart = true,
      focus = true,
      share = 0.5,
      spec,
    }: { autostart?: boolean; focus?: boolean; share?: number; spec?: PaneSpec } = {},
  ): TerminalPane {
    const pane = this.makePane(spec ?? this.profileSpec(getSettings().profiles[0]));
    const group = this.groups.get(target)!;

    if (where === "tab") {
      const showing = group.selected;
      group.insert(pane, target);
      this.groups.set(pane, group);
      // Opened in the background, the tab shouldn't take over the view.
      if (!focus && showing) group.select(showing);
    } else {
      const fresh = this.makeGroup();
      fresh.insert(pane);
      this.groups.set(pane, fresh);
      const parent = group.parent;
      if (parent.axis === where || parent.children.length === 1) {
        parent.axis = where;
        const room = grow(group.element);
        setGrow(group.element, room * (1 - share));
        setGrow(fresh.element, room * share);
        parent.children.splice(parent.children.indexOf(group) + 1, 0, fresh);
        fresh.parent = parent;
      } else {
        const nested = new Split(where);
        nested.parent = parent;
        setGrow(nested.element, grow(group.element));
        parent.children[parent.children.indexOf(group)] = nested;
        setGrow(group.element, 1 - share);
        setGrow(fresh.element, share);
        nested.children.push(group, fresh);
        group.parent = nested;
        fresh.parent = nested;
        nested.render();
      }
      parent.render();
    }
    this.fitAll();

    if (autostart) {
      void pane.start().then(() => {
        // Closed before it finished starting: there's nothing left to focus.
        if (!focus || !this.groups.has(pane)) return;
        this.setActivePane(pane);
        pane.focus();
      });
    }
    return pane;
  }

  /**
   * A new terminal from the keyboard, of the first profile or the one at
   * `profileIndex`, placed off the focused pane. From the TUI a tab goes beside
   * the last shell instead, so the TUI keeps its column; with no shells at all
   * it opens to the right, as at startup.
   */
  newTerminal(where: Placement, profileIndex = 0): TerminalPane {
    const profiles = getSettings().profiles;
    const spec = this.profileSpec(profiles[profileIndex] ?? profiles[0]);
    if (this.activePane !== this.butPane) return this.open(this.activePane, where, { spec });
    const shells = this.shells();
    if (shells.length === 0) return this.open(this.butPane, "x", { spec, share: 1 - TUI_SHARE });
    if (where === "tab") return this.open(shells[shells.length - 1], "tab", { spec });
    return this.open(this.butPane, where, { spec });
  }

  closeShell(pane: TerminalPane): void {
    if (pane === this.butPane) return;
    const group = this.groups.get(pane)!;
    const wasActive = pane === this.activePane;
    this.groups.delete(pane);
    let neighbour: TerminalPane | undefined;
    if (group.panes.length > 1) {
      neighbour = group.remove(pane) ?? undefined;
      pane.dispose();
    } else {
      const parent = group.parent;
      const index = parent.children.indexOf(group);
      const beside = parent.children[index === 0 ? 1 : index - 1];
      neighbour = this.firstPane(beside);
      // The group beside it takes over the room, rather than leaving a hole.
      if (beside) setGrow(beside.element, grow(beside.element) + grow(group.element));
      parent.children.splice(index, 1);
      pane.dispose();
      group.element.remove();
      this.collapse(parent);
    }
    for (const [path, entry] of this.worktreePanes) {
      if (entry.pane === pane) this.worktreePanes.delete(path);
    }
    this.updateRunControls();
    if (pane === this.runPane) {
      this.runPane = null;
      this.dashboardButton = null;
      this.updateRunControls();
    }

    // The TUI is always there, so there's always somewhere for focus to land.
    const next = wasActive ? (neighbour ?? this.butPane) : this.activePane;
    this.setActivePane(next);
    next.focus();
    this.fitAll();
  }

  /** Folds away a split left with a single child. */
  private collapse(split: Split): void {
    if (split.children.length === 1) {
      const only = split.children[0];
      if (split.parent) {
        const parent = split.parent;
        setGrow(only.element, grow(split.element));
        parent.children[parent.children.indexOf(split)] = only;
        this.adopt(only, parent);
        this.flatten(parent);
        parent.render();
        return;
      }
      // The root keeps its element, so it takes on its only child's contents.
      if (only instanceof Split) {
        split.axis = only.axis;
        split.children = only.children;
        split.children.forEach((c) => this.adopt(c, split));
      }
    }
    split.render();
  }

  /** Splices any child split that runs the same way as `split` into it. */
  private flatten(split: Split): void {
    split.children = split.children.flatMap((child) => {
      if (!(child instanceof Split) || child.axis !== split.axis) return [child];
      const total = child.children.reduce((sum, c) => sum + grow(c.element), 0);
      const room = grow(child.element);
      child.children.forEach((c) => {
        setGrow(c.element, (grow(c.element) * room) / total);
        this.adopt(c, split);
      });
      return child.children;
    });
  }

  private adopt(node: LayoutNode, parent: Split): void {
    node.parent = parent;
  }

  private firstPane(node: LayoutNode | undefined): TerminalPane | undefined {
    if (!node) return undefined;
    return node instanceof Split ? this.firstPane(node.children[0]) : (node.selected ?? node.panes[0]);
  }

  private setActivePane(pane: TerminalPane): void {
    this.activePane = pane;
    const group = this.groups.get(pane);
    group?.select(pane);
    this.allGroups().forEach((g) => g.setActive(g === group));
    this.allPanes().forEach((p) => p.setActive(p === pane));
  }

  private allGroups(): TabGroup[] {
    const walk = (node: LayoutNode): TabGroup[] =>
      node instanceof Split ? node.children.flatMap(walk) : [node];
    return walk(this.root);
  }

  /** Every pane in reading order: left to right, top to bottom, tab by tab. */
  allPanes(): TerminalPane[] {
    return this.allGroups().flatMap((g) => g.panes);
  }

  private shells(): TerminalPane[] {
    return this.allPanes().filter((p) => p !== this.butPane);
  }

  get active(): TerminalPane {
    return this.activePane;
  }

  get tui(): TerminalPane {
    return this.butPane;
  }

  closeActivePane(): void {
    this.closeShell(this.activePane);
  }

  /** Steps through the tabs of the focused pane's group. */
  cycleTab(direction: 1 | -1): void {
    const panes = this.groups.get(this.activePane)!.panes;
    const next = panes[(panes.indexOf(this.activePane) + direction + panes.length) % panes.length];
    this.setActivePane(next);
    next.focus();
  }

  cyclePane(direction: 1 | -1): void {
    const panes = this.allPanes();
    const index = panes.indexOf(this.activePane);
    const next = panes[(index + direction + panes.length) % panes.length];
    this.setActivePane(next);
    next.focus();
  }

  fitAll(): void {
    // A frame of slack lets flex settle before xterm measures.
    requestAnimationFrame(() => this.allPanes().forEach((p) => p.fit()));
  }

  dispose(): void {
    this.allPanes().forEach((p) => p.dispose());
    this.prs.dispose();
    this.element.remove();
  }
}
