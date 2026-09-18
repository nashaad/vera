# vera-duckduckgo-search

> [!WARNING]
> Use this example only for low-volume personal evaluation. Do not use it for
> automated, concurrent, or sustained traffic against DuckDuckGo. Use Brave or
> Exa in `/search-providers` for regular use.

An example search provider for Vera. It adds DuckDuckGo Lite to the providers
that the included `web_search` tool tries. It needs no account or key.

DuckDuckGo Lite is an HTML page rather than a supported search API, so
DuckDuckGo may throttle or block it, or change the page it parses. Those cases
are reported as failures, and search moves on to the next provider.

## Try the example

Enter this in the composer with the path to this directory:

```text
/extension install <path>/examples/extensions/duckduckgo-search
```

Then restart the host, since the provider runs there. DuckDuckGo appears at
the bottom of `/search-providers`, where you can move it, disable it, or
verify it. Removing the extension removes the
provider.

## How it plugs in

The manifest declares `search.providers.register`, and `activate` registers
the provider. The included web search tool runs it, and `/search-providers`
verifies it through the host.

A provider has an `id`, a `label`, `requiresKey`, an optional `keyEnv`, and a
`search` function. When a provider needs a key, Vera stores it and passes it
in as `key`.

## Test

```bash
bun test
```
