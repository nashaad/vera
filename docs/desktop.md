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
  startup check has a question. A lost connection offers Reconnect. A host that
  did not start and a missing install offer Try again and Run doctor, which opens
  the health check described under Sheets. The banner shows the reason; long
  reasons scroll inside it.

While attached, the app asks the host for its identity and session count every
three seconds. A reply that does not arrive, or a host that closes the
connection, ends the attachment and shows the banner.

## Pages

The main area shows one page at a time. Its title is in the main header. The
pages are New Chat, Search, Work, Customize, Settings, Devices, Tour, Coverage, a
workspace and a session.

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
- A session page opens when you pick a row in the Sessions view, on Work, on
  Search or on a workspace or device page. Its title is the session name. It is
  described under Session view.
- Customize shows what Vera loads for a session in one folder: skills, agents,
  extensions, instruction files and memory files. A menu picks the folder; it
  starts on the folder of the session last open, and lists no chats. The page reads through one
  top-level session in that folder, preferring a running one, and names it under
  the toolbar. Reading through a session that has stopped starts it again. With
  no session in the folder the page says so and offers New chat here. Pills
  filter by kind with a count on each, a search box matches names and
  descriptions, and Reload reads again. Items are grouped as This folder, Your
  home, Extensions, Included with Vera, Built in and Other. A card shows the name, the description, the kind
  and badges such as Current for the session's agent, Manual only for a skill
  Vera does not load on its own, and an extension's state. An extension the host
  could not load shows its error. Picking a card opens a sheet with its facts
  and the file's text, and Show in Finder (Open folder on other platforms) when
  the item has a file. Customize does not add, remove, install or edit anything.
  Yours and Discover switch the page's view; it opens on Yours, which is
  everything above. Discover says that Vera has no catalog of extensions or
  skills to install, names `/extension install <path>` in the terminal, and
  offers Open Yours.
- Tour lists every screen, sheet and session state in the window as cards, one
  click from each. Session cards open the newest session that is working,
  waiting on you, finished or idle, and say None right now when there is none.
  Page cards open a page and sheet cards open a sheet. A Theme menu at the
  bottom switches the theme. Nothing on the Tour is staged; every card opens
  the real screen on the host the window is attached to.
- Coverage lists the steps of a session and, for each behavior in it, whether
  the window does it, does part of it, leaves it to the terminal, or cannot do
  it because the host does not serve it, with a note naming where to do it
  instead. A bar and a percentage sum it up, and pills filter by status.
  Tour and Coverage each have a button beside the title that opens the other.
- Settings has a list of sections on the left with a search box that filters
  them by name and keywords, and the chosen section on the right. It opens on
  Appearance. The sections sit under two headings: Settings, and Desktop for
  what the window keeps itself.
  - Appearance picks the theme and sets text size, code size and density (each
    Small or Compact, Default, Large or Comfortable), and has two switches. Reduce
    motion stops the status line's dots and sweep and the fade on new words. Past
    approvals, off by default, keeps each answered approval card in the
    conversation instead of dropping it; see Approvals and questions. These five
    are kept in the desktop's browser storage under the home's
    `machine/desktop/chromium`, not in `config.json`, so other clients do not use
    them.
  - Agents lists the agents a session in the folder of the last open session can
    run as, with their scope and description, read the same way as Customize.
    It does not change them; Choose Agent does.
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
  - Data, under Desktop, counts the sessions the host lists, shows the
    desktop's folder `machine/desktop` in the home with Show in Finder (Open
    folder on other platforms), and has Reset for the appearance and for the
    layout.

The sidebar's top rows are the page rows: New Chat, Search, Work and Customize.
The row of the current page is filled. Work shows a count of sessions waiting on
you. Tour, Devices and Settings open from the buttons in the sidebar's footer.

Back and forward sit in the sidebar's top row, or in the main header when the
sidebar is hidden. Each is disabled when there is no page in its direction.
History holds the last 50 pages. Opening a page other than the current one drops
the forward pages, as a browser does, and opening the current page adds nothing.

Cmd+N opens New Chat, Cmd+[ goes back, Cmd+] goes forward and Cmd+, opens
Settings. The Go menu holds New Chat, Back, Forward, Search, Work, Customize,
Devices, Settings, Tour and Coverage. Search, Work, Customize, Devices, Tour and
Coverage have no shortcut; the command palette reaches them. On other platforms
the modifier is Ctrl.

## Command palette and sheets

Cmd+K or Cmd+Shift+P opens the command palette. It lists every command that
needs no argument, grouped as Go, Window, Session, Theme and Help, with each
command's shortcut. Typing filters the list by fuzzy match and marks the matched
letters. Up and Down move, Enter runs the command and Escape closes the
palette. Cmd+P opens Go to Session, the same list over sessions, each with its
folder and age and a dot while it is working or waiting on you; Enter opens the
session. Both are in the View menu.

Cmd+/ opens Keyboard Shortcuts, a sheet with every shortcut by group and a
filter box. The Help menu holds it and the sheets below. Each sheet closes with
Escape, its close button or a click outside it.

- Choose Agent, in the View menu, lists the agents the open session can run as,
  with the current one checked. A click or its number key switches the session
  to that agent. With no session open it says to open one.
- Choose Theme lists the three themes with a swatch; a click or a number key
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
  opens Customize. Turning extensions on or off and installing them is not
  available from the window.
- Configuration Files lists Vera's configuration files and what each holds, and
  shows the Vera home in Finder. Editing them is done with `/configure` in the
  terminal UI.
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
is being dragged. The right pane switches them with rounded tabs in its top row,
each an icon and a title. The panel switches them with tabs. A container holds
one or more views stacked on top of each other, and each view has a header that
collapses it. The main area is not a location for views.

Seven views ship with the app:

- Sessions, in the sidebar, lists the first 50 sessions of the home, most recent
  first, in groups by folder. A group's heading is the last segment of the folder
  path, or `No folder` when a session has none. Hovering the heading shows the
  full path. Chats, which are sessions with no folder of their own, share one
  group headed `Chats`; its heading opens no workspace page. Groups are in the
  order of their most recent session, and rows keep
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
- Review, Plan, Files and Preview, each in its own container in the right pane,
  follow the open session; see Session tools.
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
`go.search`, `go.work`, `go.customize`, `go.settings`, `go.back`, `go.forward`,
`session.rewind`, `session.compact`, `session.subagents`, `session.tasks`,
`session.copyConversation`, `session.cycleLayout` and `session.setLayout`.
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

- While the turn runs, one status line at the end of the conversation says what
  Vera is doing. It changes its words and never its place:
  - `Thinking`, with the turn's clock before it once the turn is two seconds old
    (`12s · Thinking`), until text or a tool call arrives.
  - `12s · 236 tokens` while a reply is being written. The window counts about
    one token for each four characters it has received, because the host sends no
    count until the turn ends.
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
- While the turn runs, the plan it wrote shows as a checklist under the newest
  text and leaves when the turn ends. It does not open the Plan view.
- New words in the reply being written fade in. Only the newest block of a live
  reply does; finished replies do not.
- Reasoning is hidden. A thought shows nothing during the turn or after it, and
  the status line says only `Thinking`. See Showing reasoning below.
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

A reply that is still being written updates about four times a second, and about once a second while the window is hidden, minimized or not focused. It catches up as soon as the window is back.

When the host is not running, the page says so. When the host closes the
session, or the connection drops, the page keeps what it showed and adds a
strip with the reason.

### Showing reasoning

The window hides reasoning by default and has no setting or command for it. A
flag in `machine/desktop/flags.json` under the home turns it on:

```
{"showReasoning": true}
```

The window reads the file once, when it starts or its page reloads, so restart
the window after editing it. A missing, oversized (over 4 KB) or invalid file,
and any value other than `true`, leaves reasoning hidden. The host does not read
the file.

With the flag on, each thought shows as `Thought` and its length in seconds,
and opens to show its text. A thought still being written shows three dots and
its latest line. The status line still says only `Thinking`, with the clock.

## Composer

The composer is a box for your message with a row of chips above it and a bar
below it. The chips show where the session runs: `This Mac`, the folder by its
last path segment, and the folder's git branch when it has one. A chat shows
`Chat` in place of the folder and no branch. Hovering a chip shows the full
value. The branch is read from the folder's `.git` without
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
- When the session's folder no longer exists, the folder chip turns to the
  warning colour, keeps the folder's name and shows `Folder missing` when you
  hover it, and a line above the box reads `The folder <path> no longer exists.`
  with the full path. The window checks when the session opens and each time the
  window is shown or focused again, not on a timer. The warning goes away once
  the folder is back. Chats are not checked, since the host recreates their
  folder. The window offers no way to pick another folder for the session.

On New Chat the folder chip is a menu: the folders of your eight most recent
sessions, newest first, then `Open folder…`, which opens the system folder
picker. The menu leaves out chats and folders that no longer exist; the window
asks the shell which of up to 64 candidate folders are still directories each
time New Chat opens. The chip says `No folder` until you pick one, and New chat
here on a folder page or a workspace row starts with that folder picked.
Sending with no folder starts a chat: a session with no outside working
folder, whose files the host keeps in a folder of its own under the home.
Sending with a folder creates a session in that folder. Either way the session
starts with the host's default settings and the model and effort chosen on the
bar's pills, opens its page, and sends the message as soon as the page is
attached. The page title is the first line of the message until the session is
named. When the host cannot start the session, a line in the error colour above
the box says so, and the text you typed stays in the box.

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
  browser). `/rewind` and `/fork` open the Rewind or Fork sheet, `/compact` the
  compact sheet and `/subagents` the subagents sheet.
- `/model`, `/effort` and `/permissions` drive the composer's pills. With no
  argument each opens its pill's menu. `/model scout` runs the one available
  model that `scout` names and otherwise opens the model menu already searching
  for it. `/effort high` sets that level and `/effort default` returns to the
  model's default; an unknown level lists the levels. `/permissions ask` sets the
  approval mode to `ask`, `auto`, `readonly`, `full_access` or a custom mode, and
  an unknown mode lists them. Inside a session it changes the default mode, as in
  the terminal; on New Chat it sets the mode for the session about to start.
  `/agent` opens Choose Agent, and `/agent crow` switches the session to the
  agent `crow`.
- `/rename`, `/clone`, `/close` and `/parent` are also in the command palette as
  Rename Session, Clone Session, Close Session and Go to Parent Session.
  `/rename Crow's nest audit` renames the open session and shows a notice in the
  window's corner; `/rename` alone opens a sheet with the current name. `/clone`
  starts a new session holding a copy of the whole conversation and opens it.
  `/close` stops the session and keeps its file, then opens New Chat. `/parent`
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
- The terminal commands `/animations`, `/import`, `/usage`, `/extension` and
  `/reload-extensions` are listed with a muted `Not implemented yet`. Running one
  shows `/name: Not implemented yet` under the box and sends nothing.
- On New Chat the menu lists the built-in commands only, since skills and
  extension commands are read from a session. An unknown name there adds that
  skills and extension commands work inside a session.
- The menu is drawn above the box, outside the bar, and stays inside the window
  however narrow it is.

## Approvals and questions

When the session asks before running a tool, a card appears under the
conversation. Its title is the action and what it acts on, such as `Create
index.html` or `Run git push crow-nest main`, with the command or arguments
and any warning Vera gives below it. While a card is unanswered the status line
at the end of the conversation says `Waiting on you`. The card's buttons:

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

## Models

The model pill at the right of the composer's bar shows the model the session
runs; on New Chat, the model the new session will start with. The pill drops
the vendor prefix a provider puts on a model's name, so OpenRouter's "OpenAI:
GPT-5.6 Luna" reads "GPT-5.6 Luna"; a name you gave the model shows as you
wrote it. The tooltip has the full name and the provider. It opens a menu:

- A search box at the top. Typing filters the shortlist and adds the matching
  models that are not on it, each with a pin button that adds it to the
  shortlist.
- `Auto` and `Fast` are shown but disabled, since the host does not serve them.
- `Shortlist`: your shortlisted models with their provider and default
  effort. Keys 1 to 4 pick the first four while the search box is empty, and
  Up, Down and Enter move through the rows. A model its provider no longer
  offers is greyed out.
- When the session runs a model that is not on the shortlist, it shows first
  under `Running, not on your shortlist`.
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
Escape closes the popover. The level's description sits under the track, and
`Reset` goes back to the model's default level; it is dimmed while the model
already runs that level and left out when the model lists no default.

When the composer is too narrow for every pill, the approval pill shows only its
hand icon, and if that is not enough the effort pill hides, so the model's name
keeps its room. Hover the approval pill to see its mode. Both come back when the
composer widens.

The Models browser has four tabs:

- `Shortlist` and `All models` list models with their WA score, blended price
  per million tokens, a `P` for models on the score and price front, an image
  mark, and a pin that adds or removes the model from the shortlist. A search
  box and an `Intelligence` filter narrow the list; models the catalog hides
  appear only in a search. Selecting a row shows its details: provider,
  shortlist, verified, images, WA score, listed and blended price, context
  window and model id, with `Run this model`, the shortlist button and
  `Probe it`, which sends one short request and says whether the model passed.
- `Defaults` shows the model and effort new sessions start with, and the
  subagent and reviewer defaults. The host does not serve a model choice per
  job, so the window cannot set one.
- `Help` explains the marks.

Settings > Providers lists the providers the home is connected to, with how
many models each lists and when it was last listed. `Refresh` lists a
provider's models again. `Forget` asks first, then removes the provider's saved
connection and what Vera learned about its models. `Add a provider` explains
that connecting one is done in the terminal with `vera` and `/provider`; the
provider appears here once connected. Fallback after failures is not available
from the window.

## Session tools

While a session is open, the title bar holds its tools: a background tasks pill
when work is running, the context pill and the session menu.

The context pill shows how full the context window is, as a percent when the
model's window is known and as a token count otherwise. Before the first
measurement it shows a dash. It opens a popover with the total, whether it was
measured or estimated, a bar split into the system prompt parts, tool
definitions, the conversation, anything else the total holds (`Other`) and free
space, a mark where automatic compaction starts, and the token count it starts
at. `List every message` lists each message with its size. `Compact…` opens the
compact sheet.

The session menu (the `…` button) has:

- `Copy Conversation`, which copies the loaded conversation as Markdown.
- `Rewind or Fork…`, which lists your prompts, newest first. `Rewind here`
  shows how many messages stay and how many are set aside, and `Rewind` sets
  them aside and puts that prompt back in the composer to edit. A prompt with
  images cannot be rewound. `Fork from here` starts a new session from that
  point, opens it, and puts the prompt in its composer. Rewind waits until the
  turn ends; when the host refuses, the sheet says why and offers `Back`.
- `Compact…`, which shows the current use and runs a compaction. The sheet
  shows `Compacting…` while it runs, then the result, such as
  `Compacted the conversation from 46K to 12K tokens.` or
  `Nothing to compact yet.`
- `Subagents`, which lists the session's subagents with their status. `Open`
  shows one in a second pane beside the conversation, `Go to` opens its own
  page, and `Stop` stops a running one. Subagents still starting, which the host
  has not listed yet, show by title.
- `One Pane`, `Subagent Beside` and `Subagent Below`, which choose how the
  second pane sits. Cmd+Alt+A cycles them. The second pane shows the subagent
  you opened, or else the running one, or else the newest. It updates live and
  has no composer.

The background tasks pill shows how many subagents and background agents are
running. It opens the tasks sheet, which lists the subagents as above. The host
does not list background shell processes, and the sheet says so.

When a turn edits files, its end shows a card with the number of files edited
and the lines added and removed. Each file row opens to its patch, cut at 400
lines. `Review` opens the Review view. Review lists the files changed in the
last turn, or in the whole session, with their patches. Plan shows the newest
checklist Vera wrote in its scratch folder: the title, how many items are done,
a bar and the items, with the item just finished marked. Files shows the
session's folder (`Chat` for a chat) and says the host does not serve a file tree; Preview says the
host does not serve previews. While the right pane is closed, a rail at the
right of the session page opens these views.

When the host runs a turn on a different model than the one picked, a line in
the conversation says which model it used, marked `subagent` when a subagent's
model was swapped. Retries and failures show as strips in the column.

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
`theme.highContrast`, View > Choose Theme… opens a sheet with the three, and
Settings > Appearance lists them with a swatch. Switching applies the token values and a `data-theme`
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
node clients/desktop/test/shortcuts.e2e.mjs
node clients/desktop/test/compose.e2e.mjs
node clients/desktop/test/chat.e2e.mjs
node clients/desktop/test/approve.e2e.mjs
node clients/desktop/test/transcript.e2e.mjs
node clients/desktop/test/models.e2e.mjs
node clients/desktop/test/slash.e2e.mjs
node clients/desktop/test/tools.e2e.mjs
node clients/desktop/test/pages.e2e.mjs
```

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

The approve test runs a local provider that asks to run one shell command per
prompt in a session started in ask mode. It allows the first request with the 1
key from an empty composer and checks the key did not reach the composer, denies
the second from the card and checks the command did not run, and changes the
session's mode from the approval-mode pill.

The models test serves two local models with the second off the shortlist. From
New Chat it searches for a model, adds it to the shortlist, picks it and sends;
in the session it searches for the other model and sends on it, picks the first
shortlist row with its number key, lowers its effort, then selects a model in the
Models browser and probes it.

The slash test serves one skill and starts a session. On New Chat it types `/`
and checks the menu lists only the built-in group with a muted `Not implemented
yet` beside `/usage`, runs `/usa`, which names `/usage`, and checks the notice and that nothing
reached the provider, and enters a misspelt name and checks the text stays with
a `Did you mean` line. In the session it checks the three groups, that the menu
sits above the box and outside the bar, that it narrows as it is typed and stays
inside a 720 pixel wide window without changing how the pills fit, and that
Escape, the arrow keys and Tab work. It runs `/subagents`, `/import`, an
extension command and the skill, and checks the provider received the skill's
line. It renames, clones and closes the session from the box, and checks that
`/parent` says there is no parent.

The tools test runs a local provider that writes a scratch checklist, writes a
file and edits it. It checks the turn's edits roll up into one card, opens the
change from Review, reads the checklist's progress in the Plan view, waits for
the context pill to fill in, rewinds the newest prompt back into the composer
and compacts from the session menu.

The pages test finds a session by a word said in it from Search, watches a slow
turn finish in Work while another page is open, opens a folder's Workspace page
from the sidebar and checks its session count, checks Devices, reads Vera's help
skill on Customize and opens its detail, checks that Discover says there is
nothing to browse, goes from Tour to Coverage and back and opens the session
from its Tour card, runs Settings from the command palette, counts the session
in Settings > Data, finds the palette's keys in Settings > Keyboard and the
shortcuts sheet, and opens a session from Go to Session.

`bun test test/desktop` also covers turning history and live updates into the
transcript, paging and its cap, and the session pipe in the app.

The desktop and the shared UI are not part of the packed release; `pack:release`
copies neither directory.
