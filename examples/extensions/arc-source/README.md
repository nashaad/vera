# arc-source

Feeds arc issue events into the host inbox.

The manifest contributes one `arc` watch. The host runs the connector: it
streams the arc server's `/events` log over SSE, filters to the configured
topic and kinds, and appends each event as an inbox entry. The cursor is
persisted by the host, so a restart resumes where it stopped instead of
replaying the log.

Authentication comes from this machine's arc client config
(`~/.config/arc/config.toml`, or `$ARC_CONFIG`): the host reads the `token`
line and sends it as a bearer token. The manifest never carries a credential.

## Setup

Reference this directory by path from `config.json` and set the watch's config
there. The inbox is experimental, so `experimental.inbox` must be on.

```json
{
  "path": "/path/to/vera/examples/extensions/arc-source",
  "enabled": true,
  "config": {
    "watches": {
      "issues": {
        "server": "https://arc.your-host.example"
      }
    }
  }
}
```

`watches` is reserved: it is keyed by watch id and addresses the watches the
manifest contributes, so an extension cannot use that key for its own config.
Each key replaces the one the manifest declares, and a key the manifest never
declared is added. Naming a watch the manifest does not contribute is an error
rather than a value that silently does nothing.

The keys this watch reads:

- `server`: your arc server URL.
- `topic`: the one topic to watch. Required by convention; without it the
  watch sees every issue on the server.
- `kind`: which events become inbox entries. `publish` and `unblock` are the
  two that mean "an issue is claimable".

Copying this directory and editing `vera.extension.json` also works, but then
the copy stops receiving changes made here.

What happens next is the inbox's business, not this extension's: entries can
wake a subscribed session, or cold-spawn one if you have separately enabled
spawn (spawned sessions always start at the strictest approval posture). The
session that picks the work up claims and reports through the arc CLI itself.
