---
name: adversarial
description: Perform a read-only adversarial review of a supplied git diff, staged diff, or commit range. Explicitly invoke only for a top-level agent's review request or Nash's /adversarial command; never auto-trigger, delegate, or review from a subagent.
disable-model-invocation: true
---

# Adversarial Review

## Activation gate

Use this skill only when one of these conditions is true:

1. Nash, the user, explicitly says `/adversarial`.
2. The top-level agent explicitly asks for an adversarial review of a diff or commit.

Do not use it because a change is large, risky, ready to commit, or described as
needing review. Do not use it when the request comes from a subagent. If the
caller is a subagent or the activation source is unclear, refuse the review and
return that the skill is top-level-only.

## Non-recursion boundary

This skill is a one-hop external launcher. From the top-level agent, run
exactly one declared script, then return the child review. Never use an
internal subagent tool, retry automatically, invoke this skill again, or launch
a second agent. A child reviewer must not delegate, call `codex exec`, or ask
for another review.

The launcher and reviewer are read-only. They must not edit files, apply
patches, run builds or tests, commit, push, merge, reset, stash, or change
repository state. The launcher must use the repository's current working
directory and the target supplied by the caller.

## Launch

Use `skill_script` for the one declared script. Select the external runner
explicitly and exactly one target:

- Vera: `scripts/run-review.sh --runner vera ...`; it uses `vera -p` with
  `--prompt-only` and a named model.
- Codex or Claude: `scripts/run-review.sh --runner codex ...`; it uses
  `codex exec review`. Claude must not use `claude -p`.

- `scripts/run-review.sh --runner <runner> --uncommitted` for staged, unstaged,
  and untracked changes;
- `scripts/run-review.sh --runner <runner> --commit <sha>` for one commit;
- `scripts/run-review.sh --runner <runner> --base <ref>` for all changes from
  `<ref>` to `HEAD`.

Do not invoke the script without a target. Do not pass arbitrary shell text or
additional reviewer instructions. The Codex route starts `codex exec review`
with a read-only sandbox and an ephemeral session. The Vera route passes the
selected patch directly to `vera -p` with no tools. Both routes mark the child
as a leaf reviewer so it cannot recursively launch this workflow.

The Vera route defaults to the named Luna model. A different model is a valid
fallback only when the caller supplies that exact fallback explicitly with
`--model <provider/model>`; never choose one automatically. If the requested
Vera model cannot be resolved and no explicit fallback was supplied, fail
immediately.

## Child review contract

The child reviews only the selected diff or commit target. It checks for
concrete behavior regressions, broken edge cases, missing error handling,
incorrect state or persistence, concurrency and cancellation bugs, protocol or
layer-boundary violations, authorization and data-loss risks, and missing tests
for changed observable behavior.

It reports actionable findings first, ordered by severity (`P0` blocking,
`P1` high, `P2` medium, `P3` low), with a file/line or commit reference, the
failure mechanism, and the smallest useful correction when evident. It
separates confirmed defects from questions and suggestions, then ends with the
reviewed target and important unverified areas. It does not fix findings or
offer generic style advice.

If this skill is loaded in the child despite the explicit-only policy, the child
must not use it: the child is already the leaf reviewer.
