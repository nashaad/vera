# Adversarial review

Vera's adversarial review is one deterministic TypeScript SDK workflow at
`workflows/adversarial-review/`. Run it directly from a Vera checkout:

```sh
bun run workflows/adversarial-review/main.ts --uncommitted
```

Three thin Vera adapters expose the same workflow:

- `/adversarial --uncommitted`, `--commit <sha>`, or `--base <ref>`;
- the top-level-only `adversarial_review` extension tool;
- `vera adversarial [--json]` with the same target flags.

The workflow validates the target, snapshots and bounds its Git patch, then
uses the embedded `Agent.run()` SDK with no tools. It never delegates or
recursively invokes another review. Disable the bundled extension with
`disabled_builtin_extensions: ["vera.adversarial"]`.
