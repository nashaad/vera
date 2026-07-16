# vera

Vera reads shared model configuration from `~/.vera/config.json`.

OpenRouter remains the default provider:

```json
{
  "schema_version": 1,
  "provider": "openrouter",
  "model": "anthropic/claude-sonnet-4"
}
```

Set `OPENROUTER_API_KEY`, then run `bun run tui`.

To use a ChatGPT Codex subscription, authenticate once and select the Codex
provider:

```sh
bun run src/cli.ts login openai-codex
```

```json
{
  "schema_version": 1,
  "provider": "openai-codex",
  "model": "gpt-5.6-sol"
}
```

The Codex adapter provides authenticated model calls through Vera. It does not
embed Codex product features such as its usage/reset UI or session runtime.
