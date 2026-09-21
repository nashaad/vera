---
title: "Build a reviewer with the embedded SDK"
description: "Run defined roles from TypeScript and collect validated review findings."
---

# Build a reviewer with the embedded SDK

The embedded SDK runs Vera from TypeScript application code without starting
a resident host. This guide builds a reviewer that reads a change and returns
structured findings. Your application controls sequencing, concurrency, and
how results are combined.

Use this approach when an application needs an individual role or several
independent review passes. For workflows that retain completed steps across
process restarts, see [How workflows run](workflows.md).

## Run the complete workflow

Vera includes a complete SDK reviewer as ordinary TypeScript under
`examples/sdk-reviewer/`. Run it from a Vera checkout without starting
the extension host:

```sh
bun run examples/sdk-reviewer/main.ts --uncommitted
bun run examples/sdk-reviewer/main.ts --commit 31450c4b
bun run examples/sdk-reviewer/main.ts --base main
```

Add `--json` to receive the typed aggregate:

```sh
bun run examples/sdk-reviewer/main.ts --json --base main
```

The example imports from Vera's public package root. It captures the target,
runs review passes, checks each finding, and combines the results. It is a
standalone CLI program under `examples/sdk-reviewer/`.

## Build a single review

### Define the reviewer

Create the role once, outside the function that runs it:

```ts
import { defineAgent } from "vera";

export const reviewer = defineAgent({
    name: "change-reviewer",
    description: "Finds concrete defects in a code change",
    instructions: `Inspect the supplied change for concrete defects.
Trace the failure path and cite the relevant file and line.
Return only findings supported by evidence in the target.`,
    tools: ["read", "grep"],
    posture: "readonly",
});
```

The definition uses the same `AgentDefinition` shape as a file-backed or selected
agent. `defineAgent()` validates it immediately. An invalid name or empty
instructions throws while the module loads, before a provider request exists.

The tool list is exact:

- omit `tools` to offer every available tool;
- use `tools: []` to offer none;
- use `tools: ["read", "grep"]` to offer only those two.

A tool outside the list is absent from the request and is refused if it is
called anyway.

### Define typed findings

`run()` accepts any schema object with a `parse(value)` method. Zod works
without an adapter:

```ts
import { z } from "zod";

export const Finding = z.object({
    summary: z.string().min(1),
    severity: z.enum(["critical", "high", "medium", "low"]),
    file: z.string().min(1).optional(),
    line: z.number().int().positive().optional(),
    mechanism: z.string().min(1),
    evidence: z.string().min(1),
    suggestedFix: z.string().min(1).optional(),
}).strict();

export const Findings = z.object({
    findings: z.array(Finding),
}).strict();
```

The schema belongs to the run, not the agent definition. The same role can
return plain text in one workflow and typed findings in another.

### Run one review

Create one runtime, bind the definition, and run one bounded turn:

```ts
import { Vera } from "vera";
import { reviewer } from "./reviewer.ts";
import { Findings } from "./schemas.ts";

const vera = await Vera.create({
    workspace: process.cwd(),
    posture: "readonly",
});

const result = await vera.agent(reviewer).run(changeText, {
    output: Findings,
});

if (result.outcome !== "completed" || result.output === undefined) {
    throw new Error(result.error?.message ?? "Review did not complete");
}

for (const finding of result.output.findings) {
    console.log(`${finding.severity}: ${finding.summary}`);
}
```

`result` also keeps:

- `text`, including visible text from intermediate tool turns;
- the provider and model that ran;
- usage when the provider reports it;
- routing substitutions;
- a typed error for failed or aborted runs.

If JSON parsing or schema validation fails, the outcome is `failed`, `text`
remains available, and `output` is absent. A run without `output: Findings`
keeps the plain text result shape.

## Control a run

### Narrow a turn before it starts

`prepareTurn` runs once after the prompt is saved and before the first model
call. It can watch, drop tools from this turn, pick a different model or
effort, or refuse the turn. It cannot edit the prompt or the system
instructions.

```ts
const result = await vera.agent(reviewer).run(changeText, {
    prepareTurn(turn) {
        if (turn.prompt.includes("secret")) {
            return { power: "block", reason: "do not review secret material" };
        }
        return { power: "mutate", tools: ["read"] };
    },
});
```

A blocked turn is a failed run. A tools list may only name tools this turn
already offered. It cannot add a tool that was unavailable to the run.

### Set the role's default model

An agent can name a model-pool entry without putting provider logic in the
workflow:

```ts
export const refuter = defineAgent({
    name: "finding-refuter",
    description: "Tries to disprove one review finding",
    instructions: `Test the supplied finding against the task and target.
Return whether the evidence disproves it and explain why.`,
    tools: [],
    posture: "readonly",
    defaultPair: { name: "luna", effort: "high" },
});
```

Model selection uses this order:

1. an explicit bind override;
2. the definition's `defaultPair`;
3. the runtime's configured route.

Fallback stays in the runtime. Any substitution is returned in the run result.

## Run several review passes

Run independent roles with `Promise.all()`, then combine their typed results:

```ts
const lenses = [correctness, security, reproduction] as const;

const passes = await Promise.all(
    lenses.map(async (lens) => ({
        lens: lens.name,
        run: await vera.agent(lens).run(targetSnapshot, {
            output: Findings,
        }),
    })),
);

const lensFailures = passes.flatMap(({ lens, run }) =>
    run.outcome === "completed" && run.output !== undefined
        ? []
        : [{ lens, error: run.error }]
);

const findings = passes.flatMap(({ lens, run }) =>
    run.outcome === "completed" && run.output !== undefined
        ? run.output.findings.map((finding) => ({ lens, finding }))
        : []
);
```

Refute each finding independently:

```ts
const Verdict = z.object({
    refuted: z.boolean(),
    reasoning: z.string().min(1),
}).strict();

const judged = await Promise.all(
    findings.map(async (row) => {
        const prompt = `Original task:
${originalTask}

Finding:
${JSON.stringify(row.finding)}

Immutable target:
${targetSnapshot}`;

        const run = await vera.agent(refuter).run(prompt, {
            output: Verdict,
        });
        if (run.outcome !== "completed" || run.output === undefined) {
            throw new Error(run.error?.message ?? "Refutation failed");
        }
        return { ...row, verdict: run.output };
    }),
);

const survivors = judged.filter((row) => !row.verdict.refuted);
```

This example keeps findings that their refuter did not disprove. Report
`lensFailures` alongside them so callers know if a review pass failed.

### Apply a shared permission limit

The posture passed to `Vera.create()` is the outer ceiling shared by every
binding from that runtime. A definition may ask for a stricter built-in mode.
It cannot ask for a wider one.

```ts
const vera = await Vera.create({
    workspace,
    posture: "readonly",
});

vera.agent(readonlyReviewer); // allowed
vera.agent(fullAccessReviewer); // throws before the model loop
```

Create one runtime before starting the review passes so they share the same
permission limit.

## Load a reviewer by name

Definitions can also live in the project or home agent catalog. A project
file at `.vera/agents/change-reviewer.md` can contain:

```md
---
description: Finds concrete defects in a code change
tools:
  - read
  - grep
posture: readonly
---
Inspect the supplied change for concrete defects. Cite the failure path and
return only findings supported by the target.
```

Bind it by name:

```ts
const result = await vera.agent("change-reviewer").run(changeText, {
    output: Findings,
});
```

Project definitions shadow home definitions with the same name. A missing
or invalid catalog definition fails before its model loop starts.
