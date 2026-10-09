# vera-lookout

An example extension. When a prompt mentions treasure, the lookout adds "the
crow buried it under the third palm" after it, before the model reads the
turn. The transcript shows "example.lookout added context".

When a reply says "done" but never mentions a map, the lookout sends the model
back for one more pass to mark where the treasure is buried. The transcript
shows "example.lookout continued the turn" and keeps both replies. Vera allows
one continuation per turn, so the crow cannot keep the crew digging forever.

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
