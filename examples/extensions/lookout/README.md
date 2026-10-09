# vera-lookout

An example extension. When a prompt mentions treasure, the lookout adds "the
crow buried it under the third palm" after it, before the model reads the
turn. The transcript shows "example.lookout added context".

## Try the example

Enter this in the composer with the path to this directory:

```text
/extension install <path>/examples/extensions/lookout
```

Then restart the host and client, and ask where the treasure is.

## Test

```bash
bun test
```
