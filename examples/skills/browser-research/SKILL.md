---
name: browser-research
description: Research current information through Vera's Chrome extension using the user's allowed browser tabs and signed-in sessions, then return a source-linked synthesis. Use for web research, comparing sources, investigating a page already open in Chrome, or gathering evidence that depends on the user's browser access.
---

# Browser Research

Use the `browser_*` tools contributed by the Vera Chrome extension.

1. Call `browser_tabs` first. Reuse a relevant allowed tab when one exists.
2. Read a known page with `browser_read_page`. When the user asks about the current page, read that tab before navigating or guessing another URL.
3. For broad research, navigate to a search results page with `browser_navigate`, read it, then open promising sources with `browser_read_page` by URL. Prefer primary and authoritative sources.
4. Use `browser_wait_for` when content loads late. Use `browser_query` only for precise structured extraction that the rendered-page read does not provide.
5. Use `browser_screenshot` only when visual layout matters. Do not use `browser_click` or `browser_type` unless the task requires interaction; those tools act through the user's live session.
6. Cross-check consequential claims across sources. Keep each source's title and URL with its evidence.
7. Return a concise synthesis with direct links, disagreements, uncertainty, and any access limitation.

If Chrome or the site is not connected or allowed, report the exact missing permission or setup step. Do not replace browser evidence with guesses.
