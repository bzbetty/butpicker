import { TerminalPane, type PaneSpec } from "./pty";
import type { Project } from "./projects";
import { getSettings } from "./settings";

type Axis = "x" | "y";

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
    const totalGrow =
      (parseFloat(prev.style.flexGrow) || 1) + (parseFloat(next.style.flexGrow) || 1);
    const origin = horizontal ? down.clientX : down.clientY;
    document.body.classList.add(horizontal ? "resizing-x" : "resizing-y");

    const onMove = (move: PointerEvent) => {
      const delta = (horizontal ? move.clientX : move.clientY) - origin;
      const size = Math.max(MIN, Math.min(total - MIN, prevSize + delta));
      prev.style.flexGrow = String((totalGrow * size) / total);
      next.style.flexGrow = String((totalGrow * (total - size)) / total);
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

/**
 * One project: the `but tui` on the left, a resizable stack of shells on the
 * right, all rooted at the project directory.
 */
export class ProjectView {
  readonly project: Project;
  readonly element: HTMLDivElement;

  private rightStack: HTMLDivElement;
  private butPane: TerminalPane;
  private shells: TerminalPane[] = [];
  private activePane: TerminalPane;

  constructor(project: Project) {
    this.project = project;
    const settings = getSettings();

    this.element = document.createElement("div");
    this.element.className = "project hsplit";

    this.butPane = this.makePane({
      cwd: project.path,
      program: settings.butCommand,
      args: settings.butArgs,
      env: settings.butEnv,
      label: `but tui — ${project.name}`,
      pinned: true,
    });
    this.butPane.element.style.flexGrow = "1";

    this.rightStack = document.createElement("div");
    this.rightStack.className = "vsplit";
    this.rightStack.style.flexGrow = "1";

    const gutter = document.createElement("div");
    gutter.className = "gutter gutter-x";
    installGutter(gutter, this.butPane.element, this.rightStack, "x");

    this.element.append(this.butPane.element, gutter, this.rightStack);

    this.activePane = this.butPane;
    this.addShell(false);
    this.setActivePane(this.butPane);
  }

  private makePane(spec: PaneSpec): TerminalPane {
    const pane = new TerminalPane(spec);
    pane.onFocus = (p) => this.setActivePane(p);
    pane.onClose = (p) => this.closeShell(p);
    return pane;
  }

  /** Starts every pty. Called once the view is attached and has real dimensions. */
  async start(): Promise<void> {
    await this.butPane.start();
    await Promise.all(this.shells.map((s) => s.start()));
  }

  addShell(autostart = true): TerminalPane {
    const settings = getSettings();
    const pane = this.makePane({
      cwd: this.project.path,
      program: settings.shell,
      args: settings.shellArgs,
      label: settings.shellLabel,
    });
    pane.element.style.flexGrow = "1";
    this.shells.push(pane);
    this.relayoutRight();
    if (autostart) {
      void pane.start().then(() => {
        this.setActivePane(pane);
        pane.focus();
      });
    }
    return pane;
  }

  closeShell(pane: TerminalPane): void {
    // Never leave the right side empty; there'd be no way to get it back.
    if (this.shells.length <= 1) return;
    this.shells = this.shells.filter((s) => s !== pane);
    pane.dispose();
    this.relayoutRight();
    this.setActivePane(this.shells[this.shells.length - 1]);
  }

  private relayoutRight(): void {
    this.rightStack.replaceChildren();
    this.shells.forEach((shell, i) => {
      if (i > 0) {
        const gutter = document.createElement("div");
        gutter.className = "gutter gutter-y";
        installGutter(gutter, this.shells[i - 1].element, shell.element, "y");
        this.rightStack.appendChild(gutter);
      }
      this.rightStack.appendChild(shell.element);
    });
    this.fitAll();
  }

  private setActivePane(pane: TerminalPane): void {
    this.activePane = pane;
    this.allPanes().forEach((p) => p.setActive(p === pane));
  }

  allPanes(): TerminalPane[] {
    return [this.butPane, ...this.shells];
  }

  get active(): TerminalPane {
    return this.activePane;
  }

  get tui(): TerminalPane {
    return this.butPane;
  }

  closeActivePane(): void {
    if (this.activePane !== this.butPane) this.closeShell(this.activePane);
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
    this.element.remove();
  }
}
