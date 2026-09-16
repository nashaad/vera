# Plan

Plan ships as an included extension. Select it with `/agent plan`; return with
`/agent default`. It reads and plans using `read`, `grep`, and `list` and starts
in read-only access. Composer suggestions and skill scripts are off by default.

To configure it, add an entry in the home's `config.json` using the absolute
path shown in `/customize` under Extensions for `example.plan`:

```json
{
    "extensions": [{
        "path": "/absolute/path/to/extensions/plan",
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

Plan forbids `auto` and `full_access`. Selecting Plan under either posture
moves to `readonly`. Explicitly choosing either posture later switches back
to the default definition and explains the change in the transcript.
A home or project `plan.md` shadows the included definition.

To disable the included extension, add `example.plan` to
`disabled_builtin_extensions`. An explicit copy with that ID replaces the
included copy, including when disabled. Restart the host and client after
changing its configuration. The ID is retained for existing configurations.
