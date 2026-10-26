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

When the classifier allows a tool from an extension, the rest of the
conversation runs that extension operation without asking it again, the same
as answering Session on a prompt. Vera's own operations, such as `git.push`,
are classified on every call. **Review granted permissions** in Ctrl+P lists
and removes these grants.

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
failsafe. **Use the session model** clears the classifier and its failsafe,
so the session model reviews actions instead.

The stored key is `model_assignments.reviewer`: the first model is the
classifier and the second is the failsafe. The interface calls the job
classifier. The `reviewer` block in `config.json` holds only review settings
such as `timeout_ms` and `two_tier`. A `reviewer` block that names a model
fails to load, with a message that says to remove it.

## Understand the result

An allow notice for a medium-risk or higher action includes the assessed
risk, authorization, and reason. Low-risk allows are counted instead. While
the turn runs, the status line shows the count. Click the count at the end of
the turn to list each auto-approved action with the classifier's reason under
it, and click it again to close the list. Long commands are cut short there;
the action's own tool row has the full command. An action shows no reason when
the classifier gave none. Ctrl+T opens or closes every list along with
the tool details. The count and its list are not saved, so a reopened
conversation does not show them.
A denial shows as a **CLASSIFIER DENIED** error that names the tool, the risk
level and the classifier's reason. The action's own row reads **Did not run**
over the full command, and the reason shows once, in the error under it. The
turn goes on, so the model can try another way. The denial is saved with the
conversation, so a reopened conversation shows it too:

```text
Did not run
└ rm -rf ~/crows-nest

× CLASSIFIER DENIED · bash did not run
  High risk: Deletes the crow's nest outside the workspace.
```

When the classifier cannot answer, the action does not run and the turn stops,
because every later action would be held up the same way. A **CLASSIFIER
FAILED** error names the tool, the classifier model, and what went wrong, with a
**Fix** line under it:

```text
× CLASSIFIER FAILED · write did not run
  The classifier, openai-codex/gpt-6-luna, is out of usage until 6:35 PM.
  Fix: open /settings, then Classifier, and pick a model on another provider, or set a failsafe there.
```

A spent subscription usage limit shows when it resets. A rate limit with no
reset time says to wait a minute and send again, or pick a model on another
provider. A timeout shows how long Vera waited. When no classifier model is
set, the error says so. The error is
saved with the conversation, so a reopened conversation shows it too. Cancelling
a turn while the classifier works is not a failure. It says the turn was
cancelled before the classifier answered, so the action did not run, and that
note is saved too.

The classifier receives user turns and tool calls. It does not receive tool
results.

## Recover from an unavailable classifier

A failsafe handles a classifier that errors or cannot be reached. Set it in
`/settings` under Classifier. If the provider itself is the problem, such as
an exhausted credit balance or a spent usage limit, pick a classifier on another
provider there or in Defaults. Then send the request again: the turn that hit
the failure has already stopped.

## Inspect review logs

Each classifier request is recorded in
`~/.vera/runtime/logs/reviewer.jsonl`. The log includes the prompt, response, grades, and latency.

> [!WARNING]
> This is a private diagnostic file containing conversation material sent to
> the classifier provider. Treat it as sensitive when sharing a report.
