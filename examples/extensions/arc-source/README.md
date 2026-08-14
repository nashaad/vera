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

1. Copy this directory into your profile's extensions directory
   (`~/.vera/profiles/<name>/extensions/arc-source`), or reference it by path.
2. Edit `config` in `vera.extension.json`:
   - `server`: your arc server URL.
   - `topic`: the one topic to watch. Required by convention; without it the
     watch sees every issue on the server.
   - `kind`: which events become inbox entries. `publish` and `unblock` are
     the two that mean "an issue is claimable".
3. Enable it in `config.json` like any other extension. The inbox is
   experimental, so `experimental.inbox` must be on.

What happens next is the inbox's business, not this extension's: entries can
wake a subscribed session, or cold-spawn one if you have separately enabled
spawn (spawned sessions always start at the strictest approval posture). The
session that picks the work up claims and reports through the arc CLI itself.
