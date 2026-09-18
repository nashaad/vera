---
title: "Watch workflow runs"
description: "See every Halcyon run, its attempts, and how long each step took."
---

# Watch workflow runs

The runs page lists the Halcyon workflows that have run in your Vera home. It
is served by the same local helper as [Usage and cost](usage.md): open the menu
at the top left and choose **Runs**, or go to `/runs` on the helper's address.

It reads file journals under `workflows/` in your Vera home. Runs written to a
SQLite journal or to a directory of your own do not appear.

## Read the list

| Column | Meaning |
| --- | --- |
| Workflow | The workflow name, with the run ID under it. |
| Status | `ok`, `failed`, `running`, `suspended`, `cancelled`, or `crashed`. |
| Started | When the first attempt began. |
| Duration | Wall time of the last attempt. Blank while it is still open. |
| Steps | Steps the journal recorded, so steps a resume would skip. |
| Tries | Every call of a step, including the ones that failed and were retried. |
| Cost | What the recorded model calls reported, or blank when none did. |

A run whose files cannot be read is listed as `unreadable` rather than hidden.

## Read one run

A run opens into its attempts, one per `.run()` or `.resume()`, each showing
the host and process that ran it. Under each attempt its steps are drawn on a
shared timeline, so a step that waited on another is visible as a gap.

Bars are colored by outcome, and a failure prints its message under the bar. A
step that never ended is drawn hatched and labelled `open`: its process died
inside that step, so there is no duration to show.

A model call the step recorded is drawn indented under it, named after the
model, with its tokens and what it cost. See
[Record what a model call used](python-workflows.md#record-what-a-model-call-used).

Steps and tries count different things. The journal records a step once, when
it succeeds, because that is the value a resume replays. A step that failed
twice before succeeding is one step and three tries.

To do the same from a terminal, see
[Inspect recorded progress](python-workflows.md#inspect-recorded-progress).
