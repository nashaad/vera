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
  that hides the sidebar. Back and forward sit at the right of that row. Other
  platforms keep the system title bar.
- The main area has its own header: the title of the current page on the left
  and, at the right, a button that opens and closes the right pane. When the
  sidebar is hidden, the header leaves room for the window controls and takes
  the button that shows the sidebar again, with back and forward beside it. The
  window is dragged from the sidebar's top row, the main header and the right
  pane's top row.
- The sidebar and the main area are separated by one soft line. Other regions
  are set apart by surface shade.
- The sidebar's bottom row shows a small colored dot with the connection state
  and the host build, at the right a button that toggles the panel, and a gear
  that opens Settings. Hovering the state shows the host build, protocol version, host process id and
  home path. The host build stays on screen after the connection drops; the live
  values do not. The theme is chosen from the View menu.
- A banner under the main header appears when there is no connection or the
  startup check has a question. A lost connection, a host that did not start and
  a missing install each offer Reconnect. The banner shows the reason; long
  reasons scroll inside it.

While attached, the app asks the host for its identity and session count every
three seconds. A reply that does not arrive, or a host that closes the
connection, ends the attachment and shows the banner.

## Pages

The main area shows one page at a time. Its title is in the main header. The
pages are New Chat, Search, Work, Customize, Settings and a session.

- New Chat is the home page. It has a greeting, a composer that starts a new
  session, and under it the sidebar, the right pane and the panel, each with the
  shortcut that shows or hides it. The composer is described under Composer.
- Work lists sessions in two sections: Needs you, for sessions stopped at an
  approval or a question, and Running. A section appears only when it has a
  session. With neither, the page says that nothing is waiting on you.
- A session page opens when you pick a row in the Sessions view or on Work. Its
  title is the session name. It is described under Session view.
- Search and Customize are placeholders. Each shows its title, a line of
  description and an empty state. Search lists sessions in the sidebar only, and
  Customize does not read the home's customizations.
- Settings has a list of sections on the left with a search box that filters
  them by name, and the chosen section on the right. Its one section is
  Approvals, described under Approvals and questions.

The sidebar's top rows are the page rows: New Chat, Search, Work and Customize.
The row of the current page is filled. Work shows a count of sessions waiting on
you. Settings opens from the gear in the sidebar's footer.

Back and forward sit in the sidebar's top row, or in the main header when the
sidebar is hidden. Each is disabled when there is no page in its direction.
History holds the last 50 pages. Opening a page other than the current one drops
the forward pages, as a browser does, and opening the current page adds nothing.

Cmd+N opens New Chat, Cmd+[ goes back, Cmd+] goes forward and Cmd+, opens
Settings. The Go menu holds New Chat, Back, Forward and Settings with the same
shortcuts. Search, Work and Customize have commands (`go.search`, `go.work`,
`go.customize`) and no shortcut. On other platforms the modifier is Ctrl.

## Layout

Views live in three locations: the sidebar on the left, the right pane and the
bottom panel. A location holds view containers. Below the sidebar's page rows,
the sidebar switches its containers with rows, each an icon and a title, with the
selected row filled. Those rows are hidden while the sidebar holds exactly one
container. They show with any other number of containers, and while a container
is being dragged. The right pane switches them with rounded tabs in its top row,
each an icon and a title. The panel switches them with tabs. A container holds
one or more views stacked on top of each other, and each view has a header that
collapses it. The main area is not a location for views.

Three views ship with the app:

- Sessions, in the sidebar, lists the first 50 sessions of the home, most recent
  first, in groups by folder. A group's heading is the last segment of the folder
  path, or `No folder` when a session has none. Hovering the heading shows the
  full path. Groups are in the order of their most recent session, and rows keep
  the host's order inside a group. A child session in the same folder is listed
  under its parent, indented. A child of a child is listed under the same top
  parent. A group collapses and expands from its heading; the state is not kept
  across launches. Each row has a dot, the session name, and the time since its
  last activity at the right, written short (`now`, `5m`, `3h`, `2d`, `1mo`,
  `1y`). A session that is running or waiting has a filled blue dot and shows no
  time. The other rows have an outlined dot. Picking a row opens that session,
  and the row of the open session is filled.
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
`container.reset`, `theme.dark`, `theme.light`, `theme.highContrast`, `go.newChat`,
`go.search`, `go.work`, `go.customize`, `go.settings`, `go.back` and `go.forward`.
Menus and shortcuts run commands and nothing else.

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

## Session view

A session page shows that session's conversation, with a composer under it for
your next message. The app watches the session without joining it, so closing
the window leaves the session running. A session that is running keeps
updating as it works. Approvals and questions show as cards under the
conversation; see Approvals and questions.

The conversation is split into turns, one for each message you sent. The first
message is shown as a box across the column; later ones as a bubble on the
right. Under each message:

- `Worked for 12s` with a chevron, from the first to the last timestamped step
  of the turn. It folds the turn's work away.
- Each thought shows as `Thought` and its length in seconds, and opens to show
  its text. A thought still being written shows three dots and its latest line.
- Tool calls that follow one another are grouped. One call shows its phrase,
  such as `Read host.ts`, `Ran git status`, `Searched for outrider in vera-hq`
  or `Searched sessions for outrider`. Several calls show `Ran 3 commands` when
  they are all one tool, and `Used 4 tools` otherwise. A group opens to a card
  with one row per call; a row opens to the command or arguments and the output,
  and a failed call is marked. A group still running shows a dot instead of the
  chevron.
- Replies render a small part of Markdown: headings, paragraphs, lists, bold,
  italic, inline code, links and fenced code. Fenced code has its language and a
  copy button. Links are shown with their address on hover and are not opened.
  Raw HTML is never rendered.
- Notices from Vera, such as errors, show as a strip in the column.
- The end of each turn has a copy button and the time since its last step
  (`just now`, `5m ago`, `1h ago`). Hovering the time shows the exact date and
  time.

The page stays at the bottom as new steps arrive unless you have scrolled up.
It opens with the newest page of history; `Show earlier messages` at the top
loads the page before it. The page keeps at most 2,000 steps loaded. Past that,
the button is replaced by a line saying earlier messages are past what the view
keeps loaded.

When the host is not running, the page says so. When the host closes the
session, or the connection drops, the page keeps what it showed and adds a
strip with the reason.

## Composer

The composer is a box for your message with a row of chips above it and a bar
below it. The chips show where the session runs: `This Mac`, the folder by its
last path segment, and the folder's git branch when it has one. Hovering a chip
shows the full value. The branch is read from the folder's `.git` without
running git; a detached checkout shows the short commit id. The bar has a round
`+` button at the left that attaches images and the send button at the right.

In a session:

- Enter sends the message and Shift+Enter adds a line. The box is disabled
  until the session is attached; its placeholder says `Opening the session`,
  or `Not connected to this session` when the watch has ended.
- While a turn runs, a message you send waits in the queue instead, and the
  placeholder says `Queue a message for when this turn ends`. A strip above the
  composer shows how many messages are queued and the first one, with a button
  that releases the oldest.
- With the box empty: Escape releases the oldest queued message, Enter releases
  all of them, and Up takes the newest one back out of the queue into the box
  to edit. Releasing a message ends the running turn so the message goes next.
- With the box empty and a turn running, the send button becomes a stop button,
  and Enter with nothing queued stops the turn too.
- When the host refuses a message, the box gets its text back if you have not
  typed since, and a line above the box says why.

On New Chat the folder chip is a menu: the folders of your eight most recent
sessions, newest first, then `Open folder…`, which opens the system folder
picker. It starts on the folder of your most recent session, and says
`Choose folder` when there is none. Sending creates a session in that folder
with the host's default model and settings, opens its page, and sends the
message as soon as the page is attached. The page title is the first line of
the message until the session is named.

Images:

- The `+` button opens the system file picker for PNG, JPEG, GIF and WebP
  files. You can also drop image files on the box, paste an image, or paste one
  line of absolute image paths, such as a path copied from Finder.
- A pasted image that is not a file yet is written to
  `machine/desktop/pasted-images` under the home, up to 20 MB, and files there
  are deleted after an hour, the next time an image is pasted.
- Each image shows as a chip, `Image 1`, `Image 2` and so on, with an `x` that
  removes it. A message holds up to eight images. The host copies each image
  into the session; while it does, the chip says `attaching` and the message
  cannot be sent. An image the host refuses is removed, and a line above the box
  names it and gives the reason.
- A message needs text; images go with it.
- On New Chat the images are attached once the new session is open, and the
  message is sent when they are all attached. If one is refused, the message
  stays in the box.

## Approvals and questions

When the session asks before running a tool, a card appears under the
conversation with the tool's name, the command or arguments, and any warning
Vera gives. A line under the cards says `Waiting on you` while one is
unanswered. The card's buttons:

- `Allow once` (key 1) runs this call.
- `Allow similar` (key 2) runs it and allows calls like it for the rest of the
  session.
- `Always` (key 4) runs it and allows calls like it in every session.
- `Deny` (key 3 or Escape) refuses it; the turn goes on without it.
- `Why?` shows Vera's reason and what Allow similar would allow.

Allow similar and Always appear only when Vera offers them for that call; a
subagent's request offers only Allow once and Deny.

A question from Vera shows its choices, numbered. A number key or a click picks
one. When the question takes a typed answer, a box under the choices sends what
you write with `Answer` or Enter, and a note box sends a note with the choice.
`Skip` or Escape cancels the question.

A setup request, such as a provider that needs signing in, says what is needed
and has `Dismiss` (Escape), which tells Vera the setup cannot be done from this
window. Finish it from the terminal.

The keys answer the first card without an answer. They work when the composer
is empty or not focused, and not while you type in a field or hold Cmd, Ctrl or
Alt. While a card waits, Escape answers it instead of releasing a queued
message. An answered card stays until Vera closes it.

The approval pill at the left of the composer's bar shows the session's mode
and opens a menu:

- The modes: `Ask for approval`, `Approve for me` (a reviewer clears the safe
  calls and asks you about the rest), `Read only` and `Full access`, then any
  mode defined in the home. Picking one changes this session. A change made
  while a turn runs applies when the turn ends, and the pill says
  `after this turn` until then.
- `Make this the default for new sessions` saves the session's mode as the
  home's default.
- `This session allows` lists what Allow similar has allowed, and
  `Every session allows` lists what Always has allowed, each with an `x` that
  removes it.

When Vera refuses a change, the pill's menu says so. On New Chat the pill says
`Default approvals` and starts the new session in the home's default mode until
you pick another; the pick applies to that session only.

Settings > Approvals names the default mode and the standing permissions and
says where to change them: the window reads both only through a session's pill.

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
node clients/desktop/test/compose.e2e.mjs
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

The compose test runs a local provider that streams fixed replies and points a
throwaway home's only model at it. It starts a session from New Chat in a folder
picked through a stubbed folder picker, checks the message and the streamed
reply, queues a message during a running turn, takes it back with Up, queues it
again and releases it with Enter, stops a turn from the stop button, and sends a
message with an attached PNG, checking the provider received the image. It
stops the host it started.

`bun test test/desktop` also covers turning history and live updates into the
transcript, paging and its cap, and the session pipe in the app.

The desktop and the shared UI are not part of the packed release; `pack:release`
copies neither directory.
