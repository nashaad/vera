---
title: "Supply extension credentials"
description: "Use environment variables for secrets needed by an extension."
---

# Supply extension credentials

An extension can read a credential from the host environment through an
`{env:NAME}` reference. This keeps the value out of the configuration file.
Export the variable before starting the host that loads the extension.

## Add an environment reference

Put the reference in the extension's `config` block. For example:

```json
{
  "extensions": [
    {
      "path": "extensions/mcp",
      "config": {
        "servers": {
          "github": {
            "command": "github-mcp-server",
            "env": { "GITHUB_TOKEN": "{env:GITHUB_TOKEN}" }
          }
        }
      }
    }
  ]
}
```

Use exactly one reference as the whole value. `"Bearer {env:GITHUB_TOKEN}"`
is a literal string and is not expanded. Variable names start with a letter
or underscore and contain only letters, digits, and underscores.

## When the value is read

Vera resolves references from the host environment just before loading the
extension. The extension receives the resolved configuration; diagnostics
that display stored configuration retain the reference.

A running host retains its own environment. Exporting a new value in another
terminal does not change that process's environment.

## Diagnose a missing variable

An unset or empty variable prevents that extension from loading. Other
extensions can still load. The startup note and host log identify the
variable and its configuration path, without including the resolved secret.

```sh
grep host_startup_extension_failed ~/.vera/runtime/logs/host.jsonl
```

Set the named variable in the environment used to start the host, then reload
through the required host restart.

## Literal credentials and unsupported references

Vera warns about literal values with recognized credential prefixes such as
`ghp_`, `github_pat_`, `sk-`, `xoxb-`, or `AKIA`. The warning identifies the
configuration path and prefix, not the full value. It does not block loading.
Values supplied through environment references do not trigger that warning.

Only the exact lowercase `{env:NAME}` form resolves. Malformed forms such as
`{env:}` or `{ENV:NAME}` remain literal text.
