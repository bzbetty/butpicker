# ButPicker

A small Tauri desktop app that gives every git repository a tab, and every tab
the [GitButler](https://gitbutler.com) TUI on the left with terminals on the
right — both rooted at the repository directory.

Replaces the "Windows Terminal with one tab per repo, plus a second pane for
`but land`" arrangement with something that remembers which repos were open.

## What's in a tab

```
┌─ billing-api  3 ⎇2 ─┬─ web-app ─┬─ + ──────────────────┐
├─────────────────────┴───────────┴──────────────────────┤
│  but tui                   ║  pwsh                     │
│  (pinned, restartable)     ║───────────────────────────│
│                            ║  pwsh                     │
└────────────────────────────────────────────────────────┘
```

- The left pane runs `but tui`. It can't be closed, only restarted (`↻` or
  `Ctrl+Shift+R`). If `but` exits it says so and offers a restart.
- The right side is a stack of shells, all started in the repository directory.
  Add with `Ctrl+Shift+T`, close with `Ctrl+Shift+W`.
- Every divider drags.
- Tabs drag to reorder.

## Opening a repository

`Ctrl+T` lists every git repository directly under your git root (`C:\git` by
default). There's no adding or importing — the folders on disk are the list.

The filter is a subsequence match, so `biap` finds `billing-api`. Arrow keys
move the cursor, Enter opens. Repos you already have open sort to the bottom,
since the picker is for the ones you haven't got in front of you.

## Tab badges

Each tab polls `but status --json` every six seconds (only while the window has
focus) and shows what it finds:

| Badge | Meaning |
| --- | --- |
| amber count | uncommitted files, including those assigned to a stack |
| blue `⎇` count | applied branches across all stacks |

Branches listed in `statusIgnoreBranches` are left out of the count — `plans`
by default, since plan branches get pushed but never merged and would otherwise
sit in the badge forever.

## Session restore

Closing the app and reopening it puts the same tabs back, in the same order,
with the same one active. The open set is written on every tab change (debounced
250ms) rather than only on close, so an unclean exit doesn't cost the workspace;
`onCloseRequested` just flushes any pending write. Tabs restore sequentially — a
dozen ptys starting at once makes for a slow, flickery launch.

Repositories that have since disappeared are skipped rather than erroring.

## Keyboard

| Shortcut | Action |
| --- | --- |
| `Ctrl+T` | Open the repository picker |
| `Ctrl+W` | Close the current tab (middle-click also works) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+1`…`Ctrl+9` | Jump to tab by position |
| `Ctrl+Shift+PageUp` / `PageDown` | Move the current tab left / right |
| `Ctrl+Shift+T` | New terminal pane |
| `Ctrl+Shift+W` | Close the focused terminal pane |
| `Ctrl+Shift+R` | Restart the `but tui` pane |
| `Ctrl+]` | Cycle focus between panes |

Everything else goes straight to the pty, so `but`'s own keys and `Ctrl+C` in a
shell behave normally.

## Running it

```sh
npm install
npm run tauri dev      # dev, with hot reload on the frontend
npm run tauri build    # installer under src-tauri/target/release/bundle
```

On Windows this needs the WebView2 runtime (ships with Windows 11) and Visual
Studio Build Tools with the C++ workload. `rust-toolchain.toml` pins only the
compiler version, so the host default toolchain is used; on Windows that should
be MSVC, because `windows-gnu` dies partway through the dependency tree with
`error calling dlltool 'dlltool.exe': program not found`, which reads like a
missing system package rather than the wrong toolchain.

On Linux it needs the usual Tauri system libraries, e.g. on Debian/Ubuntu:

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev build-essential
```

## Configuration

Settings live in `localStorage` under `butpicker.settings`:

```json
{
  "shell": "pwsh.exe",
  "shellArgs": ["-NoLogo"],
  "shellLabel": "pwsh",
  "butCommand": "but.exe",
  "butArgs": ["tui"],
  "butEnv": { "BUT_OUTPUT_FORMAT": "human" },
  "statusIgnoreBranches": ["plans"],
  "scanRoot": "C:\\git"
}
```

Those are the Windows defaults; on other platforms they default to `bash -l`,
`but` and `~/git` instead. Change `shell` to `cmd.exe` or a Git Bash path if
you'd rather. `butCommand` resolves through `PATH`; set an absolute path if you
run a non-default build. A `scanRoot` starting with `~/` is expanded against the
home directory.

Open tabs are stored separately, in
`%APPDATA%\dev.bzbetty.butpicker\session.json` (Windows) or
`~/.config/dev.bzbetty.butpicker/session.json` (Linux).

## How it works

- `src-tauri/src/pty.rs` — real pseudo-terminals via `portable-pty` (ConPTY on
  Windows). Output is base64-framed onto a `pty:output` Tauri event, because a
  16KB read can land mid-escape-sequence; the frontend decodes to a
  `Uint8Array` and hands it straight to xterm.
- `src-tauri/src/status.rs` — shells out to `but status --json` for the badges,
  with `CREATE_NO_WINDOW` so polling doesn't flash a console every six seconds.
- `src-tauri/src/projects.rs` — directory listing plus the session file.
- `src/pty.ts` — one `TerminalPane` per pty: xterm, fit addon, WebGL renderer
  with a silent fallback, and a `ResizeObserver` keeping the pty's window size
  in sync.
- `src/workspace.ts` — the split layout. Panes use `flex-basis: 0`, so dragging
  a gutter is just trading `flex-grow` between two neighbours.

Two details exist purely because of exit-event routing, and both were bugs
first. Pty ids carry a per-page-load UUID and are minted fresh on every spawn,
never reused — otherwise a restarted pane inherits the id of the process it just
killed, and that process's exit event arrives moments later to drop an "exited"
overlay over a terminal that is running perfectly well. The frontend also calls
`pty_kill_all` as it boots, because a dev-server reload forgets its panes but
not the processes behind them.

Spawned ptys get `CLAUDECODE`, `AI_AGENT`, `CI` and friends stripped from their
environment. `but` switches to JSON output when it thinks an agent is reading it
and then refuses to open the TUI at all — and a pane here is a real interactive
terminal regardless of how ButPicker itself was launched.

## Known limitations

- Pane splits aren't persisted: restored tabs come back as one TUI plus one
  shell, however you had them arranged.
- Closing a pane kills the process attached to the pty. Grandchildren it spawned
  are left to ConPTY's teardown rather than tracked in a job object.
- Settings have no UI; edit `butpicker.settings` via devtools.
- Only the immediate subdirectories of the root are scanned, not nested repos.

## Licence

MIT
