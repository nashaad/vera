---
title: "Browser use"
description: "Browse and let Vera work in the Browser pane."
---

# Browser use

Open the Browser in the desktop window's right pane. Each Browser tab is one
page. Enter a site address to open it. The Browser holds websites only. The bar
has Back, Forward, Reload and Open in your browser. Use `+` and pick Browser, or type an address in its field, to open
another site. Links that open a new window open a tab in the pane, up to 12
Browser tabs. Cmd+R (Ctrl+R on other platforms) reloads the visible Browser page
or Files HTML Preview without reloading the desktop window. When no page is
visible, the shortcut does nothing. The Browser does not open loopback addresses
until the desktop has read the host's page list. Wait a moment and enter the
address again.

You can sign in to sites yourself in the pane. Browser tabs share cookies, site
storage and cache in memory while the desktop is open; those sign-ins and site
data do not survive closing the desktop. Site recents and saved captures remain
in the home, and downloaded files remain where you save them. Data left in
`machine/desktop/chromium/browser` by earlier versions is not opened or deleted.

Browser history lists web pages shown in the pane, whether opened by you or by
`builtin_browser`. Search the history or browse it by day; opening an entry loads
it in the current tab. Clear removes history and recent site pages immediately,
while preserving Vera page recents. Cmd+Shift+Delete
(Ctrl+Shift+Delete on other platforms) opens history with Clear focused; press
Enter to clear it.

Sites cannot use permission-gated features such as the camera, microphone,
location or notifications in the pane.

Browser tools are off by default. Turn on Browser tools in the pane to let
Vera open a page, read it, click, type, scroll, go back and take a screenshot.
`read` returns the page as markdown with link URLs and tables. A long page is
read in parts: the reply gives the offset for the next part.
Tool calls follow the session's approval mode. You can watch in the pane and
use it yourself. While the tools are on, a notice stays at the bottom of the
window in every view: "Browser tools are on. Vera can open, read and act on
pages in the Browser." Choose Turn off there or turn the switch off in the pane
to stop further browser tool calls. If the Browser tools connection is
unavailable, the notice stays visible and both controls are disabled until it
is available again. A desktop window must be open for the tools to work. If a call fails because
Browser tools are off, choose Open Browser under the failed run, turn on the
switch, then ask again. Opening the Browser does not turn the switch on.
Vera's own pages, such as Usage, cannot be controlled by `builtin_browser`.
When the built-in browser and the Chrome extension's `browser` tool are both
loaded, Vera asks which to use before its first browser call and keeps the
answer for the conversation.
