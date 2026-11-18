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
  and, when Host build is shown, the host build, at the right a button that
  toggles the panel when a view is placed there, and a gear that opens Settings. Hovering the state shows the host build, protocol version, host process id and
  home path. Feedback opens a report form from the footer or the command palette.
  Help, a button with an icon and the word Help, opens the right pane if it is
  closed and a new Chat tab on a new chat with the help agent each time it is
  pressed; the main area stays on its page, so Help works from New Chat too. The agent
  answers questions about Vera and can open a dialog, a Settings section or a
  page in the window to show where something is; see Chat tabs.
  The host build stays on screen after the connection drops; the live
  values do not. The theme is chosen from the View menu.
- A banner under the main header appears when there is no connection or the
  startup check has a question. A lost connection offers Reconnect. A host that
  did not start and a missing install offer Try again and Run doctor, which opens
  the health check described under Sheets. The banner shows the reason; long
  reasons scroll inside it.
- While Browser tools are on, a notice at the bottom of the window says Vera can
  open, read and act on pages in the Browser and offers Turn off. The notice
  stays in every view until the tools are turned off.

While attached, the app asks the host for its identity and session count every
three seconds. A reply that does not arrive, or a host that closes the
connection, ends the attachment and shows the banner.

When you quit the desktop app with background commands in a conversation open
in the main pane, a chat tab or a subagent pane, a confirmation counts them and offers `Cancel`,
`Keep running`, and `Stop and quit`. Keep running quits as usual and leaves the
conversations running; the host parks them after ten idle minutes. Stop and quit
asks the host to close each counted conversation still open in a pane before
quitting, with a three-second deadline.
Cancel or Escape leaves the app open. The warning appears for menu Quit, Cmd+Q,
and closing the last window when that closes the app.

## Pages

The main area shows one page at a time. Its title is in the main header. The
pages are New Chat, Search, Work, Customize, Settings, Devices, Tour, Coverage, a
workspace and a session. Search, Work, Customize, Devices, Tour and Coverage are
parts of the window that Settings > Show can hide; see Showing parts of the
window.

- New Chat is the home page. It has a greeting, a composer that starts a new
  session, and under it the sidebar, the right pane and the panel, each with the
  shortcut that shows or hides it. The composer is described under Composer.
- Search finds sessions by what was said in them and by their titles. The host
  searches the messages, tool commands and file edits of every session, and the
  window matches titles of the sessions it has listed. Each result shows the
  session's title, folder (`Chat` for a chat) and age, and under it the lines
  that matched, with the words you typed marked. Everything searches all sessions; This conversation
  searches only the session last open. A menu limits the search to one folder and
  lists no chats.
  Picking a result opens the session. When the host stops at its first 20
  sessions, a note under the results asks for more words.
- Work lists sessions in three sections: Needs you, for sessions stopped at an
  approval or a question, Running, and Finished since you last looked, for
  sessions whose turn ended while the window was open and that you have not
  opened since. A finished session leaves the list after an hour or when you open
  it. A section appears only when it has a session. With none, the page says that
  nothing is waiting on you.
- A workspace page opens when you click a folder's title in the Sessions view. It
  shows the folder's path, its git branch and the machine, a New chat here
  button that opens New Chat in that folder, and Show in Finder (Open folder on
  other platforms). Below them it counts the folder's sessions, the running ones
  and those that need you, says when the folder was last active, and lists its
  sessions.
- Devices lists the machines this window can reach. Today that is only this
  machine, with the connection state and host build. Picking it shows the host's
  state, its home and the newest sessions on it.
- A page an extension gives a pane, such as Artifacts, has its own row under
  the page rows in the sidebar, labelled with the page's label. It opens the page
  at full size in the main area with no query, so Artifacts lists the artifacts
  of every session in the home, newest first, in a group for each session, 50 at
  a time with Show more up to 200. The page loads in the same frame as a pane
  tab, with Reload and Open in your browser. When the annex is down or does not
  list the page, the page says so. The row is filled while the page is shown.
- A session page opens when you pick a row in the Sessions view, on Work, on
  Search or on a workspace or device page. Its title is the session's title, as
  its sidebar row shows it. It is described under Session view.
- Customize shows what Vera loads for a session in one folder: skills, agents,
  extensions, instruction files and memory files. A menu picks the folder; it
  starts on the folder of the session last open, and lists no chats. The page
  asks the host to read the folder, so it needs no session: a stopped session is
  not started and no message is sent. With no folder picked it lists what a new
  chat loads from the home: skills, agents, extensions, rules and memory files,
  and no project items.
  If the host was started before this request existed, the page says `Vera needs
  a restart to read what this folder loads.` with Retry. Pills filter by kind
  with a count on each, a search box matches names and
  descriptions, and Reload reads again. Items are grouped as This folder, Your
  home, Extensions, Built in and Other. Extensions included with Vera are not
  listed; their skills and agents are. A card shows the name, the description, the kind
  and badges such as Current for the agent a new session starts on, Manual only for a skill
  Vera does not load on its own, and an extension's state. An extension the host
  could not load shows its error. Picking a card opens a sheet with its facts
  and the file's text, and Show in Finder (Open folder on other platforms) when
  the item has a file. Customize does not add, remove, install or edit those
  items. Above them, Yours lists the desktop extensions that add to this app,
  with a switch, Remove and Install from file; see Desktop extensions.
  Yours and Discover switch the page's view; it opens on Yours, which is
  everything above. Discover lists the themes in the extension catalog and
  installs one after a preview; see The theme catalog. The web client has no
  catalog: its Discover says so, names `/extension install <path>` in the
  terminal, and offers Open Yours.
- Tour lists every screen, sheet and session state in the window as cards, one
  click from each. Session cards open the newest session that is working,
  waiting on you, finished or idle, and say None right now when there is none.
  Page cards open a page and sheet cards open a sheet; a part that is off has no
  card. A Theme menu at the bottom switches the theme. Nothing on the Tour is staged; every card opens
  the real screen on the host the window is attached to.
- Coverage lists the steps of a session and, for each behavior in it, whether
  the window does it, does part of it, leaves it to the terminal, or cannot do
  it because the host does not serve it, with a note naming where to do it
  instead. A bar and a percentage sum it up, and pills filter by status.
  Tour and Coverage each have a button beside the title that opens the other.
- Settings has a list of sections on the left with a search box that filters
  them by name and keywords, and the chosen section on the right. It opens on
  Appearance. The sections sit under two headings: Settings, and Desktop for
  what the window keeps itself. When the page is narrow the list shows only
  each section's icon, with its name on hover, and the search box becomes a
  search icon. Clicking that icon opens the whole list over the section;
  Escape, a click outside or picking a section closes it again. A setting's
  control moves under its description when there is no room beside it.
  - Appearance picks the theme, imports a VS Code theme, and sets text size, code size and density (each
    Small or Compact, Default, Large or Comfortable), and has two switches. Reduce
    motion stops the status line's dots and sweep and the fade on new words. Past
    approvals, off by default, keeps each answered approval card in the
    conversation instead of dropping it; see Approvals and questions. These five
    are kept in the desktop's browser storage under the home's
    `machine/desktop/chromium`, not in `config.json`, so other clients do not use
    them.
  - Agents has the Suggest keeping notes switch, on by default, and lists the
    agents a session in the folder of the last open session can run as, or a new
    chat when there is none, with their scope and description, read from the
    host the same way as Customize, with or without a session. The list does
    not change them; Choose Agent does. With the switch on, each session the
    window creates is told to offer to keep notes once, when a conversation
    produces something worth keeping. A session keeps the choice it was created
    with, so changing the switch affects new sessions only. The switch is kept
    in the desktop's browser storage like the Appearance settings, so other clients do not use them. The
    terminal, `vera -p` and the web client never offer notes.
  - Approvals is described under Approvals and questions and Providers under
    Models.
  - Workspaces lists the folders of the listed sessions, leaving out chats, the most recently
    active first, each with its path, session count and last activity, and Open,
    New chat here and Show in Finder.
  - Git & PRs lists the same folders with each one's current branch and says that
    Vera has no git or pull request settings.
  - Devices says that no other device can reach the host, since it listens on a
    local socket, and lists this window as the one active connection with the
    time it attached. Other clients attached to the same host are not listed.
  - Keyboard lists every shortcut by group with a search box. Shortcuts cannot
    be changed.
  - Show, under Desktop, has one row per part of the window that can be hidden,
    each with Auto, On and Off, or On and Off where Auto does not apply. It is
    described under Showing parts of the window.
  - Data, under Desktop, counts the sessions the host lists, shows the
    desktop's folder `machine/desktop` in the home with Show in Finder (Open
    folder on other platforms), and has Reset for the appearance and for the
    layout.

The sidebar's top rows are the page rows: New Chat, Search, Work and Customize.
New Chat is always there; the others show when their part of the window is shown.
A page an extension gives a pane adds a row under these. The row of the current
page is filled. Work shows a count of sessions waiting on
you. Tour, Devices, Feedback and Settings open from the buttons in the
sidebar's footer, where Tour and Devices show only when their parts are on. Help
in the same footer opens a Chat tab.

Back and forward sit in the sidebar's top row, or in the main header when the
sidebar is hidden. Each is disabled when there is no page in its direction.
History holds the last 50 pages. Opening a page other than the current one drops
the forward pages, as a browser does, and opening the current page adds nothing.

Cmd+N opens New Chat, Cmd+[ goes back, Cmd+] goes forward and Cmd+, opens
Settings. The Go menu holds New Chat, Back, Forward, Search, Work, Customize,
Devices, Settings, Tour and Coverage. Search, Work, Customize, Devices, Tour and
Coverage have no shortcut; the command palette reaches them. The menus leave out
the entries of parts that are off. On other platforms the modifier is Ctrl.

## Command palette and sheets

Cmd+K or Cmd+Shift+P opens the command palette. It lists commands that
need no argument and whose part of the window is shown, grouped as Go, Pages,
Window, Session, Theme and Help, with each command's shortcut. Individual theme
commands appear when you search for their names; Choose Theme and the import commands
are listed without a search. Typing filters the list by fuzzy match and marks the matched
letters. Up and Down move, Enter runs the command and Escape closes the
palette. Cmd+P opens Go to Session, the same list over sessions, each with its
folder and age and a dot while it is working or waiting on you; Enter opens the
session. Both are in the View menu.

Cmd+/ opens Keyboard Shortcuts, a sheet with every shortcut by group and a
filter box. The Help menu holds it and the sheets below. Each sheet closes with
Escape, its close button or a click outside it.

- Choose Agent, in the View menu, lists the agents the open session can run as,
  with the current one checked. A click or its number key switches the session
  to that agent. On New Chat it lists the agents a new session in the picked
  folder would offer, and a pick becomes the agent the first message runs as;
  see [Choose the agent of a new chat](agents.md#choose-the-agent-of-a-new-chat).
  With no session open and no New Chat page it says to open one.
- Choose Theme lists the built-in themes and the themes of the enabled
  desktop extensions with a swatch; a click or a number key (for the first nine)
  applies one.
- Rename Session, in the palette, opens a sheet with the open session's name to
  edit. Enter or `Rename` saves it. The host refuses an empty name, one over
  200 bytes, and a session that cannot be renamed, and the sheet says which.
- Session Diagnostics lists the open session's facts (id, title, folder, model,
  queued prompts, open requests; a chat's folder reads `Chat`) and the host's (connection, process id, build,
  protocol, home, platform). Copy puts them on the clipboard as text.
- Check Vera's Health checks the connection, the protocol version, the session
  list, extensions and providers from what this window knows, with Run again.
  For a full check it suggests `vera doctor` in a terminal and copies it.
- Extensions lists the extensions the host could not load, with each error, and
  opens Customize. Turning those extensions on or off and installing them is not
  available from the window. Desktop extensions are managed in Customize.
- Configuration Files lists Vera's configuration files and what each holds, and
  shows the Vera home in Finder. Editing them is done with `/configure` in the
  terminal UI.
- Feedback opens a form to report a bug or request a feature. Choose a kind,
  enter a title and description, and optionally include a screenshot captured
  when the form opened or add images by picker, drop or paste. Remove an image
  before saving if needed. Save report writes it on this computer and offers to
  show the report folder in the file manager. Escape cancels.
- Model Failures and Standing Nudges say the window cannot read them and
  name the terminal commands that do: `/failure-report` and `/diagnostics` for
  failures, `/nudges` for nudges.

Copying a conversation, the diagnostics or the doctor command, switching
agents, and renaming, cloning or closing a session, show a short notice in the
window's corner that fades on its own.

## Layout

Views live in three locations: the sidebar on the left, the right pane and the
bottom panel. A location holds view containers. Below the sidebar's page rows,
the sidebar switches its containers with rows, each an icon and a title, with the
selected row filled. Those rows are hidden while the sidebar holds exactly one
container. They show with any other number of containers, and while a container
is being dragged. The panel switches them with tabs. A container holds
one or more views stacked on top of each other, and each view has a header that
collapses it. The right pane works differently, described below. The main area
is not a location for views.

The right pane holds tabs. A tab is one open copy of a kind of pane: Review,
Plan, Files, Browser, Chat or Subagents, or a page supplied by Vera or an extension. The kinds come from one list, and the tiles, the
launcher, the tab strip and the saved layout all follow it. The top row holds the
tabs, a `+` button, and at the right the button that closes the pane. A tab shows
its kind's icon and title, or the page's title for a Browser tab, and has a close
button that shows while the pointer is over the tab and on the active tab. The
same kind can be open any number of times, up to 16 tabs in the pane; Browser and
Chat each have a limit of their own, Chat tabs are limited to 6, Subagents has one tab, and an extension page has up to 3. A page's kind is titled with the page's label and has the page icon, and its tile and launcher row open the page's list. The Chat kind's
tile and launcher row are titled Help and start a new Help chat. With no tabs the
pane shows a search field, recent pages and a New section with one tile for each
kind that can be opened. The field filters tiles and recent pages; it also opens a
web address. Focus the field to see recent pages, use the arrow keys to select one
and Enter to open it, or Escape to close the list. Other text filters without
opening a web search. Recent pages stay in the desktop home between launches.
A tile is disabled while its kind cannot take another tab. Picking a tile, or a
kind in the launcher, always opens a new tab of that kind and shows it. `+`
opens the launcher, which has a filter field and a row for each kind with its
shortcut. If the typed text is a web
address, such as `example.com/docs`, `localhost:3000` or one that starts with
`https://`, the first row opens it in a new Browser tab; a bare word such as `files`
only filters. Up/Down move through the rows, Enter opens the focused row and Escape
closes the launcher. A view's own empty state shows inside its tab as before.
Cmd+W (Ctrl+W on other platforms), or View > Close Tab, closes the shown tab;
with the right pane hidden or no tab open it does nothing, so it never closes the
window. Closing the last tab brings the tiles back.

When a tool in the open session returns a notice with a link to a page that has
its own pane, as `artifact_write` does, the window makes sure that page has a tab
in the right pane. The tab opens on the linked address, behind the tab you are on;
the new tab is shown only when the pane is open and shows no tab. The window never
switches tabs, opens a closed pane or takes the keyboard focus for it, and a later
notice does not move a tab that is already open. A tab that is not the shown one
gets a green dot while something new arrived for it, and while the pane is hidden
the dot is also on the button that opens the pane. Showing the tab clears it. The
dots are not saved. Only notices that arrive while the window watches the session
count, not the history it opens with. When the pane already holds 16 tabs, or the
page its limit, a notice opens nothing and shows no dot.

Seven views ship with the app:

- Sessions, in the sidebar, lists the first 50 sessions of the home, most recent
  first, in groups by folder. A group's heading is the last segment of the folder
  path, or `No folder` when a session has none. Hovering the heading shows the
  full path. Chats, which are sessions with no folder of their own, share one
  group headed `Chats`; its heading opens no workspace page. Groups are in the
  order of their most recent session, and rows keep
  the host's order inside a group. A subagent is listed indented under the
  session that started it, in that session's group, including under a chat; a
  subagent of a chat does not get a group named after the chat's folder. A
  subagent of a subagent is listed under the same top parent. A pinned session's
  subagents are listed under it in Pinned, and a pinned subagent is listed in
  Pinned on its own. Subagents start collapsed beneath their parent. A count such
  as `2 nested` shows how many are listed, with `· 1 working` when one is working.
  Click the count or the chevron beside the parent title to show the nested rows;
  click the chevron again to collapse them. A group and a parent collapse and
  expand while the window stays open; neither state is kept across launches.
  Archived sessions and their subagents leave Pinned, Chats and their folder
  groups for an `Archived` group at the bottom. It starts collapsed. Opening an
  archived session from that group or Go to Session does not unarchive it. Each
  row shows the session's title and its status at the right. A working session
  has a rotating indicator, a session waiting on you has a filled dot, and the
  other rows have an outlined dot and the time since their last activity, written
  short (`now`, `5m`, `3h`, `2d`, `1mo`, `1y`). Reduce motion stops the rotating
  indicator. Picking a row opens that session, and the row of the open session is
  filled.

  A session's title is its name, whether you gave it or Vera's automatic titles
  did, or else the start of its first prompt, the same as in the terminal UI.
  Only a session with neither shows its generated name, such as
  `swift-stone:d14d`. The row and the window's title bar follow a rename within
  the sidebar's three-second refresh, without another turn. The title bar and
  the empty session page read the title of the open session from the host.

  Hovering a row shows a `…` button in place of its time; it and a right-click
  on the row open the row's menu:

  - Rename… opens the session and its rename sheet.
  - Pin Session moves the row into a `Pinned` group at the top of the list, in
    the order the sessions were pinned, and Unpin Session puts it back under its
    folder. Pins are kept per home in `machine/desktop/pins.json`, at most 50; a
    newer pin past that drops the oldest. The terminal UI keeps its own pins. A
    pinned session shows only while it is among the sessions the list has loaded.
  - Archive Session moves the session and its subagents into Archived; Unarchive
    Session returns them to their groups, including Pinned when still pinned.
    Either action on a subagent's row applies to its parent session family,
    even when the parent is outside the loaded page. Pins are preserved. The host saves the archive choice with
    the session, so it survives a host restart and other windows see it too.
    Archiving leaves the open conversation shown, never stops a running turn and
    does not change when an idle session parks. A session that needs you still
    shows its notice, which opens it without unarchiving. The terminal has no
    archive control, and archiving does not hide a session there.
  - Open Files Pane opens the session and the right pane on its Files view. The
    row is offered while Files is shown.
  - Clone Session copies the session and opens the copy.
  - Close Session stops the session, and is offered only while the host runs it.
    Closing the open session returns to New Chat; closing another leaves the page
    as it is. If the session has background commands, a confirmation counts
    them and offers `Stop and close` or `Cancel`.
- Review, Plan and Files, each in its own container that opens as right pane
  tabs, follow the open session; see Session tools. Each can be shown or hidden in
  Settings > Show.
- Browser, in its own container that opens as right pane tabs, holds websites;
  see Browser.
- Chat, in its own container that opens as right pane tabs, shows one session's
  conversation with its own composer; see Chat tabs.
- Output, in the bottom panel, lists the app's own connection events: attaching,
  losing and regaining the host, startup questions and the answers sent. It keeps
  the last 200 lines in memory and does not survive a restart. The panel is
  hidden until it is first shown.

The right pane is closed in the default layout and opens with the button at
the right of the main header, Cmd+Alt+B, the View menu or a command; a saved layout keeps whichever state you left it in.
Moving a view or container into a closed location opens it. A new window has no
right pane tabs.

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
- Drag a right pane tab to another place in the strip to reorder it. Dragging it
  to the sidebar or the panel moves its kind's container there and closes every
  tab of that kind in the pane. Dragging a container from the sidebar or the panel
  into the right pane opens one tab of its kind. Containers placed in the sidebar
  or the panel are not offered by the tiles or the launcher.
- Right-click a view header, or use its actions button, to hide the view, move it
  to the sidebar, right pane or panel, move it into another container, move it to
  a new container, or reset its location. Right-click a sidebar row or a panel tab
  for the same choices on the whole container. Right-click a right pane tab for
  Close, then the same choices on its kind's container; hiding or moving the
  container closes every tab of that kind. Right-click an empty part of a strip to
  show or hide any container placed there.
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
`layout.toggleRightPane`, `layout.togglePanel`, `layout.closeTab`, `layout.reset`, `view.moveTo`,
`view.hide`, `view.show`, `view.collapse`, `view.expand`, `view.reset`,
`container.moveTo`, `container.hide`, `container.show`, `container.activate`,
`container.reset`, `tab.open`, `tab.activate`, `tab.close`, `chat.help`, `theme.<name>` (one per built-in theme, with `theme.highContrast` for High contrast),
`theme.imported.<name>` (one per theme a desktop extension adds), `vera.vscode-theme-import.import`,
`vera.vscode-theme-import.installed`, `go.newChat`,
`go.search`, `go.work`, `go.customize`, `go.settings`, `go.back`, `go.forward`,
`session.rewind`, `session.compact`, `session.subagents` (shows the Subagents tab), `session.tasks`,
`session.copyConversation` and `session.quote`. `container.activate` and the shortcuts of a kind show the most
recently active tab of that kind, and open one when there is none; `tab.open`
always opens a new tab of the kind, and `tab.activate` and `tab.close` take a
tab's id.
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

The file also holds the right pane's tabs: each tab's kind and order, and which
one is active. Browser, Chat and Subagents tabs are not saved, so none returns after
a restart, and a layout that holds only those tabs comes back with none. A tab of an
extension page is saved and comes back showing the page's list. A layout saved before the
right pane held tabs opens with one tab, of the container that was active in the
pane. A tab saved for a kind that is not registered is ignored, and a tab list
that cannot be read is dropped and the pane opens with no tabs.

## Showing parts of the window

Optional parts of the window have one setting each, in Settings > Show. A
setting is Auto, On or Off. A choice applies at once, with no restart, and is
kept in `machine/desktop/flags.json` under the home:

```
{"work": "on", "devices": "off", "showReasoning": "on"}
```

The file holds only the choices made, so a part it does not name follows its
default. Saving a choice leaves any other key in the file as it was. The window
reads the file when it starts or its page reloads, so a hand edit needs a
restart. A missing, oversized (over 4 KB) or invalid file puts every part at its
default. The host does not read the file.

The core of the window has no setting and is always shown: New Chat, the
Sessions view, the composer, Choose Agent, Settings, Feedback and Help.

On shows a part. Off removes its entry points: its page row or button, its
commands in the command palette, the menus and the slash menu, its shortcut, its
Tour card, and a pane toggle when no pane is left to open. Off deletes no data and
stops no work. Changes, plans and files stay with their sessions, the connection
log keeps recording, and the browser keeps running. A part turned on again shows
what it held, and a pane keeps its place in the saved layout while hidden. Its
right pane tabs and its tile are not shown while it is Off, and the tabs return
when it is turned on again. A page
that is open when its part is turned off stays open until you leave it. Run
doctor on the host banner works whether or not the health check is shown.

Auto shows a part once it has something to show:

- Search, once the host lists a session.
- Work, once the host lists two sessions.
- Customize, once the window has connected to the host.
- Review, once the open session has changed files.
- Plan, once the open session has a checklist.
- Files, in a session that has a folder.
- Output, once the connection log holds a warning or an error.
- Context use, once the open session has reported it or can be started.
- Check Vera's Health, once the connection to the host has failed.

A part that Auto has shown stays shown until the window closes. Review, Plan,
Files and Context use follow the open session: what that session has had so far
counts, so they stay while it is open, and another session may show different
ones. A page with no session, such as New Chat or Settings, shows none of the
four under Auto.

Some parts have no Auto, because nothing in the window says when they have
something to show. They offer On and Off, and an `auto` in the file for one of
them reads as its default:

- Browser, On by default.
- Reasoning, Off by default; see Showing reasoning.
- For developers: Devices, Tour, Coverage, Session Diagnostics, Model Failures,
  Configuration Files, Standing Nudges, Extensions and Host build. Each is Off in
  the packaged app and On when the window runs from a source checkout.

## Session view

A session page shows that session's conversation, with a composer under it for
your next message. The app watches the session without joining it, so closing
the window leaves the session running unless you choose to stop it. A session that is running keeps
updating as it works. Approvals and questions show as cards under the
conversation; see Approvals and questions.

The conversation is split into turns, one for each message you sent. The first
message is shown as a box across the column; later ones as a bubble on the
right. Under each message:

- While the turn runs, one status line at the end of the conversation says what
  Vera is doing. It changes its words and never its place:
  - `Thinking`, with the turn's clock before it once the turn is two seconds old
    (`12s · Thinking`), until text or a tool call arrives.
  - `12s · 236 tokens` while a reply is being written. The window counts about
    one token for each four characters it has received, reasoning included
    whether or not the reasoning is shown, because the host sends no count until
    the turn ends.
  - A verb, its target and the seconds the call has run, such as `Running git
    status 4s` or `Reading host.ts 1s`, while a tool runs. The line is a button:
    it opens the calls in progress, and opens again to close them.
  - `Retrying on <model>` with `attempt 2 of 5` and the clock while the host
    retries a failed request.
  - `Waiting on you` while an approval or a question is open.

  Three dots and a light sweep across the verb are the only motion. Reduce motion
  stops both. The line leaves when the turn ends.
- A call shows no row of its own while the turn runs. When the turn writes text
  after its calls, the calls become one past-tense line with a chevron, such as
  `Ran 3 commands, read 2 files` or `Searched 2 times, edited a file`, naming
  each kind of call in the order it first ran. Calls that follow one another
  with no text between them make one line, and the line marks how many failed. It
  opens to one dimmed row per call: a verb and what it acted on, such as `Read
  host.ts`. A row with output opens to it. A shell call opens to a box holding its
  command, coloured, with a copy button, and its output. A run in which every call
  wrote or edited a file draws no line when the turn's changed-files card names
  those files.
- A tool that returns a link to a page, as `artifact_write` and `artifact_edit`
  do, shows a card under its run: the page's icon, the title the tool gave and a
  chevron. The card shows whether or not the run line is open, and clicking it
  opens that page in its pane, or in the right pane when the page has no pane. A
  notice without a link shows its text, with any address to one of Vera's pages
  opening the same way. The terminal shows the notice's text and ignores the link.
- While the turn runs, the plan it wrote shows as a checklist under the newest
  text and leaves when the turn ends. It does not open the Plan view.
- New words in the reply being written fade in. Only the newest block of a live
  reply does; finished replies do not.
- Reasoning is hidden. A thought shows nothing during the turn or after it, and
  the status line says only `Thinking`. See Showing reasoning below.
- Replies render a small part of Markdown: headings, paragraphs, lists, bold,
  italic, inline code, links and fenced code. Fenced code has its language and a
  copy button, which copies the plain code. Once a block's closing fence arrives
  (or the reply ends), the block is colored by its language from the theme's
  syntax colors, in the built-in themes and in imported VS Code themes; a block
  whose language Vera does not know stays plain. Links are shown with their
  address on hover and are not opened, except a link to one of Vera's pages, which
  opens inside the window as described under Browser. Raw HTML is never rendered.
- Notices from Vera, such as errors, show as a strip in the column.
- The end of each turn has a copy button, a `…` button and the time since its
  last step (`just now`, `5m ago`, `1h ago`). Hovering the time shows the exact
  date and time. The `…` menu has `Quote in Reply`, which puts the reply in the
  composer as a Markdown quote with the caret under it, and `Rewind or Fork…`,
  which opens the same sheet as the session menu. A subagent's conversation in
  the Subagents tab has no `…` button.

The page stays at the bottom as new steps arrive unless you have scrolled up.
It opens with the newest page of history; `Show earlier messages` at the top
loads the page before it. The page keeps at most 2,000 steps loaded. Past that,
the button is replaced by a line saying earlier messages are past what the view
keeps loaded.

A reply that is still being written updates about four times a second, and about once a second while the window is hidden, minimized or not focused. It catches up as soon as the window is back.

When the host is not running, the page says so. When the host closes the
session, or the connection drops, the page keeps what it showed and adds a
strip with the reason and `Start session`. The composer is off while the
session is not running. `Start session` attaches again, which resumes the
session on the host without sending a message; the conversation, the composer
and the right pane's views load without another click. A session the host
cannot find gets the reason and no button.

### Showing reasoning

The window hides reasoning by default. Settings > Show > Reasoning turns it on,
and the choice applies at once. A `showReasoning` value of `true` in the flags
file reads as On, and `false`, a missing value or `auto` as Off.

With Reasoning on, each thought shows as `Thought` and its length in seconds,
and opens to show its text. A thought still being written shows three dots and
its latest line. The status line still says only `Thinking`, with the clock.

With Reasoning off, the window asks the host for a character count of the
reasoning instead of its text, and draws nothing of it. The count is added to
the token estimate in the status line, so the number is the same with
Reasoning on or off. The window keeps no text of a thought still being written.
Thoughts the host has finished, and the history it sends when a session opens,
still carry their text; the window holds them and does not draw them.

Changing Reasoning attaches an open session again, so the host sends what the
new choice asks for. The session loads again from its latest page: earlier
pages loaded by scrolling up are unloaded, and a turn in progress is replayed
by the host. A message sent in the moment the session attaches again
is not delivered, as with any attach. A session opened after the change attaches
with the new choice.

## Composer

The composer is a box for your message with a row of chips above it and a bar
below it. The chips show where the session runs: `This Mac`, the folder by its
last path segment, and the folder's git branch when it has one. A chat shows
`Chat` in place of the folder and no branch; on a chat the chip is a menu whose
one item, `Move to folder…`, moves the chat into a folder. Hovering a chip shows
the full value. The branch is read from the folder's `.git` without
running git; a detached checkout shows the short commit id. The bar has a round
`+` button at the left that attaches files and the send button at the right.

In a session:

- Enter sends the message and Shift+Enter adds a line. The box is disabled
  until the session is attached. A session that takes more than half a second
  to open says `Opening the session` in the placeholder and the transcript; a
  quicker one shows neither. The placeholder says `Not connected to this
  session` when the watch has ended.
- While a turn runs, a message you send waits in the queue instead, and the
  placeholder says `Queue a message for when this turn ends`. A strip above the
  composer shows how many messages are queued and the first one, with a button
  that releases the oldest.
- With the box empty: Escape releases the oldest queued message, Enter releases
  all of them, and Up takes the newest one back out of the queue into the box
  to edit. Releasing a message ends the running turn so the message goes next.
- With the box empty and a turn running, the send button becomes a stop button,
  and Enter with nothing queued stops the turn too.
- Escape stops a running turn from the composer or transcript. An open card,
  menu, popover or dialog keeps its own Escape action.
- When the host refuses a message, the box gets its text back if you have not
  typed since, and a line above the box says why.
- When the session's folder no longer exists, the folder chip turns to the
  warning colour, keeps the folder's name and shows `Folder missing` when you
  hover it, and a line above the box reads `The folder <path> no longer exists.`
  with the full path. The window checks when the session opens and each time the
  window is shown or focused again, not on a timer. The warning goes away once
  the folder is back. Chats are not checked, since the host recreates their
  folder. A `Move to folder…` button beside the line moves the session to
  another folder.

`Move to folder…`, from a chat's chip or from the missing-folder line, opens the
system folder picker. Cancelling the picker changes nothing. Once you pick a
folder the host moves the session there. For a chat the host moves the files in
the chat's own folder into the picked folder. The window then opens the same
session again, with its chip showing the new folder and its branch, and the
sidebar row moves from `Chats` to that folder's group on the next listing. The
box keeps what you had typed. If the host refuses, a line above the box says
why: a file in the picked folder has the same name as one of the chat's files
(nothing is moved), Vera is still working in the conversation, the folder can't
be used, the conversation no longer exists, or the move failed. The terminal has
no command for this move.

On New Chat the folder chip is a menu: the folders of your eight most recent
sessions, newest first, then `Open folder…`, which opens the system folder
picker. The menu leaves out chats and folders that no longer exist; the window
asks the shell which of up to 64 candidate folders are still directories each
time New Chat opens. The chip says `No folder` until you pick one, and New chat
here on a folder page or a workspace row starts with that folder picked.
Sending with no folder starts a chat: a session with no outside working
folder, whose files the host keeps in a folder of its own under the home.
Sending with a folder creates a session in that folder. Either way the session
starts with the host's default settings, the approval mode, agent, model and
effort chosen on the bar's pills, opens its page, and sends the message as soon
as the page is attached and, when another agent was picked, the session has
switched to it. The page title is the first line of the message until the session is
named. When the host cannot start the session, a line in the error colour above
the box says so, and the text you typed stays in the box.

Files and images:

- The `+` button opens the system file picker. You can also drop files on the
  composer or transcript, paste files, or paste a line of absolute paths.
  A pasted non-image file needs a path on disk.
- A message can hold up to eight files, each at most 20 MB. A file over a limit
  is refused and the other selected files stay in the composer. Each file has
  a removable chip; removing it does not change the original.
- When you send, a chat copies each non-image file into its own folder. A name
  already in use gets a number before its extension. The copy stays with the
  chat. In a folder session, files and folders remain where they are: paths
  inside the folder are relative and paths outside it are absolute. A chat
  refuses folders. Reading an outside path follows the usual approval rules.
- The message names the attached files and their paths. Vera's read tool reads
  UTF-8 text; binary files, including local PDFs, need another way to inspect
  their contents. An image still goes to the model as an image.
- A pasted image that is not a file yet is written to
  `machine/desktop/pasted-images` under the home, up to 20 MB, and files there
  are deleted after an hour, the next time an image is pasted.
- Each image shows as a chip, `Image 1`, `Image 2` and so on, with an `x` that
  removes it. The host copies each image
  into the session; while it does, the chip says `attaching` and the message
  cannot be sent. An image the host refuses is removed, and a line above the box
  names it and gives the reason.
- A message needs text; images go with it.
- On New Chat the images are attached once the new session is open, and the
  message is sent when they are all attached. If one is refused, the message
  stays in the box.

Slash commands:

- Typing `/` as the first character of the box opens a menu above the composer.
  It lists the commands in three groups, `Built in`, `Extensions` and `Skills`,
  each with its arguments and a line of description. Typing more narrows the
  list to the names that start with what you typed. Up and Down move, Enter runs
  the highlighted command, Tab completes its name and a space so you can type
  arguments, and Escape closes the menu until you type again. A click runs a
  row. The menu closes by itself once a space is typed.
- Enter on a whole line such as `/rename Crow's nest audit` runs that command
  with its arguments. A name that is not exact runs when it is the start of
  exactly one command in the first group that has a match. A name that matches
  nothing keeps your text in the box and says `Unknown command: /name`, with
  `Did you mean` and up to three names that start the same way, or the closest
  spelling. A line that starts with a path, such as `/tmp/roost.txt`, is an
  ordinary message.
- The built-in commands are the terminal's. Those that open something in the
  window run the same command as the palette: `/settings`, `/work`, `/search`,
  `/back`, `/sidebar`, `/palette`, `/themes`, `/diagnostics`, `/extensions`,
  `/doctor`, `/configure`, `/nudges`, `/failure-report`, `/resume` (Go to
  Session), `/clear` and its alias `/new` (New Chat), and `/models` (the Models
  browser). `/rewind` and `/fork` open the Rewind or Fork sheet, `/compact`
  compacts the conversation as `Compact` in the session menu does, and
  `/subagents` shows the Subagents tab.
- `/model`, `/effort` and `/permissions` drive the composer's pills. With no
  argument each opens its pill's menu. `/model scout` runs the one available
  model that `scout` names and otherwise opens the model menu already searching
  for it. `/effort high` sets that level and `/effort default` returns to the
  model's default; an unknown level lists the levels. `/permissions ask` sets the
  approval mode to `ask`, `auto`, `readonly`, `full_access` or a custom mode, and
  an unknown mode lists them. Inside a session it changes the default mode, as in
  the terminal; on New Chat it sets the mode for the session about to start.
  `/agent` opens Choose Agent, and `/agent crow` switches the session to the
  agent `crow`; on New Chat it picks `crow` for the session about to start.
- `/rename`, `/clone`, `/close` and `/parent` are also in the command palette as
  Rename Session, Clone Session, Close Session and Go to Parent Session.
  `/rename Crow's nest audit` renames the open session and shows a notice in the
  window's corner; `/rename` alone opens a sheet with the current name. `/clone`
  starts a new session holding a copy of the whole conversation and opens it.
  `/close` stops the session and keeps its file, then opens New Chat. When
  background commands are running, `/close` and Close Session in the palette
  ask for confirmation, just like Close Session in the sidebar. `/parent`
  opens the session that started this one and says so when there is none. These
  four need a session; on New Chat they say `/name needs an open session`.
- Skills appear as `/<skill-name>`, one row for each skill the session can run.
  Running `/scout-the-field the north corn` invokes the skill with `the north
  corn` as its arguments. If the turn is running the skill waits for it to end
  and a notice says so. When the host refuses the skill, the notice gives its
  reason and your line goes back into the box.
- Extension commands appear as their own names under `Extensions`. They run
  while the session is idle, and the notice shows the command's answer. While a
  turn runs they say `Extension commands are available when the agent is idle`
  and your line goes back into the box. A skill or extension command named like
  a built-in is left out of the menu.
- `/usage` opens the Usage page in the right pane.
- The terminal commands `/animations`, `/import`, `/extension` and
  `/reload-extensions` are listed with a muted `Not implemented yet`. Running one
  shows `/name: Not implemented yet` under the box and sends nothing.
- On New Chat the menu lists built-in commands and the host's available
  extension commands. Running an extension command starts a conversation and
  shows its result there. An unknown command stays on New Chat and can suggest
  built-in and extension commands. Skills are read from a session.
- The menu is drawn above the box, outside the bar, and stays inside the window
  however narrow it is.

## Approvals and questions

When the session asks before running a tool, a card appears under the
conversation. Its title asks what the call does, such as `Write plunder.md
outside this chat's folder?`. When Vera cannot tell what a shell command does,
the title names the program, as in `Run curl?`, or asks `Run this command?`.
While a card is unanswered the status line at the end of the conversation says
`Waiting on you`. The card's choices, numbered from 1 in the order shown:

- `Yes, for this chat` runs this call and allows calls like it for the rest of
  the session.
- `Yes, and always allow <words>` runs it and allows calls like it in every
  session; the words name what it remembers, such as `reading plunder.md` or
  `curl commands`.
- `Yes, and switch to Approve for me` runs it and switches the session to
  Approve for me. It appears in ask only, when Approve for me is available, and
  never on a subagent's call, an ask from `permission_rules` or a card in a Chat
  tab.
- `No` (Escape or the `✕`) refuses it; the turn goes on without it.
- The field below the answers takes a line of text. Enter refuses the call and
  passes what you typed to Vera, so it can try another way.

An answer that is left out leaves no gap in the numbers.

`Show command` opens the folder the call lands in, the command, Vera's reason,
any warning, and what the grant answers remember. It starts open when the title
does not say what the command does. For a tool other than a shell the card
shows its preview, such as a diff, and the same fold is called `Show details`.

The grant answers appear only when Vera can propose one; a subagent's request
offers only `Yes, this time` and `No`, and no field. An ask from
`permission_rules` offers the same two answers and keeps the field, since no
grant can lift it.

A question from Vera shows its choices, numbered, in the same card. A number
key or a click picks one. When the question takes a typed answer, a box under
the choices sends what you write with `Answer` or Enter, and a note box sends a
note with the choice. The `✕` or Escape skips the question.

Up and Down move between a card's choices and its typed answer.

A setup request says what is needed and has `Dismiss` (Escape), which tells
Vera the setup cannot be done from this window. A provider setup request also
offers `Connect provider`: complete the provider and model steps to answer it.
Finish other setup requests from the terminal.

The keys answer the first card without an answer. They work when the composer
is empty or not focused, and not while you type in a field or hold Cmd, Ctrl or
Alt. While a card waits, Escape answers it instead of releasing a queued
message.

An answered approval does not stay in the conversation. An allowed one leaves
nothing, since the call it allowed shows in the turn's work. A denied one leaves
one muted line, such as `Denied: Run rm -rf the-plank`. Answered approvals clear
when your next turn starts. Settings > Appearance > Past approvals, off by
default, keeps the full answered card instead, with the answer in place of the
buttons, for up to ten answers. An answered question or setup card stays until
Vera closes it.

The approval pill at the left of the composer's bar shows the session's mode
and opens a menu:

- The modes: `Ask for approval`, `Approve for me` (a reviewer clears the safe
  calls and asks you about the rest) and `Read only`, then any mode defined in
  the home. `Full access` is listed too once Settings > Approvals offers it, and
  always for a session already in it. Picking one changes this session. A change
  made while a turn runs applies when the turn ends, and the pill says
  `after this turn` until then.
- `Make this the default for new sessions` saves the session's mode as the
  home's default. It is left out for a session in `Full access` while Full
  access is not offered.
- `This session allows` lists what `Yes, for this chat` has allowed, and
  `Every session allows` lists what `Yes, and always allow` has allowed, each
  with an `x` that removes it.

When Vera refuses a change, the pill's menu says so. On New Chat the pill says
`Default approvals` and starts the new session in the home's default mode until
you pick another; the pick applies to that session only.

Settings > Approvals has the `Offer Full access` switch, off at first. Turning
it on asks you to confirm, then lists `Full access` in both approval pills and
lets `/permissions full_access` choose it; while it is off, `/permissions`
says to turn it on first. Turning it off does not ask. The switch is kept in the
window's storage under the home. The page also names the default mode and the
standing permissions and says where to change them: the window reads both only
through a session's pill.

## Chat tabs

A Chat tab shows one session's conversation in the right pane: the transcript,
the approval and question cards and a composer of its own, the same ones the
main area uses, except that its approval cards do not offer `Yes, and switch to
Approve for me`. It needs no session open in the main area and works on New Chat.
Each tab holds one chat. A Help tab is titled with the chat's name, and `Help` until it has one.

Help opens a new Chat tab on a new chat that runs as the help agent. The sidebar's
Help button, the Help tile, the launcher's Help row, `New Help Chat` in the Help
menu and the command palette each open one, and each press opens another tab. If
the right pane is closed it opens. The switch to the help agent is sent as soon
as the chat is attached, and the composer says `Switching agent` and does not
send until the host answers, so a message typed early reaches the help agent and
never the default one. When the host refuses the switch, the tab says `Help did
not start.` with the reason and the chat stays on its first agent. When the host
cannot start the chat, a notice gives the host's reason, or says `Vera could not
start a Help chat.`
Help chats are durable sessions: closing the tab leaves the session in the
sessions list, and it can be opened from there as any other. When the help agent
asks to show a dialog, a Settings section or a page, the window opens it.

`/btw` in a session's composer opens that session's sidekick in a Chat tab, the
same readonly side conversation the terminal's `/btw` opens. The sidekick is
branched from the session by the host with the same options the terminal uses,
and it sees the conversation so far.

- `/btw <question>` opens the sidekick, or shows the tab it already has, and
  sends the question there. Nothing is added to the main conversation.
- `/btw` alone opens or shows the tab and sends nothing.
- `/btw close` closes the tab.
- A second `/btw <question>` on a session that has a sidekick brings it up to
  date with the main conversation first, and sends in the same tab. While the
  main conversation is running, the notice says `BTW context can sync only
  between turns` and the sidekick answers from what it had.
- Each session has its own sidekick, with its own tab.
- `/btw` shows in the slash menu of a session in the main area only while the
  included extension `vera.btw` is on. Listing `vera.btw` in
  `disabled_included_extensions` of `config.json` removes it, and a typed `/btw`
  is then an unknown command. It is not offered in a Chat tab or on New Chat.
- When the sidekick cannot be opened or brought up to date, a notice gives the
  reason and the line returns to the box.

A sidekick lives only as long as its tab. Closing the tab, or hiding the right
pane, ends the sidekick, and the next `/btw` opens a new one; this differs from the
terminal, where `/btw close` leaves the sidekick running and the next `/btw`
reuses it. The terminal also catches the sidekick up on every message to the main
conversation, and the desktop does so only when `/btw` sends a question. A
sidekick tab is titled `BTW`.

Chat tabs are limited to 6. At the limit, Help and `/btw` say `Close a Chat tab
to open another.` and start nothing, and the launcher disables the Chat row. A
Chat tab is not saved in the layout, so none returns after a restart. A tab whose
chat is gone says `This tab holds no chat. Open one from Help or with /btw.`

`/pair` stays in the terminal. The desktop has no peer pane.

The slash menu asks which included extensions are on by reading `config.json`
in a separate process, named Vera Model Assignments, that starts for the
request and stops once it answers. It is read when a `/` is typed in the box of a
session in the main area, and the answer is kept for 30 seconds. Nothing runs at
launch or while the box holds no slash. If `config.json` cannot be read, `/btw` is
treated as off until a later read works.

## Models

The model pill at the right of the composer's bar shows the model the session
runs; on New Chat, the model the new session will start with. The pill, its
menu, the effort popover and the Models browser drop the vendor prefix a
provider puts on a model's name, so OpenRouter's "OpenAI: GPT-5.6 Luna" reads
"GPT-5.6 Luna"; a name you gave the model shows as you wrote it. The tooltip
has the full name and the provider. It opens a menu:

- A search box at the top. Typing filters your favorites and adds the matching
  models that are not among them, each with their provider and a pin button
  that adds it to favorites.
- `Auto` and `Fast` are shown but disabled, since the host does not serve them.
- Your favorites, each with its default effort. The current model has a check;
  the others show the number key that picks them. Keys 1 to 4 pick the first
  four while the search box is empty, and Up, Down and Enter move through the
  rows. A model its provider no longer offers is greyed out.
- When the session runs a model that is not a favorite, it shows first under
  `Running, not in favorites`.
- `All models…` opens the Models browser.

Picking a model in a session switches it and makes it the default for new
sessions. A switch made while a turn runs applies when the turn ends, and the
pill says `after this turn` until then. When Vera refuses the switch, the pill
says so. On New Chat the pick applies to the new session only; if Vera cannot
start the session on it, the message stays in the box with a line saying why.

The effort pill next to it shows the effort level and is hidden when the model
has only one. It opens a small popover with the current level's name at the
top, the model's name under it, and a track with a stop for each level the model
offers, running from least to most effort. The knob sits on the current level
and the track is filled up to it. Click a stop or drag the knob to change the
effort, or use Left and Right, Home and End; the pill follows as it moves.
Escape closes the popover. Hovering the track shows the level's description.
The reset button at the top right goes back to the model's default level; it is
dimmed while the model already runs that level and left out when the model
lists no default.

When the composer is too narrow for every pill, the approval pill shows only its
hand icon, and if that is not enough the effort pill hides, so the model's name
keeps its room. Hover the approval pill to see its mode. Both come back when the
composer widens.

The Models browser has four tabs:

- `Favorites` and `All models` list models with their WA score, blended price
  per million tokens, a `P` for models on the score and price front, an image
  mark, and a pin that adds or removes the model from favorites. Under each
  name is its maker, when the provider names one, and its provider. A search
  box, a `Provider` filter and an `Intelligence` filter narrow the list. The
  `Provider` menu lists each connected provider with how many of the tab's
  models it offers, the provider with the most models first. Models the catalog
  hides appear only in a search. Selecting a row shows its details: provider,
  favorite, verified, images, WA score, listed and blended price, context
  window and model id, with `Run this model`, the favorites button and
  `Probe it`, which sends one short request and says whether the model passed.
- `Defaults` assigns the models background work runs on; the conversation
  model stays as it is. Each row opens a picker with your favorites first,
  then other connected models, and the effort levels of the highlighted model
  on a line under its name (Left and Right change the effort). The picker
  stays inside the sheet and opens above its button when there is more room
  there. Tiers are snappy, eco and extra; under
  each, a line names what uses it, including a job that is not set. The
  classifier has a failsafe row once it is set, and compaction says which
  tier it uses while it is not set. Subagents list their models in the order
  Vera tries them, with buttons to try one earlier or later or remove it, and
  a switch for falling back to the spawning session's model. **Assign one
  model to all** gives every default the same model. A model you assign that
  is not a favorite becomes one. The window writes `config.json` in the home
  with the same rules as Assign model defaults in the terminal, so it works
  the same whichever folder the app was started from. Each read and each
  change runs in a separate process that starts for the request and stops
  once it answers. If `config.json` stops loading, the tab keeps the last
  settings that loaded, says so, and refuses changes until the file is fixed.
- `Help` explains the marks.

Settings > Providers lists the providers the home is connected to, with how
many models each lists and when it was last listed. `Refresh` lists a
provider's models again. `Forget` asks first, then removes the provider's saved
connection and what Vera learned about its models. `Add a provider` connects a
known provider with its key or browser sign-in, or a custom endpoint with a
key. Choose a model to check it and make it the default. The same screen opens
on first run when no provider is connected, and from the Models browser.
Outrider guided setup remains in the terminal. Fallback after failures is not
available from the window.

## Session tools

While a session is open, the title bar holds its tools: a background tasks pill
when work is running, the context pill and the session menu.

The context pill shows how full the context window is, as a percent when the
model's window is known and as a token count otherwise. Before the first
measurement it shows a dash. Under Auto the pill is not drawn until the
session has reported its context use, or while the session is stopped; Context
use On draws it always and Off never. It opens a popover with the total, whether it was
measured or estimated, a bar split into the system prompt parts, tool
definitions, the conversation, anything else the total holds (`Other`) and free
space, a mark where automatic compaction starts, and the token count it starts
at. `List every message` lists each message with its size. `Compact` compacts
the conversation. When the session is not running, the popover says
`This session is not running.` and offers `Start session` in place of
`Compact`. With the pill hidden, `Compact` stays in the session menu and as
`/compact`, and a stopped session keeps the `Start session` strip under its
conversation.

The session menu (the `…` button) has:

- `Copy Conversation`, which copies the loaded conversation as Markdown.
- `Rewind or Fork…`, which lists your prompts, newest first. `Rewind here`
  shows how many messages stay and how many are set aside, and `Rewind` sets
  them aside and puts that prompt back in the composer to edit. A prompt with
  images cannot be rewound. `Fork from here` starts a new session from that
  point, opens it, and puts the prompt in its composer. Rewind waits until the
  turn ends; when the host refuses, the sheet says why and offers `Back`.
- `Compact`, which starts a compaction at once and leaves the window usable.
  While it runs, a status line at the end of the conversation says
  `Compacting the conversation` with the model doing it and the time so far.
  When it ends, a line in the conversation gives the result, such as
  `Compacted the conversation from 46K to 12K tokens.` or
  `Nothing to compact yet.` When both counts round to the same figure, the
  line gives them in full, such as `from 6,540 to 6,492 tokens`. A second
  `Compact` while one runs does nothing.
- `Subagents`, which shows the Subagents tab in the right pane and opens the
  pane if it is closed. The tab is described below.

The background tasks pill shows how many subagents and background agents are
running. It opens the tasks sheet, which lists the subagents with their status.
`Open` on a row shows that subagent in the Subagents tab and closes the sheet,
`Go to` opens its own page, and `Stop` stops a running one. Subagents still
starting, which the host has not listed yet, show by title. The host does not
list background shell processes, and the sheet says so.

A subagent is a session the open session started. Each `subagent` or
`async_subagent` call in the conversation shows as a card of its own in place of
that call's part of the run line: the subagent's icon, its title (the call's
description), a status word and a chevron. While the host has not listed the
subagent, the word is that of the call: `Working`, `Done` or `Failed`. Once it is
listed, the word is the subagent's own: `Working`, `Waiting`, `Idle`, `Done` or
`Ended`. The other calls of the run keep their run line, and while a run is still
being made only its cards show, with the status line naming the current call.
Cards show in the open session's conversation, not in a Chat tab.
A card opens the Subagents tab on that subagent.

The Subagents tab is also opened by the session menu's `Subagents`, by a
delivery's `Open it` when the delivery comes from a subagent of the open session
(a delivery from any other session opens that session's page), and by `Open` in
the tasks sheet. It opens the right pane if that is closed and is always the same
tab: the kind holds one tab, so opening another subagent changes what it shows.
When the pane already holds 16 tabs and none is Subagents, a notice says to close
a tab first and nothing changes. The tab shows the list for the open session, or
`Open a session to see its subagents.` when none is open:

- `Active · N`, with a row for each running subagent (its icon, title, status
  word and time since its last step), or `No active subagents`. A subagent the
  host has not listed yet shows by title as `Working` and cannot be opened.
- `Done · N`, with a row for each of the others, drawn only when there are some.
- `No subagents in this session.` when it has none.

A row opens that subagent in the same tab. The page has a back arrow (`Back to
subagents`) that returns to the list, then the subagent's icon, its title and its
status word, `Go to`, which opens the subagent's own page, and `Stop` while it
runs. Below is its conversation, which updates live, and a message box with
no attach button, slash commands or pickers. Enter sends the text to the
subagent and Shift+Enter starts a new line. While the subagent runs, a message
waits in the queue strip above the box; Enter on an empty box releases every
queued message into the running turn, and Escape releases the oldest. Enter on
an empty box never stops the subagent; `Stop` does. Approvals the subagent asks
for in a turn you started show above the box. A message to a subagent that has
finished runs a turn of its own, and its answer shows here; it is not sent back
to the session that started the subagent. There is no `Start session`.
Opening another session shows that session's list in the tab, and closing the
tab and opening it again shows the list.

When a turn edits files, its end shows a card with the number of files edited
and the lines added and removed. Each file row opens to its patch, cut at 400
lines. `Review` opens the Review view; the button is drawn while Review is shown. Review lists the files changed in the
last turn, or in the whole session, with their patches. Plan shows the newest
checklist Vera wrote in its scratch folder: the title, how many items are done,
a bar and the items, with recently completed items marked while the turn runs.
Open plan file opens its displayed path in the system's default application.
Files shows the
session's folder (`Chat` for a chat) as a tree the window reads from disk:
folders come first, a folder opens one level at a time, and one folder lists
at most 500 entries. It skips `.git` and `.DS_Store`, and open folders are read
again when a turn ends. Picking a file shows it beside the tree, which keeps
the file marked: a bar with its path under the folder, then its text with line
numbers. The window reads at most the first 256 KB and says so when the file is
longer. A folder, a file that is not text and a file that is gone each show one
line saying so. The arrows in the bar step back and forward through the files
opened, up to the last 50, and `Browse files` hides or shows the tree. An open
file is read again when a turn ends. An HTML file offers Source and Preview.
Preview renders it beside the tree, including relative assets in the session's
folder. The pointer selects or draws on the page and adds a screenshot and file
details to the session's composer. Reload reads the file again after a change;
Source returns to its text. See [Browser annotation](browser-annotation.md).
Plan and Review are built from the
session's conversation, so when the session is not running and nothing of it
has loaded, each says `This session is not running. Start it to see its plan.`
or `This session is not running. Start it to see its changes.` with
`Start session`. Files, Output and Browser do not need the session. The
Subagents tab has no `Start session`. While the right
pane is closed, a rail at the right of the session page opens these views.

When the host runs a turn on a different model than the one picked, a line in
the conversation says which model it used, marked `subagent` when a subagent's
model was swapped. Retries and failures show as strips in the column.

## Browser

The Browser opens sites in the right pane, one page to a tab. Each Browser tab has
a top row of Back, Forward, the address bar, Reload and Open in your browser. A
site popup opens in a new Browser tab, and `+` or the Browser tile opens a new,
empty one; the launcher also opens a typed web address in a new Browser tab. The
command palette's `Open a web page` opens the Browser or selects its most recent
tab and focuses its address bar. A tab shows the page's title in the strip, and
closing the tab closes the page. A
Browser tabs hold websites only.

At most 12 Browser tabs are open at once. At that point the Browser tile and the
launcher's Browser row are disabled, and a site that asks for another window is
refused.

Enter a website address in the Browser. Open in your browser opens the current
website in the system browser. Back and
Forward move through the current tab. Browser tabs share cookies, site storage
and cache in memory while the desktop is open. Tabs, sign-ins and site data do
not survive closing the desktop. Site recents and saved captures remain in the
home, and downloaded files remain where you save them. Data left in
`machine/desktop/chromium/browser` by earlier versions is not opened or deleted.

Browser history records web pages shown in the pane, whether opened by you or by
`builtin_browser`. It is searchable and grouped by day. Opening an entry loads it
in the current tab. Clear removes the history and recent site pages
immediately, while keeping Vera page recents. Cmd+Shift+Delete
(Ctrl+Shift+Delete on other platforms) opens Browser history with Clear focused;
press Enter to clear it.

Browser tools are off by default. Turn on Browser tools in the pane to let Vera
read and act in the selected site tab, under the session's approval mode. A page
Vera opens gets its own Browser tab. You can watch and take over in the pane.
A notice stays at the bottom of the window while the tools are on, with Turn off
to switch them off without returning to the pane. See [Browser use](browser-use.md).

A link to one of Vera's pages in a reply or a tool notice opens inside the window.
A page that has its own pane opens there. Other pages open in the right pane when
available, or in the system browser when there is no pane or it cannot take
another page. Links to websites are not opened.

The command palette's Pages group lists Vera's pages. `/usage` opens Usage in
the right pane. Usage and Runs have Reload and Open in your browser.

The pointer button at the right of the address bar opens the included browser
annotation tool for the open session. Select an element or draw on a website,
then choose Add to chat to include a screenshot with your next message. Vera's
pages do not have annotation; Files HTML Preview still supports it. See
[Browser annotation](browser-annotation.md).

## Finding the host

The app never computes a socket path or starts a host directly. It runs the
installed `vera` command with `boot --json`, which performs the same startup
check and repair as the terminal UI, starts a host if none answers, and prints a
`ready` line with the socket path. The app connects to that path.

The command is found in this order:

1. `VERA_DESKTOP_DEV_CLI`, used by `bun run dev:desktop` so a checkout runs its
   own CLI. `VERA_DESKTOP_BUN` names the Bun executable, defaulting to `bun`.
   `VERA_DESKTOP_LAUNCHER` is the matching variable for the app shell: it names
   the `vera` launcher the shell follows instead of `~/.local/bin/vera`, for
   development and tests only.
2. The installed launcher at `~/.local/bin/vera`.
3. Nothing. The banner says `Vera is not installed`, names the path it checked,
   and offers Try again and Run doctor.

The desktop app requires an installed `vera` command and does not install or
update it on launch. Install Vera as described in [Installation and
upgrades](installation.md), then choose Try again if the app reports it missing.
A checkout run uses its own CLI.

`VERA_HOME` is inherited unchanged, so a trial home attaches to that home's
host and writes nothing outside it. The app's own Chromium user data, including
the saved theme, lives under `machine/desktop` in that same home, beside the saved
layout.

## The app shell and the desktop package

`Vera.app` is a small shell that rarely changes. It finds the installed `vera`
command, follows it to the release the install's `current` link names, and opens
the desktop package installed for that host build, the newest one when several
are installed. The package holds the window, its preload and the task workers
and sits under `~/.local/share/vera/desktop/<host build id>/<desktop version>/`.
While the app runs it records that it uses the package, so a cleanup does not
remove it.

A package names the shell API it needs in `desktop-package.json` as
`shell_api`, and a package without one needs API 1. This shell offers API 1 and
refuses a package that needs a higher one.

When there is no usable package for the current host build, the shell opens one
plain window instead of the app, and the window says one of these:

- `Vera is not installed. Run the Vera installer, then open the desktop app again.`
  when no `vera` command or no current release is found.
- `The Vera desktop app for build <id> is not installed. Run the Vera installer again to add it.`
  when no package matches the current host build.
- `The Vera desktop app for build <id> needs a newer app shell. Run the Vera installer again to update it.`
  when the newest package needs a higher shell API.
- `The Vera desktop app for build <id> could not start (<reason>). Run the Vera installer again.`
  when the package was found but failed to load.

A release carries `vera-desktop-darwin-<arch>.tar.gz` for the package and
`vera-desktop-shell-darwin-<arch>.tar.gz` for the shell, each with a `.sha256`
file. From a checkout, `bun run desktop:release --release <host tarball>` builds
both for the machine's architecture into `dist/desktop-release`, and `--out`
picks another folder. The shell is signed ad hoc and is not notarized.

## Boot questions

When the startup check asks a question, such as whether to restart a busy host,
the banner shows the question text with Yes and No. The app sends only the
answer the person picks, never an automatic yes. A closed stdin counts as yes to
the check, so closing the window, cancelling, or timing out writes no to the
child before closing its stdin.

## Themes

The interface uses semantic tokens for color, type, spacing, shadow, and motion.
The built-in themes are Dark, Light, High contrast, Vera Blue, Vera Purple,
Muted Blue, Onyx, Palenight, Synthwave, Night Owl, GitHub, Midnight Blue,
Midnight Blue II, NC, NC Navy, retro31 and Vera Orange.
They are available without installing anything from the catalog.
Dark remains the default.

View > Theme, View > Choose Theme… and Settings > Appearance list built-in
themes before the themes of enabled desktop extensions. The command palette
finds both as `Theme: <label>` when searched.
Tour's Theme menu offers the same choices.
Choose Theme and Appearance show each theme's colors as swatches.
Switching applies at once and remembers the choice for the next launch.
A saved built-in name that no longer exists falls back to Dark.
The saved theme is applied before the stylesheet loads, so the first paint
already uses it.

Built-in theme data files live in `clients/ui/src/theme/themes/`, and
`clients/ui/src/theme/registry.ts` lists their names, labels, descriptions and
color schemes.
The root element's `data-theme` is the built-in name or `imported:<name>` for
an extension theme.
Each theme has a command `theme.<name>`, except High contrast, whose command
remains `theme.highContrast`.
Each extension theme has a command `theme.imported.<name>`.

### Importing a VS Code theme

The desktop app imports a VS Code color theme from:

- a `.json` or `.jsonc` theme file;
- a `.vsix` extension package; each theme the package lists becomes its own
  choice;
- the extensions installed in VS Code on this machine, listed from
  `~/.vscode/extensions` and, on macOS, from the VS Code app's built-in
  extensions. Settings > Appearance > Installed in VS Code > Show themes, and
  the command palette's `Theme: Import Theme Installed in VS Code…`, open a
  list of them with a filter field. Enter or a click imports the chosen theme,
  and Escape closes the list. The list shows each theme's name and the
  extension it comes from, not file paths. A list cut at 300 themes, or after 500 extension folders, says
  `More items are available than this list shows.`

The importer is an included desktop extension, `vera.vscode-theme-import`. Its
source and manifest are in `extensions/vscode-theme-import/` in the repository,
and the desktop build copies the manifest and bundles its task into the app. It
is always on, and Customize does not list it. The app has no code of its own for
it: the commands, the rows in Settings and the View > Theme item come from the
manifest (see Commands and menus below). Start an
import from Settings > Appearance > Import a VS Code theme > Import…, from
View > Theme > Import VS Code Theme…, or from the command palette's
`Theme: Import VS Code Theme…`. Each opens a file picker for `.json`, `.jsonc`
and `.vsix` files. After a
successful import the window switches to the theme at once, the theme sits in
the lists after the built-in themes, and Settings shows
`Imported "<name>" and switched to it.` Each imported theme is installed as its
own desktop extension named `imported.<name>`, so it appears under Desktop
extensions and can be turned off or removed there. Importing the same name
again replaces that extension. Each import, and each listing of the installed themes, runs in
a separate process, named Vera Theme Import, that starts for the request and stops
once it answers; no such process runs at launch or between requests. Choosing a
theme from the installed list is a second request: the app keeps the file paths
of the list, the window sends back a key, and a new process imports that file. A request
that takes longer than 60 seconds is stopped and refused. The process only reads
the file, package or VS Code extension folder and answers with the converted
themes. The app, not the process, installs each theme as its extension, and an
import holds at most 200 themes and 16 MiB of themes. The web client has no
import; it shows none of these controls.

What carries over, with the first VS Code color in each row that the theme sets:

| Vera token | VS Code colors |
|---|---|
| `surface` | `editor.background` |
| `surface-sidebar` | `sideBar.background` |
| `surface-panel` | `panel.background`, `sideBar.background` |
| `surface-raised` | `editorWidget.background` |
| `surface-menu` | `menu.background`, `quickInput.background` |
| `surface-input` | `input.background` |
| `surface-hover` | `list.hoverBackground` |
| `surface-selected` | `list.activeSelectionBackground` |
| `surface-code` | `textCodeBlock.background`, `editor.background` |
| `titlebar` | `titleBar.activeBackground` |
| `tab-active`, `tab-inactive` | `tab.activeBackground`, `tab.inactiveBackground` |
| `border` | `panel.border`, `sideBar.border`, `contrastBorder` |
| `border-input` | `input.border` |
| `focus` | `focusBorder` |
| `text` | `foreground`, `editor.foreground` |
| `text-muted` | `descriptionForeground` |
| `text-disabled` | `disabledForeground` |
| `link` | `textLink.foreground` |
| `accent`, `accent-text` | `button.background`, `button.foreground` |
| `badge`, `badge-text` | `badge.background`, `badge.foreground` |
| `danger` | `errorForeground`, `editorError.foreground` |
| `warning` | `editorWarning.foreground` |
| `success` | `terminal.ansiGreen` |
| `diff-added`, `diff-removed` | `diffEditor.insertedTextBackground`, `diffEditor.removedTextBackground` |
| `selection` | `editor.selectionBackground` |
| `scrollbar` | `scrollbarSlider.background` |
| the shadow's color | `widget.shadow` |

Colors may be `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. The two diff colors
lose their transparency, because Vera draws them as text and as a light tint.
A theme's `include` files are followed, up to eight deep, and merged as VS Code
merges them: the including file's colors replace the included file's, and
`tokenColors` and `semanticTokenColors` are carried along. The grays a theme
does not set (borders, raised, hover, menu, input and selected surfaces, the
sidebar, title bar and tabs, muted, dim and disabled text, the scrollbar and
slider rails) are worked out from the theme's own `editor.background` and text:
each sits the same fraction of the way from the surface to the text as it does
in Vera's built-in theme for the theme's type, so a border stays as visible on
the theme's background as it is on Dark's. Muted and dim text are moved toward
the text color until they reach a contrast of 4.5 against the surface, or the
text color itself. The other tokens a theme does not set, and all of them when
the theme sets no `editor.background` or no text color, take the value of
Vera's built-in theme for the theme's type. The type is the theme's `type`,
else the `uiTheme` its extension declares, else light or dark by the lightness
of `editor.background`. A high contrast dark theme takes High contrast as its
base and a high contrast light theme takes Light. Fonts, sizes, corner radius,
spacing, row height and motion stay Vera's.

The saved file keeps the theme's `tokenColors` and `semanticTokenColors`. The
`tokenColors` rules set the theme's syntax colors, which color fenced code in
the conversation; `semanticTokenColors` are not used.

An import is refused, with the reason in Settings or a toast and the current
theme unchanged, when the file is not valid JSON, is not a `.json`, `.jsonc` or
`.vsix` file, is larger than 2 MiB, is a `.vsix` that holds no
`extension/package.json` or no color theme, is a ZIP64 archive, has an `include`
that loops, climbs out of the archive or nests too deep, or sets none of the
colors in the table above. A `.vsix` or an extension with several themes
imports the ones it can and lists the others as not imported with the reason;
it is refused only when none can be imported. Theme files in the `.tmTheme`
format are not read. An import counts as one desktop extension, so it is
refused once Vera holds 200 of them.

An imported theme is saved as a theme file in the extension's `themes` folder
under `machine/desktop/extensions/imported.<name>` in the home. The file holds
the mapped tokens, the theme's name and source, and the two token tables. A
theme saved by an earlier version in `machine/desktop/themes` moves into its own
extension the first time the app starts, and the old file is removed once the
new one is verified. If the move fails, the old file stays and the theme keeps
working. The choice of theme stays in the window's local storage with the other
appearance settings, and keeps pointing at the same theme after the move.

A window that has a theme selected falls back to the built-in theme of the same
type, Dark or Light, when that theme goes away: its extension is turned off or
removed, or its folder is deleted.

Each time a theme is applied, the page reports its name and its resolved surface
color to the app. The app checks the theme in the View menu and sets the color as
the native window background. The window stays hidden
until the first paint, and the background matches the page while the window is
resized.

The token names are declared in `clients/ui/src/theme/tokens.ts`. Components and
stylesheets outside the theme directory may not carry a literal color, pixel
size, font, shadow, or transition duration; a test scans them and fails on any
of those, and on a `var(--vera-*)` name that is not declared.

## Desktop extensions

A desktop extension adds to the desktop app itself. Today an extension can add
themes, and an extension that ships with the app can add tasks, page scripts,
file preview types, the commands that run them, and entries for those commands in Settings, the
View menu and the Browser toolbar. It is a folder
with a `vera.desktop.json` manifest. The terminal UI
does not use desktop extensions and keeps its own themes.

Customize > Yours lists them above its skills, agents and other items. A row shows the
extension's id and version, the themes it adds, a switch, and Remove. Turning an
extension off hides its themes at once; a window using one of them falls back to
the built-in theme of the same type. Turning it on shows them again. Remove
deletes an installed extension's folder. An extension included with the app is
always on, cannot be removed, and is not listed. An installed extension whose
manifest names commands or a `main` module is listed with the note that its
commands are not loaded by this version of Vera; only the tasks and page scripts
of an included extension run.

Install from file opens a file picker for a package. The window first shows what
the package holds: its id, its version, its themes, and `Replaces version <v>.`
when an installed extension has the same id. Install puts the extension in
place; Cancel throws the package away and installs nothing. Installing a
package with the id of an installed extension replaces it. The web client has no
install; it shows none of these controls.

Extensions are kept in `machine/desktop/extensions/<id>` under the home, and
which of them are off in `machine/desktop/extensions.json`. Included extensions
ship in the app and are not copied there; an included id in that file is ignored.

### The manifest

```json
{
    "id": "crow.themes",
    "version": "1.0.0",
    "engine": "vera-gui@^1",
    "contributes": {
        "themes": [
            { "label": "Midnight Crow", "path": "themes/midnight-crow.json" }
        ]
    }
}
```

`id` uses lowercase letters, digits, `-` and `.`, at most 80 characters.
`engine` is `vera-gui@^1`. Each theme has a `label` of 1 to 120 characters and a
`path` inside the extension to a theme file, at most 2 MiB, in the format Vera
saves when it imports a VS Code theme. An extension holds at most 32 themes. An
extension that adds only themes needs no `main`. An included extension can list
up to eight lowercase file extensions without dots under `contributes.filePreviews`;
Files offers Preview for those types. Installed extensions do not enable file
previews. Unknown keys are refused.

### Tasks

A task is a file of code that the app runs in its own process when something
asks for it. An extension lists its tasks under `contributes.tasks`:

```json
{
    "contributes": {
        "tasks": [
            { "id": "import", "title": "Vera Theme Import", "main": "theme-import.cjs" }
        ],
        "commands": [
            { "command": "vera.vscode-theme-import.import", "title": "Import VS Code Theme…", "task": "import" }
        ]
    }
}
```

A task `id` uses lowercase letters, digits and `-`, at most 40 characters, and
is unique in the extension. `title` is 1 to 100 characters and is the name of
the process. `main` is a bundled file inside the extension. An extension holds
at most 8 tasks. A command may name one of its tasks in `task`; a manifest whose
command names a task it does not declare is refused. An extension whose commands
all name tasks needs no `main`.

The app runs a task only for an extension included with the app, one task at
a time, and stops it after 60 seconds. The process starts when a request
arrives, answers once, and stops; it keeps nothing between runs. An extension
installed from a package keeps its tasks listed but does not run them.

### Commands and menus

A command that names a task is run by the app when the person chooses it. While
its extension is on, the command is in the command palette as
`<category>: <title>`, or the title alone when it has no category. Turning the
extension off removes it. A command may also carry a file filter, and an
extension may list commands under three menu places:

```json
{
    "contributes": {
        "commands": [
            {
                "command": "vera.vscode-theme-import.import",
                "title": "Import VS Code Theme…",
                "category": "Theme",
                "task": "import",
                "file": { "label": "VS Code themes", "extensions": ["json", "jsonc", "vsix"] }
            }
        ],
        "menus": {
            "appearance": [
                {
                    "command": "vera.vscode-theme-import.import",
                    "title": "Import a VS Code theme",
                    "description": "Choose a theme .json file or a .vsix extension package.",
                    "button": "Import…"
                }
            ],
            "theme": [
                { "command": "vera.vscode-theme-import.import" }
            ]
        }
    }
}
```

A command id starts with the extension's id and a `.`, has no whitespace, and is
unique in the extension. A `category` is 1 to 40 characters. `file` has a
`label` of 1 to 60 characters and 1 to 8 `extensions`, each 1 to 16 letters or
digits without the dot. The app shows an open-file dialog with that filter
before it runs the task and passes the chosen path to it; cancelling the dialog
runs nothing and reports nothing.

`menus` is an object keyed by place. `appearance` adds a row to Settings >
Appearance, `theme` adds an item to the View menu's Theme submenu, and `browser`
adds a button to the Browser toolbar. A `browser` entry must set `icon` to
`pointer`; other places cannot set `icon`. Any other place is refused. A place holds at most 8 entries. Each entry names a command
declared in the same manifest, and may set `title` (1 to 100 characters, in place
of the command's title), `description` (1 to 300 characters) and `button` (1 to
30 characters; an Appearance row's button says `Run` when it has none). Only the
entries of enabled extensions show.

A task answers a command in one of three ways: themes the app installs as
`imported.<name>` extensions, a list the window shows for the person to choose
from, or a refusal with a reason. Choosing a list item runs the same command
again with that item. The app keeps the list's values and sends the window only
each item's name and detail.

A command may name a `page` script instead of a task. Its path is relative to
the extension, at most 256 characters, and cannot be combined with `task` or
`file`. Page-only commands need no `main`. Only included extensions run page
scripts, capped at 256 KiB. The script runs in an isolated world of the shown
Browser page, without access to Node, the window bridge or files. It answers
once with a capture rectangle, message text and optional selection details,
or nothing when closed. The app captures the page and attaches the image
through the same path as a pasted image.

### Packages

A package is a gzip tar file with the extension's files at the archive root, so
`vera.desktop.json` is at the top. Build one from the extension's folder with:

```
COPYFILE_DISABLE=1 tar --format ustar -czf crow-themes.tgz -C crow-themes .
```

A package holds at most 256 entries, 4 MiB per file and 16 MiB in all, and the
file itself is at most 8 MiB. Links, absolute paths, paths with `..`, and
anything that is not a plain file or folder make Vera refuse the package. Vera
holds at most 200 desktop extensions.

Reading a package runs in a separate process, named Vera Extension Install, that
starts when you choose a package and stops once it has answered. It unpacks into
a staging folder, checks the manifest and every theme file, and answers with the
preview. Nothing is installed until you choose Install. A package that is
refused shows the reason in the window and leaves what was installed as it was.
Staging folders left by a closed window are cleared the next time the app starts.

### The theme catalog

Customize > Discover lists the themes in a catalog. A card shows the theme's
name, its version, five swatches of its colors and Install. A theme the catalog
has withdrawn, or one built for another version of Vera, is not listed. A theme
already installed at the listed version shows Installed instead of Install.

Install downloads the package, checks it, and applies the theme in the window
before anything is kept. A bar offers Install and Cancel and reads
`Previewing <name> <version>.`, followed by `Replaces version <v>.` when an
installed extension has the same id. Install keeps the extension and switches to
its theme. Cancel or Escape puts back the theme the window had and throws the
download away. Leaving Discover does the same.

The catalog is read when Discover opens, never at launch, and is not saved on
disk; closing Discover drops it. Reading it and downloading a package run in a
separate process, named Vera Extension Catalog, that starts for the request and
stops once it has answered. Unpacking and installing the package are the steps
of Install from file, in Vera Extension Install, and the extension is written
the same way.

The catalog is at most 1 MiB and lists at most 500 extensions; an entry that is
malformed is left out. Only `http` and `https` addresses are fetched, and the
same holds for every redirect. A package must be exactly the size the catalog
lists, within the package limit above, and its sha256 must match the catalog's
before anything is unpacked.

The catalog's address is written into the app when it is built. The app reads
no environment variable or setting for it. A build with no address shows `The
catalog is not available in this build.` in Discover. When the catalog or a
package cannot be fetched or fails a check, Discover shows the reason and the
installed extensions and the window's theme stay as they were; Retry reads the
catalog again.

The catalog a release build reads is
`https://raw.githubusercontent.com/nashaad/vera/main/catalog/published/catalog.json`.
Its source is the `catalog/` folder of the Vera repository, and the files in
`catalog/published/` are committed, so the catalog changes when `main` does.

### Adding a theme to the catalog

Each theme is a folder in `catalog/extensions/` named by its id, with the
files a package holds: a `vera.desktop.json` manifest and the theme files it
lists under `contributes.themes`, written as `themes/<file>.json`. The
manifest `id` is the folder name and its `version` is `major.minor.patch`. A
catalog extension adds themes only: it has no `main`, commands, keybindings or
tasks. Each theme file is a saved theme (`version` 1) with all its color tokens
as lowercase `#rrggbb` or `#rrggbbaa`, and the file must read back unchanged
through the app's own theme reader, so a missing color or a key the app does not
read is an error. A file the manifest does not list is an error too.

The card's name is the label of the first theme, and its five swatches are that
theme's surface, text, accent, success and danger colors, which must be
`#rrggbb`.

```
bun run catalog:build
```

reads every folder in `catalog/extensions/` with the app's manifest and theme
readers and writes `catalog/published/`: `catalog.json` and one package per
extension, named `<id>-<version>.tar.gz`. It then reads the result back with the
app's own catalog parser and package reader, and writes nothing if any
extension fails or the parser would leave one out. The output is the same bytes
for the same sources on every machine, and `catalog/published/` is committed with
the change to the sources. A test rebuilds the catalog and fails when the
committed files differ, with a message to run the command. To raise a theme's
version, change the manifest's `version` and rebuild; the old package is removed.

`bun run catalog:build --out <folder> --base-url <url>` writes a catalog whose
packages are listed under another address, for a catalog served from a local
server; `--base-url` needs `--out`.

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
node clients/desktop/test/shortcuts.e2e.mjs
node clients/desktop/test/compose.e2e.mjs
node clients/desktop/test/chat.e2e.mjs
node clients/desktop/test/move.e2e.mjs
node clients/desktop/test/approve.e2e.mjs
node clients/desktop/test/transcript.e2e.mjs
node clients/desktop/test/models.e2e.mjs
node clients/desktop/test/defaults.e2e.mjs
node clients/desktop/test/slash.e2e.mjs
node clients/desktop/test/chattab.e2e.mjs
node clients/desktop/test/help.e2e.mjs
node clients/desktop/test/btw.e2e.mjs
node clients/desktop/test/rename.e2e.mjs
node clients/desktop/test/archive.e2e.mjs
node clients/desktop/test/tools.e2e.mjs
node clients/desktop/test/browser.e2e.mjs
node clients/desktop/test/artifact-pane.e2e.mjs
node clients/desktop/test/pages.e2e.mjs
node clients/desktop/test/themes.e2e.mjs
```

`bun run test:desktop` builds the app once and runs every
`clients/desktop/test/*.e2e.mjs` in turn. It prints one line per script with
PASS or FAIL and the seconds it took, then a summary, and exits non-zero if any
script failed. Each failure prints the path of a log with the script's output
and its first error line. A name argument filters the scripts, for example
`bun run test:desktop approve`. Each script has a 300 second limit. Trial
homes are created under a scratch folder that the runner sets as `TMPDIR`, and
the runner stops any host a script left behind.

`bun run typecheck` also checks the shared UI and `test/desktop`;
`typecheck:desktop` checks the Electron layer.

`bun run desktop:tour` builds the app and walks it in a visible window against a
throwaway home and a scripted provider. It saves one screenshot per step and a
`sheet.png` of all of them in a new folder under the system temp directory, and
it stops the host it started. `--pace <ms>` sets the pause between actions
(default 700), `--keep-open` leaves the window open until it is closed,
`--out <dir>` picks the output folder, and `--real` uses the factory model config
instead of the scripted provider, which needs `OPENROUTER_API_KEY`.

`bun run desktop:bench` builds the app, seeds one session against a throwaway
home and a scripted provider, and streams a long reply into it twice, once in
the foreground and once with the window hidden, then scrolls to the
top. The window opens behind other windows and takes no clicks or keys, so the
desk stays usable while it runs. It prints the renderer's commits,
layouts, scripting time and CPU for each phase, and each process's memory at the
top and the bottom, and writes `results.json` to a new folder under the system
temp directory. `--seeds <n>` sets the number of turns before the stream
(default 30), `--label <name>` names the run, and `--out <dir>` picks the output
folder. It stops the host it started.

Each test's window is transparent, has no Dock icon and takes no clicks or
keys, so the tests can run while the desk is in use.

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

The pane test checks the right pane's tabs. It starts with the tiles, one for
each kind, opens a tab from a tile and a second tab of the same kind from the
launcher, filters the launcher, closes tabs from their close buttons and checks
the tiles return with the last one. It opens a web address from the launcher as
a Browser tab titled with the page, opens an empty Browser tab from the tile and
checks one of Vera's pages reuses it, checks that closing a tab closes its page,
and fills the Browser limit to check the launcher disables Browser and not the
other kinds. It drags a tab to the panel and checks its kind's tabs close, moves
the container back from its menu and checks it opens one tab, then checks the saved layout holds
the tabs in order without the Browser tab and that a relaunch brings them back.
It stops the host it started.

The chat tab test presses Help on New Chat and checks that the right pane opens on a
Chat tab titled Help holding an attached help chat, that the main area stays on New Chat,
and that closing the tab brings the tiles back. It starts more chats from the tile,
the launcher and the command palette, fills the Chat limit and checks Help says so
without starting a session, and checks the layout on disk holds no Chat tab and
a relaunch brings none back. The help test answers a question typed at once on the
Chat tab with a request to open the themes sheet, checks the question reached the
help agent with the help tools only, and checks another chat is never offered
them. The btw test runs a session against a local provider and checks that
`/btw` is in the slash menu, that a question opens a BTW tab and the provider
receives it with the boundary and the conversation while the main transcript does
not, that a second question reuses the tab, that `/btw close` and plain `/btw`
work, that the readonly mode shows on the sidekick, that no task process runs at
launch, that each request of the extension-state read starts one and none is left,
and that with `vera.btw` turned off in `config.json` the menu has no `/btw`.

The themes test launches the app on a throwaway home with a fake VS Code
extensions folder and a stubbed file picker. It imports a theme file from Settings >
Appearance, checks the switch, a mapped color on the page, the saved file and
the View menu, then refuses an unparsable file and one with none of the mapped
colors, closes the picker with no change, imports the same theme again and
checks it replaced the first, imports a theme from the command palette, opens the
installed list, filters it and chooses a theme from it (checking the list holds no
file path), closes the list with Escape, counts the Vera Theme Import processes
at each step, relaunches to check the imported theme is remembered, and
removes the saved file to check the window falls back to Dark.

The compose test runs a local provider that streams fixed replies and points a
throwaway home's only model at it. It starts a session from New Chat in a folder
picked through a stubbed folder picker, checks the message and the streamed
reply, queues a message during a running turn, takes it back with Up, queues it
again and releases it with Enter, stops a turn from the stop button, and sends a
message with an attached PNG, checking the provider received the image. It
stops the host it started.

The chat test runs the same kind of local provider. It starts one session in
each of two folders and removes one of the folders from disk. It opens the
session of the removed folder and checks that the chip is marked missing, keeps
the folder's name and reads `Folder missing`, and that the line above the box
gives the full path. It opens the other session, removes its folder, focuses the
window and checks the warning appears, then restores the folder and checks it
goes. On New Chat it checks the chip says `No folder` and the menu offers the
folder that exists but not the removed one. It sends a message with no folder,
checks the reply, the `Chat` chip, the session under one `Chats` group in the
sidebar and the chat's own folder under the home's `runtime/sessions`. It then
picks a folder, removes it and sends, and checks that the error line shows and
the typed text stays. It stops the host it started.

The move test runs a local provider that writes a file into a chat's folder. It
answers the native folder picker with folders the test sets. It cancels the
picker and checks nothing changes, picks a folder that holds a file of the same
name and checks the refusal line shows and the file stays, then picks an empty
folder and checks the file arrives there, the chip shows the folder, the row
leaves `Chats` for the folder's group, the one pane is attached again and the
text typed in the box stays. It sends another message to the moved session, removes its folder, and checks the
missing-folder line's button moves the session to a third folder. It stops the
host it started.

The approve test runs a local provider that asks to run one shell command per
prompt in a session started in ask mode. It allows the first request with the 1
key from an empty composer and checks the key did not reach the composer, denies
the second from the card and checks the command did not run, and changes the
session's mode from the approval-mode pill.

The models test serves two local models with the second not a favorite. From
New Chat it searches for a model, adds it to favorites, picks it and sends; in
the session it searches for the other model and sends on it, picks the first
favorite with its number key, lowers its effort, then selects a model in the
Models browser and probes it.

The defaults test launches the app from a folder outside the checkout and opens
Models > Defaults. It checks Escape closes a picker and leaves the browser open,
assigns eco a model that is not a favorite at Low and checks it becomes one,
clears compaction and checks it falls back to eco, adds a subagent model, turns
on the switch, and reads each change back from the home's `config.json`.

The slash test serves one skill and starts a session. On New Chat it types `/`
and checks the menu lists built-in and extension commands with a muted `Not implemented
yet` beside `/import`, runs `/imp`, which names `/import`, and checks the notice and that nothing
reached the provider, and enters a misspelt name and checks the text stays with
a `Did you mean` line. In the session it checks the three groups, that the menu
sits above the box and outside the bar, that it narrows as it is typed and stays
inside a 720 pixel wide window without changing how the pills fit, and that
Escape, the arrow keys and Tab work. It runs `/subagents` and checks the
Subagents tab opens on `No subagents in this session.`, then `/import`, an
extension command and the skill, and checks the provider received the skill's
line. It renames, clones and closes the session from the box, and checks that
`/parent` says there is no parent.

The subagents test runs a local provider whose first reply to the session is an
`async_subagent` call described as `Count the doubloons in the hold`, whose
reply to the subagent is plain text, and whose other replies are plain text. It
checks the call shows as one card titled by the description and that the right pane
has no Subagents tab until something opens it. It clicks the card and checks the
Subagents tab opens on that subagent with its reply and a message box without an
attach button. It sends `Recount the starboard chest` from the box, checks the
subagent's answer shows in the tab, the box is empty again, the subagent was
asked once and the session was not asked again, then clicks the back arrow and checks the list shows `No active subagents` and the
subagent under `Done · 1`. It opens the subagent from its row, closes the tab,
opens the list again from the session menu's `Subagents`, and checks that the card
opens the same single tab on the subagent.

The rename test starts a session against a local provider, checks its row and
the title bar show the title and not the generated name, then renames it with
`/rename` and from the row menu's sheet, which starts from the shown title. It
checks the row and the title bar show each new name within one three-second poll,
with no turn in between.

The archive test archives a session from its row menu, opens Archived, and
unarchives it back into its group. It checks a pin is restored, an archived
session still opens from Go to Session, and archiving during a streamed turn
leaves the conversation shown and lets the turn finish. It stops its trial host.

The tools test runs a local provider that writes a scratch checklist, writes a
file and edits it. It checks the turn's edits roll up into one card, opens the
change from Review, reads the checklist's progress in the Plan view, waits for
the context pill to fill in, quotes a reply into the composer from its `…`
menu, rewinds the newest prompt back into the composer and compacts from the
session menu without a sheet, waiting for the result line. From a sidebar row's
`…` menu it renames the session while another page is open, pins it and reads
`pins.json`, opens the Files view, opens two files beside the tree, steps back
and forward between them, hides and shows the tree, unpins it from the
right-click menu, clones it and closes the copy.

The Browser tests check that websites open in Browser and that Usage, Runs
and Artifacts open in app page panes. They exercise typed app-page addresses,
annotation controls and blocked annex requests from Browser.

The artifact pane test opens the Artifacts page from its sidebar entry and checks
it loads in the main area without a query, then checks its tile and launcher
row in the right pane. With a Browser tab shown, it has a session write an
artifact and checks the Artifacts tab appears behind the Browser tab with a dot,
the keyboard stays where it was, and viewing the tab clears the dot and shows the
artifact. It checks the card under the collapsed tool run, that a second artifact
adds no tab and marks the first again, that the card opens a second artifact in a
new Artifacts tab and a link in the reply shows the tab already on its address,
that a new artifact with the pane hidden puts the dot on the pane's button and
opens nothing, and that the sidebar page lists the three artifacts in one group.
It stops the host it started.

The pages test finds a session by a word said in it from Search, watches a slow
turn finish in Work while another page is open, opens a folder's Workspace page
from the sidebar and checks its session count, checks Devices, reads Vera's help
skill on Customize and opens its detail, checks that Discover says the catalog
is not available in this build, goes from Tour to Coverage and back and opens the session
from its Tour card, runs Settings from the command palette, counts the session
in Settings > Data, finds the palette's keys in Settings > Keyboard and the
shortcuts sheet, and opens a session from Go to Session.

`bun test test/desktop` also covers turning history and live updates into the
transcript, paging and its cap, and the session pipe in the app.

The desktop and the shared UI are not part of the packed release; `pack:release`
copies neither directory.
