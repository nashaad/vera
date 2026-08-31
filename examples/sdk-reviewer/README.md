# SDK reviewer example

This directory is a runnable application built with Vera's embedded SDK. It is
not SDK implementation and it is not a native Vera feature. Run it from a Vera
checkout:

```sh
bun run examples/sdk-reviewer/main.ts --uncommitted
```

The application imports the public `index.ts` SDK surface. That surface hides
provider routing, permissions, the bounded model loop, tool enforcement,
structured output parsing, cancellation, and terminal results. This is a
CLI-only example. It is not adapted into `/review`, and Vera does not load it
by default. The separate personal `review` skill uses the active harness's
native subagent facility instead of this application.

The directory is intentionally large because Git snapshotting, bounded process
capture, schemas, the review fan, refutation, aggregation, reporting, and CLI
policy belong to the example application. Vera's package is currently private,
so the example runs from a Vera checkout rather than from an externally
installed package.

## File map

- `main.ts` is the executable entrypoint.
- `cli.ts` owns target parsing, output modes, signals, and exit codes.
- `review.ts` runs the fan, refutation, aggregation, and report assembly.
- `lenses.ts` owns the application prompts and reviewer definitions.
- `target-snapshot.ts` and `bounded-output.ts` capture a bounded Git target.
- `review-request.ts` and `review-schema.ts` define inputs and structured output.
- `*.test.ts` covers the executable, CLI policy, snapshots, and review behavior.

## Commands

```sh
# Review working tree changes
bun run examples/sdk-reviewer/main.ts --uncommitted

# Review one commit
bun run examples/sdk-reviewer/main.ts --commit <sha>

# Review changes since a merge base
bun run examples/sdk-reviewer/main.ts --base <ref>

# Emit the terminal result as JSON
bun run examples/sdk-reviewer/main.ts --json --uncommitted
```
