# vera-plan

An example extension that adds a planning agent. Select it with `/agent plan`;
return with `/agent default`. It reads with `read`, `grep`, and `list` and
writes its plan as an artifact with the included Artifacts extension, so you
can comment on it in the annex. Composer suggestions and skill scripts are off by
default.

## Try the example

Enter this in the composer with the path to this directory:

```text
/extension install <path>/examples/extensions/plan
```

With Artifacts disabled the agent still plans, but has no artifact tools.

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
            "allow_skill_scripts": false,
            "skills": []
        }
    }]
}
```

`skills` is an allow-list. Omit it to expose installed skills; an empty list
exposes none. Set `allow_skill_scripts` to true to enable guarded scripts from
allowed skills. This does not grant shell access.

Set `compose_suggestion` to true to show a planning offer while composing.
Enter accepts the offer and selects Plan; Escape dismisses it for the session.

Restart the host and client after changing the configuration.

## Behavior

Plan runs under the session's current access mode. It has no tool that edits
workspace files or runs commands; the artifact tools write only to the
Artifacts extension's own storage. A home or project `plan.md` shadows the extension's
definition.

## Test

```bash
bun test
```
