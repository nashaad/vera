---
title: "Search the web"
description: "Connect search services and let Vera find sources for a task."
---

# Search the web

Ask Vera to search for a topic and approve the action if prompted. The included
search tool returns titles, URLs, and snippets. Vera uses a separate fetch tool
to read a returned page.

Search supports Brave, Exa, and DuckDuckGo Lite. Brave and Exa require API keys;
DuckDuckGo does not.

## Connect a search provider

1. Run `/search-providers`, or choose **Search providers** from Ctrl+P.
2. Choose **Connect provider**, then a service.
3. For a keyed service, paste its API key and press Enter to save.
4. Open the provider's actions and choose **Verify** to try a small search.

Key input is masked and saved privately in your Vera home's credential store.
Verification can incur service charges. Escape cancels it.

You can also reach these settings through `/extensions`, then
`vera.web-search`, then **Search providers**. Changes apply to the next search
without restarting Vera.

## Set the search order

Vera tries enabled providers from top to bottom. Open a provider's actions
and choose **Move up**, **Move down**, **Enable**, or **Disable**.

Before you customize the list, available keyed services are ordered Brave,
then Exa, followed by DuckDuckGo. Your saved order replaces that initial order.

### What causes fallback

A missing key skips a provider. A timeout, rejected key, rate limit, or service
failure tries the next one. Results identify the service used and any earlier
failures. If all services fail, Vera reports them.

Zero results is a successful search and stops fallback. Cancellation stops
the search too. DuckDuckGo page changes or blocking are reported as failures,
rather than as an empty result.

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

Disable an older installed `nash.web-search` example before using the included
extension, because both register the same tool name.
