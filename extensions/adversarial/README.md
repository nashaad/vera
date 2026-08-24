# Adversarial review

Vera's bundled adversarial review is one deterministic TypeScript workflow
with three entry points:

- `/adversarial --uncommitted`, `--commit <sha>`, or `--base <ref>`;
- the top-level-only `adversarial_review` extension tool;
- `vera adversarial [--json]` with the same target flags.

The workflow validates the target, snapshots and bounds its Git patch, then
uses the embedded `Agent.run()` SDK with no tools. It never delegates or
recursively invokes another review. Disable the bundled extension with
`disabled_builtin_extensions: ["vera.adversarial"]`.
