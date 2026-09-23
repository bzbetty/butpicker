import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

export const THEME = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  selectionBackground: "#264f78",
  black: "#0d1117",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

/** Every live pane, keyed by pty id, so the two global listeners can route. */
const registry = new Map<string, TerminalPane>();

function decodeB64(input: string): Uint8Array {
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

listen<{ id: string; data: string }>("pty:output", (e) => {
  registry.get(e.payload.id)?.write(decodeB64(e.payload.data));
});

listen<{ id: string; code: number }>("pty:exit", (e) => {
  registry.get(e.payload.id)?.handleExit(e.payload.code);
});

/**
 * Ids must be unique across page loads, not just within one. A reloading dev
 * server would otherwise hand a fresh pane the same id as a pty that is still
 * running, and the old process's exit event would land on the new pane.
 */
let nextId = 0;
const session = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);

export interface PaneSpec {
  cwd: string;
  program: string;
  args: string[];
  /** Extra environment variables for this pane only. */
  env?: Record<string, string>;
  /** Shown in the pane header. */
  label: string;
  /** A pane the user can't close, e.g. the `but tui` pane. */
  pinned?: boolean;
}

export class TerminalPane {
  /**
   * The pty currently backing this pane. A new one per spawn, never reused:
   * on restart the outgoing process's exit event would otherwise arrive after
   * its replacement had started and drop the "exited" overlay over a terminal
   * that is running perfectly well.
   */
  private ptyId: string | null = null;
  readonly element: HTMLDivElement;
  readonly spec: PaneSpec;

  private term: Terminal;
  private fitAddon: FitAddon;
  private body: HTMLDivElement;
  private overlay: HTMLDivElement;
  private observer: ResizeObserver;
  private running = false;
  private disposed = false;

  onFocus?: (pane: TerminalPane) => void;
  onClose?: (pane: TerminalPane) => void;
  onSplit?: (pane: TerminalPane, axis: "x" | "y") => void;

  constructor(spec: PaneSpec) {
    this.spec = spec;

    this.element = document.createElement("div");
    this.element.className = "pane";

    const header = document.createElement("div");
    header.className = "pane-header";

    const title = document.createElement("span");
    title.className = "pane-title";
    title.textContent = spec.label;
    header.appendChild(title);

    const splitRight = document.createElement("button");
    splitRight.className = "pane-btn";
    splitRight.title = "Split right (Ctrl+Shift+D)";
    splitRight.textContent = "◫";
    splitRight.onclick = () => this.onSplit?.(this, "x");
    header.appendChild(splitRight);

    const splitDown = document.createElement("button");
    splitDown.className = "pane-btn";
    splitDown.title = "Split down (Ctrl+Shift+E)";
    splitDown.textContent = "⊟";
    splitDown.onclick = () => this.onSplit?.(this, "y");
    header.appendChild(splitDown);

    const restart = document.createElement("button");
    restart.className = "pane-btn";
    restart.title = "Restart";
    restart.textContent = "↻";
    restart.onclick = () => this.restart();
    header.appendChild(restart);

    if (!spec.pinned) {
      const close = document.createElement("button");
      close.className = "pane-btn";
      close.title = "Close pane";
      close.textContent = "×";
      close.onclick = () => this.onClose?.(this);
      header.appendChild(close);
    }

    this.body = document.createElement("div");
    this.body.className = "pane-body";

    this.overlay = document.createElement("div");
    this.overlay.className = "pane-overlay hidden";

    this.element.append(header, this.body, this.overlay);

    this.term = new Terminal({
      fontFamily: '"Cascadia Mono", "Consolas", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: THEME,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.body);
    try {
      const webgl = new WebglAddon();
      // WebView2 caps live WebGL contexts (~16) and drops the oldest once
      // enough panes exist; a lost context renders garbage until disposed,
      // after which xterm falls back to the DOM renderer.
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      // Falls back to the canvas/DOM renderer; nothing to do.
    }
    // `but pr create` prints a URL; Ctrl+click it into the real browser rather
    // than navigating the webview.
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey || event.metaKey) void openUrl(uri);
      }),
    );

    this.term.onData((data) => {
      if (this.running && this.ptyId) {
        invoke("pty_write", { id: this.ptyId, data }).catch(() => {});
      }
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.running && this.ptyId) {
        invoke("pty_resize", { id: this.ptyId, cols, rows }).catch(() => {});
      }
    });
    this.element.addEventListener("focusin", () => this.onFocus?.(this));
    this.element.addEventListener("mousedown", () => this.onFocus?.(this));

    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.body);
  }

  /** Stops the current pty and, crucially, stops listening to it. */
  private detach(): void {
    if (!this.ptyId) return;
    const stale = this.ptyId;
    this.ptyId = null;
    this.running = false;
    registry.delete(stale);
    invoke("pty_kill", { id: stale }).catch(() => {});
  }

  async start(): Promise<void> {
    this.detach();
    const id = `${session}-${nextId++}`;
    this.ptyId = id;
    registry.set(id, this);

    this.overlay.classList.add("hidden");
    this.fit();
    const { cols, rows } = this.term;
    // Accept input before pty_spawn resolves: output starts flowing while we
    // await, and ConPTY and TUIs query the terminal straight away. Dropping
    // xterm's replies leaves them waiting on an answer that never comes. The
    // backend registers the session before emitting anything.
    this.running = true;
    try {
      await invoke("pty_spawn", {
        id,
        cwd: this.spec.cwd,
        program: this.spec.program,
        args: this.spec.args,
        env: this.spec.env ?? {},
        cols,
        rows,
      });
      // A second restart may have landed while we awaited; don't revive a pty
      // this pane has already moved on from.
      if (this.ptyId === id) {
        // Restarting the focused pane should leave you typing into it, not
        // into a terminal that no longer has the caret.
        if (this.element.classList.contains("active")) this.focus();
      }
    } catch (err) {
      if (this.ptyId === id) {
        this.running = false;
        this.showOverlay(`Could not start ${this.spec.program}\n\n${err}`);
      }
    }
  }

  async restart(): Promise<void> {
    this.term.reset();
    await this.start();
  }

  write(data: Uint8Array): void {
    this.term.write(data);
  }

  handleExit(code: number): void {
    this.running = false;
    this.showOverlay(
      `${this.spec.label} exited (code ${code})`,
      "Restart",
      () => void this.restart(),
    );
  }

  private showOverlay(message: string, actionLabel?: string, action?: () => void): void {
    this.overlay.replaceChildren();
    const text = document.createElement("pre");
    text.textContent = message;
    this.overlay.appendChild(text);
    if (actionLabel && action) {
      const btn = document.createElement("button");
      btn.className = "overlay-btn";
      btn.textContent = actionLabel;
      btn.onclick = action;
      this.overlay.appendChild(btn);
    }
    this.overlay.classList.remove("hidden");
  }

  /** Re-measure. Safe to call when hidden — it just no-ops. */
  fit(): void {
    if (this.disposed) return;
    if (this.body.clientWidth === 0 || this.body.clientHeight === 0) return;
    try {
      this.fitAddon.fit();
    } catch {
      // xterm throws if the renderer isn't ready yet; the next fit will catch up.
    }
  }

  focus(): void {
    this.term.focus();
  }

  setActive(active: boolean): void {
    this.element.classList.toggle("active", active);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    this.detach();
    this.term.dispose();
    this.element.remove();
  }
}
