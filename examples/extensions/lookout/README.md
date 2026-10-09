# vera-lookout

An example extension. When a prompt mentions treasure, the lookout adds "the
crow buried it under the third palm" after it, before the model reads the
turn. The transcript shows "Spotted: treasure under the third palm ·
example.lookout".

When a reply says "done" but never mentions a map, the lookout sends the model
back for one more pass to mark where the treasure is buried. The transcript
shows "Back to digging: no map drawn · example.lookout" and keeps both replies.
Vera allows one continuation per turn, so the crow cannot keep the crew digging
forever.

## Change the words

The words before the colon come from the extension's configuration. An
installed copy uses "Spotted" and "Back to digging". To change them, skip the
install and add a `config.json` `extensions` entry whose path is the absolute
path of this directory:

```json
{
    "extensions": [{
        "path": "/absolute/path/to/examples/extensions/lookout",
        "config": { "rows": { "spotted": "Land ho", "nudge": "Keep digging" } }
    }]
}
```

Words longer than 60 characters, or with a line break, fall back to the
defaults. Restart the host and client after changing it.

## Try the example

Enter this in the composer with the path to this directory:

```text
/extension install <path>/examples/extensions/lookout
```

Then restart the host and client, and ask where the treasure is. Ask the model
to reply with just "done" to see the lookout continue the turn.

## Test

```bash
bun test
```
