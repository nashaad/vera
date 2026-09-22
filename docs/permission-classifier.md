---
title: "Configure automatic approval"
description: "Choose the model that reviews actions when permission rules need a decision."
---

# Configure automatic approval

In auto mode, Vera checks tool actions against permission rules. When those
rules cannot decide, a separate classifier evaluates whether to allow the
action. If it cannot return a usable decision, the tool does not run.

An action the rules allow runs without a notice. Only the classifier's
decisions add a line to the conversation.

The classifier is separate from the model working on your task. Changing the
conversation model does not change the configured classifier.

> [!NOTE]
> A managed service is on the roadmap. It will be opt-in and will run Vera
> fully automatically at a choice of usage tiers. Vera will pick the models,
> including the classifier, to meet the tier's expected performance, for
> users who would rather not tune models themselves.

## Choose a classifier

1. Open `/settings` and choose **Defaults**.
2. Under Dedicated jobs, choose **classifier**.
3. Select its model and reasoning effort.

The assignment applies to the next classification, including in existing
conversations. No host restart is needed.

> [!WARNING]
> A weak classifier can approve an action it should have blocked. Use a model
> at the level of Claude Haiku 4.5 or better. To find one, set the
> **Intelligence cutoff** in the model picker's Filter and sort (see
> [Models](models.md)) so that only well-ranked models are listed.

### Override the default

The **Classifier** entry in `/settings` can set a primary and optional failsafe
model. **Use configured default** clears this override and returns to the
available default assignment or session-model fallback.

The stored assignment key is `model_assignments.reviewer` for compatibility.
The interface calls the job classifier.

## Understand the result

An allow notice includes the assessed risk, authorization, and reason.
A denial says the action was denied. A timeout or provider error names the
tool and confirms that the action did not run.

The classifier receives user turns and tool calls. It does not receive tool
results.

## Recover from an unavailable classifier

A failsafe handles a reviewer that errors or cannot be reached. Configure it in
`/settings` under Classifier, or use `fallback_model`, `fallback_provider`, and
`fallback_reasoning_effort` in the reviewer configuration.

## Inspect review logs

Each classifier request is recorded in
`~/.vera/runtime/logs/reviewer.jsonl`. The log includes the prompt, response, grades, and latency.

> [!WARNING]
> This is a private diagnostic file containing conversation material sent to
> the classifier provider. Treat it as sensitive when sharing a report.
