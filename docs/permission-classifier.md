---
title: "Configure automatic approval"
description: "Choose the model that reviews actions when permission rules need a decision."
---

# Configure automatic approval

In auto mode, Vera checks tool actions against permission rules. When those
rules cannot decide, a separate classifier evaluates whether to allow the
action. If it cannot return a usable decision, the tool does not run.

The classifier is separate from the model working on your task. Changing the
conversation model does not change the configured classifier.

## Choose a classifier

1. Open `/settings` and choose **Defaults**.
2. Under Dedicated jobs, choose **classifier**.
3. Select its model and reasoning effort.

The assignment applies to the next classification, including in existing
conversations. No host restart is needed.

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

## Add a second review

By default, each reviewed action makes one classifier request. To give
uncertain decisions a second pass, enable `two_tier`:

```json
{
  "reviewer": {
    "model": "provider/model-id",
    "provider": "openrouter",
    "two_tier": true,
    "escalation_reasoning_effort": "high"
  }
}
```

Replace the example route with a connected model. With two-tier review, low
and medium risk allows finish after the first pass. Other decisions get a
second pass on the same model by default.

Use `escalation_model` and optionally `escalation_provider` to choose another
model for the second pass.

### Recover from an unavailable classifier

A failsafe handles a reviewer that errors or cannot be reached. It is separate
from a second opinion. Configure it in `/settings` under Classifier, or use
`fallback_model`, `fallback_provider`, and `fallback_reasoning_effort` in the
reviewer configuration.

## Inspect review logs

Each classifier request is recorded in
`~/.vera/runtime/logs/reviewer.jsonl`. Two-tier review records two requests.
The log includes the prompt, response, grades, and latency.

This is a private diagnostic file containing conversation material sent to
the classifier provider. Treat it as sensitive when sharing a report.
