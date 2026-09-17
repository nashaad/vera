---
title: "Work in a Chrome tab"
description: "Ask Vera to inspect and interact with an open browser tab."
---

# Work in a Chrome tab

With Vera's Chrome extension connected, you can ask Vera to inspect controls,
click, type, press Enter, and capture the selected tab.

## Give Vera a browser task

Name the tab and the result you want. For example:

```text
In the open documentation tab, search for installation and open the setup guide.
```

Grant the requested site access and browser-action permission. The extension
also requires Chrome debugger permission for native actions.

## Follow the activity

Vera shows a temporary blue activity marker and an on-page pointer while it
acts. The pointer shows where it clicks or types, then disappears. Existing
tab groups and pinned tabs retain their arrangement.

A click being dispatched does not establish that the page accepted it. Check
the resulting page before retrying an action that reported failure, because
the action may already have occurred.

## Screenshots

Screenshots require the companion runtime's image support and a model that
accepts images. Capturing or saving an image alone does not establish that
Vera inspected its contents.
