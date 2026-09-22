---
title: "Search the web"
description: "Connect search services and let Vera find sources for a task."
---

# Search the web

Ask Vera to search for a topic and approve the action if prompted. The included
search tool returns titles, URLs, and snippets. Vera uses a separate fetch tool
to read a returned page.

Search supports Brave and Exa, which both need an API key. Other extensions can
add providers. With no provider ready, a search fails and says so: connect Brave
or Exa, or install the DuckDuckGo example from
`examples/extensions/duckduckgo-search`.

## Connect a search provider

1. Run `/search-providers`, or choose **Search providers** from Ctrl+P.
2. Choose **Connect provider**, then a service.
3. For a keyed service, paste its API key and press Enter to save.
4. Open the provider's actions and choose **Verify** to try a small search.

Key input is masked and saved privately in your Vera home's credential store.
Verification can incur service charges. Escape cancels it.

Provider actions are grouped: key actions, then move up and move down, then
enable, disable, and remove. A dashed line separates the groups. A provider
that needs no key has no key actions.

You can also reach these settings through `/extensions`, then
`vera.web-search`, then **Search providers**. Changes apply to the next search
without restarting Vera.

## Set the search order

Vera tries enabled providers from top to bottom. Open a provider's actions
and choose **Move up**, **Move down**, **Enable**, or **Disable**.

Before you customize the list, connected services are ordered Brave, then Exa.
Your saved order replaces that initial order. A provider from an extension joins
at the bottom and leaves when the extension is removed.

### What causes fallback

A missing key skips a provider. A timeout, rejected key, rate limit, or service
failure tries the next one. Results identify the service used and any earlier
failures. If all services fail, Vera reports them.

Zero results is a successful search and stops fallback. Cancellation stops
the search too.

## Change or remove a key

Open a provider's actions to set or remove its saved key. **Remove provider**
removes the list entry but preserves the key. **Remove saved key** deletes it.

`BRAVE_API_KEY` and `EXA_API_KEY` can also supply credentials through the host
environment. A saved key takes precedence; removing it allows the exported
key to be used again.

## Search limits

The tool accepts a query and 1 to 10 results, defaulting to 5. Queries are
limited to 600 characters and 75 words. A search has a 15-second deadline,
with at most 5 seconds for each provider.

## Install the DuckDuckGo example

DuckDuckGo Lite needs no key and is not included. Install the example, then
restart the host, because the provider runs there:

```text
/extension install ~/Projects/vera/examples/extensions/duckduckgo-search
```

Use the path to your own Vera checkout. It then appears at the bottom of
`/search-providers`. It reads DuckDuckGo's HTML page, so a block or a changed
page is reported as a failure rather than as zero results. Keep the volume
low. `/extension remove example.duckduckgo-search` removes it and its provider.

## Add a provider from an extension

An extension adds a provider by declaring `search.providers.register` in its
manifest and calling `vera.search.registerProvider(...)` from `activate`. The
provider runs on the host, both for searches and for **Verify**.

A provider has an `id`, a `label`, `requiresKey`, an optional `keyEnv`, and a
`search({ query, count, key, signal })` function that returns titles, URLs,
and snippets. Keys are saved in the credential store and passed in as `key`.
`examples/extensions/duckduckgo-search` is a working example.
