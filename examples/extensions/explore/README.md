# Explore

A read-only agent for investigating a codebase or question before deciding what
to change. Add it to `config.json`:

```json
{
  "extensions": [
    {
      "path": "/path/to/vera/examples/extensions/explore",
      "enabled": true,
      "config": {
        "skills": ["search-sessions"]
      }
    }
  ]
}
```

`skills` is an allow-list. Omit it to expose every installed skill; an empty
list exposes none. Explore enables the guarded `skill_script` tool by default,
but not shell access. Set `allow_skill_scripts` to `false` to disable it.

With the extension installed, investigation-shaped composer text can offer:

```text
Explore this first? · enter switch to explore · esc dismiss
```

Enter follows the ordinary `/agent explore` select path. Escape dismisses the
offer for the rest of the session. The agent can also be selected directly with
`/agent explore`.

Explore is intentionally read-only. It can read and search, report concrete
findings with file references, and identify uncertainty, but it cannot modify
the workspace. Selecting it while `auto` or `full_access` is active moves the
session to `readonly`; explicitly choosing broader access later returns the
session to `default`.
