---
title: "Desktop app"
description: "Run Vera in a native window that attaches to the resident host."
---

# Desktop app

The desktop app is a sibling client, like the terminal UI. It does not start
itself a separate Vera: it attaches to the resident host for a home and speaks
the same wire protocol over that host's socket.

## The window

The window follows the structure of a code editor: a title bar, a banner area,
the main area and a status bar.

- The title bar is drawn by the app on macOS, with the window controls inset at
  the left. Other platforms keep the system title bar.
- The main area shows the connection state and, once attached, the number of
  sessions the host reports, the host build, the protocol version and the host
  process id.
- The status bar at the bottom shows the connection state, the host build, the
  protocol version, the session count, the home path and the theme choice. The
  host build and home stay on screen after the connection drops; the live values
  do not.
- A banner under the title bar appears when there is no connection or the
  startup check has a question. A lost connection, a host that did not start and
  a missing install each offer Reconnect. The banner shows the reason; long
  reasons scroll inside it.

While attached, the app asks the host for its identity and session count every
three seconds. A reply that does not arrive, or a host that closes the
connection, ends the attachment and shows the banner.

## Finding the host

The app never computes a socket path or starts a host directly. It runs the
installed `vera` command with `boot --json`, which performs the same startup
check and repair as the terminal UI, starts a host if none answers, and prints a
`ready` line with the socket path. The app connects to that path.

The command is found in this order:

1. `VERA_DESKTOP_DEV_CLI`, used by `bun run dev:desktop` so a checkout runs its
   own CLI. `VERA_DESKTOP_BUN` names the Bun executable, defaulting to `bun`.
2. The installed launcher at `~/.local/bin/vera`.
3. Nothing. The banner says `Vera is not installed`, names the path it checked,
   and offers Reconnect. There is no install action in this build.

`VERA_HOME` is inherited unchanged, so a trial home attaches to that home's
host and writes nothing outside it. The app's own Chromium user data, including
the saved theme, lives under `runtime/desktop` in that same home.

## Boot questions

When the startup check asks a question, such as whether to restart a busy host,
the banner shows the question text with Yes and No. The app sends only the
answer the person picks, never an automatic yes. A closed stdin counts as yes to
the check, so closing the window, cancelling, or timing out writes no to the
child before closing its stdin.

## Themes

The interface uses semantic tokens for color, type, spacing, shadow, and motion.
Three themes ship as data files:

- `clients/ui/src/theme/themes/dark.json`
- `clients/ui/src/theme/themes/light.json`
- `clients/ui/src/theme/themes/high-contrast.json`

Switching applies the token values and a `data-theme` attribute to the root
element at once. The saved theme is applied by a script in the page head that
runs before the stylesheet loads, so the first paint already uses it.

Each time a theme is applied, the page reports its resolved surface color to the
app, which sets it as the native window background. The window stays hidden
until the first paint, and the background matches the page while the window is
resized.

The token names are declared in `clients/ui/src/theme/tokens.ts`. Components and
stylesheets outside the theme directory may not carry a literal color, pixel
size, font, shadow, or transition duration; a test scans them and fails on any
of those, and on a `var(--vera-*)` name that is not declared.

## Development

```
bun install --cwd clients/desktop
bun run dev:desktop
```

`dev:desktop` builds the app, prepares the worktree's development home, and
launches Electron with the worktree CLI. It reuses the `dev:tui` home, so the
terminal UI and desktop can attach to the same trial host at the same time.

```
bun run desktop:build
bun run typecheck
bun run typecheck:desktop
bun test test/desktop
node clients/desktop/test/attach.e2e.mjs
```

`bun run typecheck` also checks the shared UI and `test/desktop`;
`typecheck:desktop` checks the Electron layer.

The attach test launches Electron against a throwaway home. It checks the
status bar, the session count, that the theme tokens are applied and the page
raises no content security policy errors, the lost-connection banner,
Reconnect, a live theme switch, and the missing-install banner. It stops only a
host recorded under that throwaway home.

The desktop and the shared UI are not part of the packed release; `pack:release`
copies neither directory.
