# Plan

An agent that reads and plans but never writes, and a compose-time offer to
wear it. Add it to `config.json`:

```json
{
  "extensions": [
    { "path": "/path/to/vera/examples/extensions/plan", "enabled": true }
  ]
}
```

With it installed, typing something like "what's the plan here?" shows one line
under the composer:

```
Create a plan? ⏎ wear plan · esc dismiss
```

Enter wears the agent the same way `/agent plan` would: a transcript
confirmation, a status-line change, and a one-time cache cost. Escape dismisses
the offer for the rest of the session.

Without this extension installed, nothing reads your composer text and no hint
ever appears. That is the whole point of shipping plan mode this way rather
than as a mode: people who want it install it, and everyone else never sees a
toggle.

The agent it registers is read-only and can be worn directly with `/agent plan`
whether or not you ever accept a suggestion. Extension-registered agents are
read-only definitions: a `plan.md` in your profile or in `.vera/agents` shadows
this one, and `[d]` in the `/agent` picker refuses to write into it.
