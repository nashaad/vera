---
title: "Configure automatic approval"
description: "Choose the model that reviews actions when permission rules need a decision."
---

# Configure automatic approval

In auto mode, Vera checks tool actions against permission rules. When those
rules cannot decide, a separate classifier evaluates whether to allow the
action. If it cannot return a usable decision, Vera asks you whether to run
the action.

An action the rules allow runs without a notice. So does a low-risk allow
from the classifier; the end of the turn shows how many there were, such as
`2 auto-approved`. Other classifier decisions add a line to the conversation.
An allow line sits just above the action it allowed.

When the classifier allows a tool from an extension, the rest of the
conversation runs that extension operation without asking it again, the same
as answering Yes, for this chat on a prompt. Vera's own operations, such as `git.push`,
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
In auto mode, a classifier denial asks whether to run the action once. The
approval shows the classifier model when known, the risk and reason, and offers
only **Yes, this time** and **No**. It accepts no typed feedback and creates no
permission grant. **Yes, this time** runs that exact action, resets the denial
streak, and records the ordinary result in the conversation history.

**No**, no answer within 60 seconds, or a run without an approver, such as
`vera -p`, leaves the classifier denial in effect and the turn continues. The
terminal's action row reads **Did not run**, followed by a **CLASSIFIER DENIED**
error with the risk and reason. A subagent request follows the existing approval
relay. A detached resident waits as it does for other approvals. At most 16
denial approval cards can be pending in one session; further denials remain
denied without a prompt. The denial is saved with the conversation. When you
reopen it in the terminal or desktop, the withheld action and the classifier's
risk and reason can be seen again. On desktop, a very long turn can split the
action and result across history pages, leaving the denial out. In the terminal,
it looks like this:

```text
Did not run
└ rm -rf ~/crows-nest

× CLASSIFIER DENIED · bash did not run
  High risk: Deletes the crow's nest outside the workspace.
```

When the classifier cannot answer, Vera asks you the way ask mode does, so one
failed classification does not stop the turn. The prompt names the action and
says what went wrong, with a **Fix** line under it:

```text
Run this command?
The classifier, deepseek/deepseek-flash, did not answer within 60s, so Vera is asking you instead.
Fix: open /settings, then Classifier, and pick another model, or set a failsafe there.
$ mkdir -p build && bun test
```

A spent subscription usage limit shows when it resets. A rate limit with no
reset time says to wait a minute and send again, or pick a model on another
provider. A timeout shows how long Vera waited. When no classifier model is
set, the prompt says so. Whatever you choose applies to that action; Yes, for
this chat and Yes, and always allow also stop later matching actions from being
classified. If nobody answers, the action is denied after a minute and the
model carries on without it.

The one failure that ends the turn is an action Vera cannot describe to the
classifier. It shows as a **CLASSIFIER FAILED** error that names the tool,
says the action did not run, and gives a **Fix** line.

Cancelling a turn while the classifier works is not a failure. It says the turn
was cancelled before the classifier answered, so the action did not run, and
that note is saved too.

The classifier receives user turns and tool calls. It does not receive tool
results.

## Recover from an unavailable classifier

A failsafe handles a classifier that errors or cannot be reached. Set it in
`/settings` under Classifier. If the provider itself is the problem, such as
an exhausted credit balance or a spent usage limit, pick a classifier on another
provider there or in Defaults. While the classifier is unavailable, each
action that needs automatic approval arrives as a prompt, so you can keep
working. Each prompt says what failed and where to change it.

## Inspect review logs

Each classifier request is recorded in
`~/.vera/runtime/logs/reviewer.jsonl`. The log includes the prompt, response, grades, and latency.

> [!WARNING]
> This is a private diagnostic file containing conversation material sent to
> the classifier provider. Treat it as sensitive when sharing a report.
