---
title: "Usage and cost"
description: "Review spending, tokens, and delegated work across saved conversations."
---

# Usage and cost

Run `/usage` to open Vera's local usage page in your browser. It reads the
session files in your Vera home and summarizes past work. For reminders and
approval during active work, use [conversation budgets](budgets.md).

Model calls recorded by [Python workflows](python-workflows.md) in the Vera
home count toward the summary cards, the chart, and the model list. They do
not appear as conversations in the table. The `/runs` page shows them per run.

The page is served locally by the helper started with your host. Opening it
leaves your conversation running.

## Choose a time range

The page starts with the last seven days. Choose Today, 30 days, or All at the
top. All reads every session file and can take longer. Previously loaded ranges
can be reused more quickly.

### Read the summary

The summary cards cover the entire time range. Filters on the conversation
table do not change these totals.

| Card | Meaning |
| --- | --- |
| Spend | Reported billed cost plus available estimates, with unpriced calls counted separately. |
| Requests | Recorded model calls, including compaction and classification when usage was saved. |
| Tokens | Input plus output tokens, with each shown separately. |
| Cache hit | Cached input as a proportion of input tokens. |
| Blended $ / M | Priced spending per million tokens. Blank when there are no tokens. |

Comparisons use the preceding window of the same length. All has no previous
window. Cache-hit change is measured in percentage points.

For ranges longer than Today, the chart shows daily spending by model.
The legend lists the top three models and groups the rest as Other.

## Find a conversation

Filter the table by workspace, kind, or model. Model searches match model IDs,
not conversation titles. Choose a model from the list to restrict results to
that exact provider/model route; clear the field to include all models.

Click a column heading to sort. Numeric columns start highest first; names
start A to Z. Cost is the default, with newer conversations breaking ties.
The table shows 25 rows per page.

### Inspect delegated work

Click a conversation to see its own work and work it launched:

| Field | Includes |
| --- | --- |
| Calls and Own | This conversation's recorded calls and cost. |
| Children | Work in conversations it launched. |
| Cost | Own and child work combined. |

The detail page includes models, tools, launched sessions, and the selected
conversation's calls. Child calls appear in Children and Models, rather than
in the parent's Calls list. The transcript remains in Vera.

Use **Usage** to go back to the overview, or the back link to return one level.

## Reported, estimated, and unpriced costs

| Label | Meaning |
| --- | --- |
| Reported | Cost billed by the provider for that call. It does not change with list prices. |
| Estimated | Tokens multiplied by current OpenRouter list rates. The estimate can change when those rates change. |
| Unpriced | No billed cost and no usable rate. Vera leaves the dollar amount blank. |
| Mixed | A row combines pricing states. The dollar figure contains the amounts Vera can calculate. |

Local models and subscription routes may be unpriced. The footer separates
reported cost, estimates, and unpriced calls. If any estimate is present, the
page labels the rate basis as current OpenRouter rates.

## If the page does not open

If the local helper, called the annex, is unavailable, `/usage` reports that
and asks you to restart the host. It does not start a replacement helper.

If the TUI itself says disconnected, use the
[host recovery instructions](troubleshooting.md#the-client-lost-its-host).
Opening usage normally does not disconnect the TUI.
