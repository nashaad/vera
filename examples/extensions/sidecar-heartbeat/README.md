# vera-sidecar-heartbeat

A minimal sidecar extension. The manifest declares one process under
`contributes.sidecars`; the host starts it when the host starts, restarts it
with backoff if it crashes (quarantining after repeated failures), and stops
it (SIGTERM, then SIGKILL after a grace period) when the host stops.

The child runs with the extension directory as its working directory unless
`cwd` says otherwise, inherits the host's environment plus the declared `env`,
and receives the host socket path as `VERA_SOCKET`, so a sidecar can act as an
ordinary process client. Output lands in
`~/.vera/profiles/<profile>/runtime/logs/sidecars/<extension>.<id>.log`.

Manifest fields per sidecar:

- `id`: local id, canonicalized as `<extension-id>/<id>`.
- `command`: argv array, required.
- `env`: string map merged over the host environment, optional.
- `cwd`: resolved against the extension directory, optional.
- `restart`: `true` (default) supervises and restarts; `false` runs once.

Enabling an extension that declares a sidecar means letting it run that
command whenever the host is up; enable it deliberately.
