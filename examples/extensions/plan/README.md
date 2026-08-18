# Plan

An agent that reads and plans but never writes, and a compose-time offer to
switch to it. Add it to `config.json`:

```json
{
  "extensions": [
    {
      "path": "/path/to/vera/examples/extensions/plan",
      "enabled": true,
      "config": {
        "skills": ["search-sessions"]
      }
    }
  ]
}
```

`skills` is an allow-list. Omit it to expose every skill installed in Vera;
an empty list exposes none. Plan enables Vera's guarded `skill_script` tool by
default—not shell access—and scripts still have to belong to an installed,
allowed skill and be declared by its `SKILL.md`. Set `allow_skill_scripts` to
`false` if a read-only plan should not execute skill scripts.

With it installed, typing something like "what's the plan here?" shows one line
under the composer:

```
Create a plan? · enter switch to plan · esc dismiss
```

Enter switches agents the same way `/agent plan` would: a transcript
confirmation, a status-line change, and a one-time cache cost. Escape dismisses
the offer for the rest of the session.

Without this extension installed, nothing reads your composer text and no hint
ever appears. That is the whole point of shipping plan mode this way rather
than as a mode: people who want it install it, and everyone else never sees a
toggle.

The agent it registers is read-only and can be selected directly with `/agent plan`
whether or not you ever accept a suggestion. Extension-registered agents are
read-only definitions: a `plan.md` in your profile or in `.vera/agents` shadows
this one, and `[d]` in the `/agent` picker refuses to write into it.

Plan forbids `auto` and `full_access`. Selecting Plan while either is active
moves the session to `readonly`; explicitly selecting either permission later
wins, switches the session back to `default`, and leaves an explanation in the
transcript. The HUD keeps forbidden choices visible but disabled and explains
the conflict beside the Access row.
