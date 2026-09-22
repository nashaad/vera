# vera-plan

An example extension that adds a read-only planning agent. Select it with
`/agent plan`; return with `/agent default`. It reads and plans using `read`,
`grep`, and `list` and starts in read-only access. Composer suggestions and
skill scripts are off by default.

## Try the example

Enter this in the composer with the path to this directory:

```text
/extension install <path>/examples/extensions/plan
```

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

Plan forbids `auto` and `full_access`. Selecting Plan under either posture
moves to `readonly`. Explicitly choosing either posture later switches back
to the default definition and explains the change in the transcript.
A home or project `plan.md` shadows the extension's definition.

## Test

```bash
bun test
```
