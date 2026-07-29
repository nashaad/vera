# vera-d2

An example extension that gives the model one terminal-diagram tool:

```text
render_d2(source, character_set?)
```

The extension runs the local D2 CLI's text renderer and returns Unicode
box-drawing output by default. It does not add a slash command or write diagram
files into the workspace.

## Requirements

Install D2 0.7.1 or newer and make `d2` available on the Vera host's `PATH`.

## Try the example

Copy this directory into Vera's global extension directory:

```bash
cp -R examples/extensions/d2 ~/.vera/extensions/d2
```

Vera discovers it the next time its host starts. The extension declares the
`diagram.render` permission operation, so the selected permission mode decides
whether a tool call runs directly or requires review.

## Test

```bash
bun test
```
