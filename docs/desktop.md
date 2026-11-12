---
title: "Desktop app"
description: "Run Vera in a native window that attaches to the resident host."
---

# Desktop app

The desktop app is a sibling client, like the terminal UI. It does not start
itself a separate Vera: it attaches to the resident host for a home and speaks
the same wire protocol over that host's socket.

## The window

The window follows the structure of a code editor: a sidebar, the main area
with its header and banner, a right pane and a bottom panel. There is no
full-width title bar and no status bar.

- On macOS the window controls sit in the sidebar's top row, beside a button
  that hides the sidebar. Other platforms keep the system title bar.
- The main area has its own header: the title of what is open on the left and,
  at the right, a button that opens and closes the right pane. When the sidebar
  is hidden, the header leaves room for the window controls and takes the
  button that shows the sidebar again. The window is
  dragged from the sidebar's top row, the main header and the right pane's top
  row.
- The sidebar and the main area are separated by one soft line. Other regions
  are set apart by surface shade.
- The main area shows a greeting and one row each for the sidebar, the right
  pane and the panel, with the shortcut that shows or hides it. Conversations
  open there in a later build.
- The sidebar's bottom row shows a small colored dot with the connection state
  and the host build, and at the right a button that toggles the panel.
  Hovering the state shows the host build, protocol version, host process id and
  home path. The host build stays on screen after the connection drops; the live
  values do not. The theme is chosen from the View menu.
- A banner under the main header appears when there is no connection or the
  startup check has a question. A lost connection, a host that did not start and
  a missing install each offer Reconnect. The banner shows the reason; long
  reasons scroll inside it.

While attached, the app asks the host for its identity and session count every
three seconds. A reply that does not arrive, or a host that closes the
connection, ends the attachment and shows the banner.

## Layout

Views live in three locations: the sidebar on the left, the right pane and the
bottom panel. A location holds view containers. The sidebar switches them with
rows at its top, each an icon and a title, with the selected row filled. The
right pane switches them with rounded tabs in its top row, each an icon and a
title. The panel switches them with tabs. A
container holds one or more views stacked on top of each other, and each view
has a header that collapses it. The main area is not a location for views.

Three views ship with the app:

- Sessions, in the sidebar, lists the first 50 sessions of the home, most recent
  first. Each row has a dot that is filled while the host has the session
  running, the session name, and the time since its last activity at the right,
  written short (`now`, `5m`, `3h`, `2d`, `1mo`, `1y`). It is read-only.
- Host, in the right pane inside the Vera container, shows the connection state
  and tiles for the session count, host build, protocol version, host process id
  and home path. The home path is shortened, with the user's home directory
  written as `~` and a long middle replaced by an ellipsis; hovering it shows the
  full path.
- Output, in the bottom panel, lists the app's own connection events: attaching,
  losing and regaining the host, startup questions and the answers sent. It keeps
  the last 200 lines in memory and does not survive a restart. The panel is
  hidden until it is first shown.

The right pane is closed in the default layout and opens with the button at
the right of the main header, Cmd+Alt+B, the View menu or a command; a saved layout keeps whichever state you left it in.
Moving a view or container into a closed location opens it.

View headers show the view's title in mixed case in a muted color. A container
with a single shown view draws no title for it, since the switcher already names
it; the view's actions button stays at its top right. The chevron and the
actions button appear when the pointer is over the header or the header
has keyboard focus, and the chevron stays visible while the view is collapsed.
Views in a container are separated by space and shade, not by lines.

You can:

- Drag a view header onto another container's header or body to move it there,
  onto the sidebar's rows, the right pane's tabs or the panel's tabs to give it a
  container of its own, or onto the strip that appears at the edge of an empty
  location.
- Drag a container's row or tab to another place in the same strip,
  or to another location.
- Right-click a view header, or use its actions button, to hide the view, move it
  to the sidebar, right pane or panel, move it into another container, move it to
  a new container, or reset its location. Right-click a container's row or tab
  for the same choices on the whole container. Right-click an empty
  part of a strip to show or hide any container placed there.
- Collapse a view by clicking its header, when its container shows more than one
  view.
- Resize the sidebar, right pane and panel by dragging the sash on their inner
  edge. Double-click a sash to restore its default size. With a sash focused, the
  arrow keys move it.
- Hide or show a location with Cmd+B (sidebar), Cmd+J (panel) and Cmd+Alt+B
  (right pane), or with the same items in the View menu. On other platforms the
  modifier is Ctrl. View > Reset Layout puts every view, container, size and
  visibility back to its default.

Each of these is a command. The commands are `layout.toggleSidebar`,
`layout.toggleRightPane`, `layout.togglePanel`, `layout.reset`, `view.moveTo`,
`view.hide`, `view.show`, `view.collapse`, `view.expand`, `view.reset`,
`container.moveTo`, `container.hide`, `container.show`, `container.activate`,
`container.reset`, `theme.dark`, `theme.light` and `theme.highContrast`. Menus
and shortcuts run commands and nothing else.

A view is told whether it is visible and never where it sits. A location with
nothing in it is not drawn, except that the sidebar's rows stay so a container
can be dragged back to the sidebar.

The layout is saved to `machine/desktop/layout.json` under the home, a trial home keeping
its own. The file holds only what you changed, in a versioned format, and is
written after changes settle and when the window closes. A saved layout wins over
every default. If it names a view or container that is not registered, that
entry is ignored and the rest applies; when the view is registered again it
returns to where you last put it. A file that cannot be read is moved to
`layout.json.bad` and the defaults apply.

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
the saved theme, lives under `machine/desktop` in that same home, beside the saved
layout.

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

View > Theme lists Dark, Light and High contrast, with the current theme
checked; the same choices are the commands `theme.dark`, `theme.light` and
`theme.highContrast`. Switching applies the token values and a `data-theme`
attribute to the root element at once and remembers the choice for the next
launch. The saved theme is applied by a script in the page head that runs before
the stylesheet loads, so the first paint already uses it.

Each time a theme is applied, the page reports its name and its resolved surface
color to the app. The app checks the theme in the View menu and sets the color as
the native window background. The window stays hidden
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
node clients/desktop/test/layout.e2e.mjs
```

`bun run typecheck` also checks the shared UI and `test/desktop`;
`typecheck:desktop` checks the Electron layer.

The attach test launches Electron against a throwaway home. It checks the
sidebar footer and its tooltip, the session count, that there are no theme
buttons in the window, that the
theme tokens are applied and the page raises no content security policy errors,
the lost-connection banner, Reconnect, a live theme switch through the View menu
with the menu's checked item following it, and the missing-install banner. It stops only a
host recorded under that throwaway home.

The layout test checks the right pane starts closed, drags Sessions into the
panel, picks the light theme, relaunches Electron on the same home and checks
Sessions and the theme are still there, resets its location, toggles the sidebar,
the right pane and the panel with the shortcuts, toggles the right pane from the
main header button, moves a container through its menu, and resets the layout
from the View menu. It stops the host it started.

The desktop and the shared UI are not part of the packed release; `pack:release`
copies neither directory.
