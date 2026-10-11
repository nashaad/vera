# vera-plan

An example extension that adds a planning agent. Select it with `/agent plan`;
return with `/agent default`. It writes its plan as an artifact with the
included Artifacts extension, agrees it with you, keeps it current, and then
works through the agreed steps. You can comment on the plan in the annex.
Composer suggestions are off by default.

## Try the example

Enter this in the composer with the path to this directory:

```text
/extension install <path>/examples/extensions/plan
```

With Artifacts disabled the agent still plans, but only in the conversation.

Then restart the host and client. An installed copy runs with the default
options. To disable it, run `/extension disable example.plan`.

## Options

To set options, add an entry in the home's `config.json` that points at this
directory instead of installing it:

```json
{
    "extensions": [{
        "path": "/absolute/path/to/examples/extensions/plan",
        "enabled": true,
        "config": {
            "compose_suggestion": false,
            "skills": []
        }
    }]
}
```

`skills` is an allow-list. Omit it to expose installed skills; an empty list
exposes none.

Set `compose_suggestion` to true to show a planning offer while composing.
Enter accepts the offer and selects Plan; Escape dismisses it for the session.

Restart the host and client after changing the configuration.

## Behavior

Plan has the same tools as the default agent and runs under the session's
current access mode, so ask mode still asks before it edits files or runs
commands. A home or project `plan.md` shadows the extension's definition.

## Test

```bash
bun test
```
