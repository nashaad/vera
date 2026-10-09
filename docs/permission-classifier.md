---
title: "Configure automatic approval"
description: "Choose the model that reviews actions when permission rules need a decision."
---

# Configure automatic approval

In auto mode, Vera checks tool actions against permission rules. When those
rules cannot decide, a separate classifier evaluates whether to allow the
action. If it cannot return a usable decision, the tool does not run.

An action the rules allow runs without a notice. So does a low-risk allow
from the classifier; the end of the turn shows how many there were, such as
`2 auto-approved`. Other classifier decisions add a line to the conversation.
An allow line sits just above the action it allowed.

The classifier is separate from the model working on your task. Changing the
conversation model does not change the configured classifier.

> [!NOTE]
> A managed service is on the roadmap. It will be opt-in and will run Vera
> fully automatically at a choice of usage tiers. Vera will pick the models,
> including the classifier, to meet the tier's expected performance, for
> users who would rather not tune models themselves.

## Choose a classifier

1. Open `/models` and choose **Defaults**.
2. Under Dedicated jobs, choose **classifier**.
3. Select its model and reasoning effort.

The assignment applies to the next classification, including in existing
conversations. No host restart is needed.

> [!WARNING]
> A weak classifier can approve an action it should have blocked. Use a model
> at the level of Claude Haiku 4.5 or better. To find one, set the
> **Intelligence cutoff** in the model picker's Filter and sort (see
> [Models](models.md)) so that only well-ranked models are listed.

### Set a failsafe

The **Classifier** entry in `/settings` sets the same classifier as Defaults,
plus an optional failsafe model. Changing the classifier in Defaults keeps the
failsafe. **Use configured default** clears the classifier, so the session
model reviews actions instead.

The stored key is `model_assignments.reviewer`: the first model is the
classifier and the second is the failsafe. The interface calls the job
classifier. The `reviewer` block in `config.json` holds only review settings
such as `timeout_ms` and `two_tier`. A `reviewer` block that names a model
fails to load, with a message that says to remove it.

## Understand the result

An allow notice for a medium-risk or higher action includes the assessed
risk, authorization, and reason. Low-risk allows are counted instead. While
the turn runs, the status line shows the count. Click the count at the end of
the turn to list each auto-approved action with the classifier's reason, and
click it again to close the list. Ctrl+T opens or closes every list along with
the tool details. The count and its list are not saved, so a reopened
conversation does not show them.
A denial says the action was denied. A timeout or provider error names the
tool, confirms that the action did not run, names the classifier model, and
points to `/settings` then **Classifier** to pick another.

The classifier receives user turns and tool calls. It does not receive tool
results.

## Recover from an unavailable classifier

A failsafe handles a classifier that errors or cannot be reached. Set it in
`/settings` under Classifier. If the provider itself is the problem, such as
an exhausted credit balance, pick a classifier on another provider there or in
Defaults.

## Inspect review logs

Each classifier request is recorded in
`~/.vera/runtime/logs/reviewer.jsonl`. The log includes the prompt, response, grades, and latency.

> [!WARNING]
> This is a private diagnostic file containing conversation material sent to
> the classifier provider. Treat it as sensitive when sharing a report.
