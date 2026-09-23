import { TerminalPane, type PaneSpec } from "./pty";
import type { Project } from "./projects";
import { getSettings } from "./settings";

export type Axis = "x" | "y";

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

type LayoutNode = Split | TerminalPane;

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
 * One project: the `but tui` on the left and shells beside it, all rooted at
 * the project directory. Any pane splits right or down, so the layout is a
 * tree of rows and columns rather than a fixed pair.
 */
export class ProjectView {
  readonly project: Project;
  readonly element: HTMLDivElement;

  private root: Split;
  private parents = new Map<TerminalPane, Split>();
  private butPane: TerminalPane;
  private activePane: TerminalPane;

  constructor(project: Project) {
    this.project = project;
    const settings = getSettings();

    this.element = document.createElement("div");
    this.element.className = "project";
    this.root = new Split("x", this.element);

    this.butPane = this.makePane({
      cwd: project.path,
      program: settings.butCommand,
      args: settings.butArgs,
      env: settings.butEnv,
      label: `but tui — ${project.name}`,
      pinned: true,
    });
    this.root.children.push(this.butPane);
    this.parents.set(this.butPane, this.root);

    this.activePane = this.butPane;
    this.split(this.butPane, "x", { autostart: false, share: 1 - TUI_SHARE });
    this.setActivePane(this.butPane);
  }

  private makePane(spec: PaneSpec): TerminalPane {
    const pane = new TerminalPane(spec);
    pane.onFocus = (p) => this.setActivePane(p);
    pane.onClose = (p) => this.closeShell(p);
    pane.onSplit = (p, axis) => this.split(p, axis);
    return pane;
  }

  /** Starts every pty. Called once the view is attached and has real dimensions. */
  async start(): Promise<void> {
    await this.butPane.start();
    await Promise.all(this.shells().map((s) => s.start()));
  }

  /**
   * Opens a shell beside `target`, taking `share` of the room it had. Splitting
   * along the axis the pane already sits in adds a sibling; across it, the pane
   * becomes a nested split of its own.
   */
  split(
    target: TerminalPane,
    axis: Axis,
    { autostart = true, share = 0.5 }: { autostart?: boolean; share?: number } = {},
  ): TerminalPane {
    const settings = getSettings();
    const pane = this.makePane({
      cwd: this.project.path,
      program: settings.shell,
      args: settings.shellArgs,
      label: settings.shellLabel,
    });

    const parent = this.parents.get(target)!;
    if (parent.axis === axis || parent.children.length === 1) {
      parent.axis = axis;
      const room = grow(target.element);
      setGrow(target.element, room * (1 - share));
      setGrow(pane.element, room * share);
      parent.children.splice(parent.children.indexOf(target) + 1, 0, pane);
      this.parents.set(pane, parent);
    } else {
      const nested = new Split(axis);
      nested.parent = parent;
      setGrow(nested.element, grow(target.element));
      parent.children[parent.children.indexOf(target)] = nested;
      setGrow(target.element, 1 - share);
      setGrow(pane.element, share);
      nested.children.push(target, pane);
      this.parents.set(target, nested);
      this.parents.set(pane, nested);
      nested.render();
    }
    parent.render();
    this.fitAll();

    if (autostart) {
      void pane.start().then(() => {
        this.setActivePane(pane);
        pane.focus();
      });
    }
    return pane;
  }

  /**
   * A new shell under the focused one. From the TUI it goes under the last
   * shell instead, so the TUI keeps its column; with no shells at all it opens
   * to the right, as at startup.
   */
  addShell(): TerminalPane {
    if (this.activePane !== this.butPane) return this.split(this.activePane, "y");
    const shells = this.shells();
    if (shells.length === 0) return this.split(this.butPane, "x", { share: 1 - TUI_SHARE });
    return this.split(shells[shells.length - 1], "y");
  }

  closeShell(pane: TerminalPane): void {
    if (pane === this.butPane) return;
    const parent = this.parents.get(pane)!;
    const index = parent.children.indexOf(pane);
    const beside = parent.children[index === 0 ? 1 : index - 1];
    const neighbour = this.firstPane(beside);
    // The pane beside it takes over the room, rather than leaving a hole.
    if (beside) setGrow(beside.element, grow(beside.element) + grow(pane.element));
    parent.children.splice(index, 1);
    this.parents.delete(pane);
    pane.dispose();
    this.collapse(parent);

    // The TUI is always there, so there's always somewhere for focus to land.
    const next = neighbour ?? this.butPane;
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
    if (node instanceof Split) node.parent = parent;
    else this.parents.set(node, parent);
  }

  private firstPane(node: LayoutNode | undefined): TerminalPane | undefined {
    if (!node) return undefined;
    return node instanceof Split ? this.firstPane(node.children[0]) : node;
  }

  private setActivePane(pane: TerminalPane): void {
    this.activePane = pane;
    this.allPanes().forEach((p) => p.setActive(p === pane));
  }

  /** Every pane in reading order: left to right, top to bottom. */
  allPanes(): TerminalPane[] {
    const walk = (node: LayoutNode): TerminalPane[] =>
      node instanceof Split ? node.children.flatMap(walk) : [node];
    return walk(this.root);
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

  splitActive(axis: Axis): void {
    this.split(this.activePane, axis);
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
