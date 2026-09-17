---
title: "Halcyon workflows"
description: "Write Python workflows that record completed steps and resume after interruption."
---

# Halcyon workflows

Halcyon is Vera's durable-workflow framework. It runs Python functions as
recorded steps, saving their results in a journal. If a process stops, resume
reuses completed results and runs the steps that have no recorded result.

A workflow runs ordinary Python functions. Your code decides the order,
branches, and loops.

## When to use a workflow

Use Halcyon when a task has a repeatable sequence and progress needs to survive
an interruption. Examples include processing a collection of files, reviewing
several changes, or pausing a run for a person's decision.

| Your task | Use |
| --- | --- |
| Investigate a question interactively | A Vera conversation. |
| Apply the same instructions and tools to recurring tasks | A reusable agent definition. |
| Run a sequence and retain completed results across restarts | A Halcyon workflow. |

## How a run works

`@workflow` marks the function that coordinates the work. `@step` marks a
function whose completed result should be saved.

```text
Workflow starts or resumes
          |
          v
     Reach a step
          |
          +-- result in journal --> reuse saved result
          |
          +-- no result ---------> run step --> save result
          |
          v
     Continue workflow
```

On resume, the workflow function runs again from the top. Completed steps
return saved values. Code between steps runs again, so keep side effects
inside steps and make those steps safe to repeat.

### What survives an interruption

The journal records successful steps. If the process stops after a side effect
but before its result is recorded, that step can run again. Halcyon does not
roll back external changes or guarantee that each side effect happens once.

The journal can be a directory of files or a SQLite database. You choose its
location. Use the workflow commands to inspect or resume a run; the TUI's
`/work` list does not list workflow journals.

## Build a workflow

Start with [your first workflow](python-workflows.md). It covers defining
steps, running them, resuming, and inspecting saved results.

For more control, see [step controls](workflow-steps.md): pause for input,
set deadlines, provide stable keys, and run hooks before unrecorded steps.

Halcyon ships in Vera's `python/` package and uses `vera.workflow` imports.
It requires Python 3.11 or newer. The workflow runtime itself has no
third-party package dependencies.
