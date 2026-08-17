# Reminders

Appends reminder texts to `write` and `edit` results when the written path
matches a rule. Add it to `config.json`:

```json
{
  "extensions": [
    { "path": "/path/to/vera/examples/extensions/reminders", "enabled": true }
  ]
}
```

Rules live in the extension's own profile directory:
`~/.vera/profiles/<profile>/example.reminders/rules.toml`. The file is re-read
on every firing, so edits apply without a restart.

```toml
cooldown_minutes = 10

[[rules]]
id = "migrations"
match = "**/migrations/*.sql"
remind = "Add the matching down-migration."
```

A missing, unreadable, or malformed file reads as no rules: reminders are an
affordance, not a dependency. Each rule stays silent for `cooldown_minutes`
after it fires, per session.
