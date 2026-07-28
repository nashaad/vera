# vera-web-search

> [!WARNING]
> Use the DuckDuckGo path only for low-volume personal evaluation. Do not use
> this example for automated, concurrent, or sustained traffic against
> DuckDuckGo. Configure Brave or another supported search API for regular use.

An experimental external web-search extension for Vera.

It registers one model-visible tool:

```text
web_search(query, max_results?)
```

DuckDuckGo Lite is used by default and needs no account. It is an HTML
integration rather than a supported search API, so DuckDuckGo may throttle it
or change the page it parses.

When `BRAVE_API_KEY` is present in the Vera host environment, the extension
uses Brave's official Search API instead.

## Try the example

Copy this directory into Vera's global extension directory:

```bash
cp -R examples/extensions/web-search ~/.vera/extensions/web-search
```

Vera discovers it the next time its host starts. To select a provider
explicitly, add an extension entry for the installed directory to
`~/.vera/config.json`; `provider` may be `auto`, `duckduckgo`, or `brave`.
`auto` prefers Brave when `BRAVE_API_KEY` is available and otherwise uses
DuckDuckGo.

Restart the Vera host after changing extensions or environment variables.

## Test

```bash
bun test
```
