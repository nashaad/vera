# Command hooks

This included extension runs executable pre-tool and post-tool hooks through
Vera's public extension API. It runs nothing until hooks are configured.
An omitted `hooks` array is empty; an invalid supplied value fails activation.

Add an entry to the home's `config.json`. Use the absolute extension path shown
in `/customize` under Extensions for `vera.command-hooks`, and an absolute
executable path:

```json
{
  "extensions": [
    {
      "path": "/absolute/path/to/src/core-extensions/command-hooks",
      "enabled": true,
      "config": {
        "hooks": [
          {
            "phase": "pre_tool_use",
            "argv": ["/absolute/path/to/hook"],
            "protocol": "claude",
            "timeout_ms": 1000
          }
        ]
      }
    }
  ]
}
```

`argv` is an executable followed by its arguments. Vera does not invoke a shell,
expand variables, or interpret redirects. The default timeout is 1 second; the
maximum is 30 seconds.

## Protocols

The default `vera` protocol writes the matching public hook payload as JSON on
stdin and expects a public Vera hook result as JSON on stdout.

The `claude` protocol currently supports `pre_tool_use` only. It writes
`session_id`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, and
`cwd`. Vera's `bash` tool is named `Bash`; other tool names are unchanged. Empty
stdout and `permissionDecision: "allow"` observe without changing the call.
`permissionDecision: "deny"` blocks it and requires a non-empty
`permissionDecisionReason`.

This compatibility mode does not implement matcher configuration, shell command
strings, environment overrides, async hooks, `additionalContext`, input updates,
or Claude-format post-tool responses.

## Trust boundary

An enabled command hook is trusted local code. It runs with the same operating
system authority and environment as Vera, and can access anything that Vera can.
The adapter bounds argv, stdin, stdout, and runtime, but it is not a sandbox.

A timeout, non-zero exit, malformed response, or unsupported response is isolated
as a failed extension hook. Vera continues the hook chain and tool call, so do not
use a command hook as the only enforcement layer for a security boundary.

To disable it, run `/extension disable vera.command-hooks`, which adds the ID
to `disabled_included_extensions`. An `extensions` entry in `config.json` whose
path is this directory replaces the included copy, including when that entry is
disabled. Restart the host after configuration changes.
