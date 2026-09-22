---
title: "Standing instructions"
description: "Save short preferences that apply across matching conversations."
---

# Standing instructions

A nudge is a short reminder Vera repeats every few turns, so the model keeps
following it.

- **Why:** models have limited attention. An instruction from early in a long
  conversation gets buried, and the model starts to forget it.
- **What to use it for:** things you want kept up all the time, such as
  concise answers or test results in every summary.
- **Where it applies:** everywhere, in one workspace, or for one agent.

Nudges add guidance. They do not change tools or permissions.

## What a nudge does

On a turn where a nudge applies, Vera adds its text as a hidden message right
after yours. The model reads it with your request. The transcript and exports
leave it out, and the conversation keeps it where it was added.

<div data-widget="screen-steps" data-steps="standing-nudge"></div>

Adding nudges does not break the provider's prompt cache (the KV cache).
Every earlier message, including earlier nudges, is sent again exactly as
before, so the provider reuses its cached work and only reads the new turn
fresh.

## Create a nudge

1. Run `/nudges`, or choose **Standing nudges** from Ctrl+P.
2. Press N to create a rule.
3. Enter a name and an instruction of up to four lines.
4. Choose when it applies and how often.
5. Select **Save changes** and press Enter.

Changes apply on the next user turn. A workspace rule uses the full workspace
path and initially selects the current workspace. Agent matching uses the
exact definition name.

### Choose a frequency

**Every turn** applies the preference on each matching turn. A number from
2 to 10 repeats it at that interval, beginning with the first matching turn.
For example, 3 applies on turns 1, 4, 7, and 10.

Each conversation, including a delegated conversation, counts independently.

## Edit, disable, or delete

| Key | Action |
| --- | --- |
| Enter on a rule | Open its form. |
| Space on a rule | Enable or disable it and save. |
| N | Create a rule. |
| D | Open the permanent-deletion confirmation. |
| Escape | Return or close. |

In the form, Tab or Up/Down moves between fields. Type in Name, Instruction,
Agent, and Workspace. Space changes Status, Apply when, and Frequency.
Left/Right moves the caret in text fields.

Enter adds a line inside Instruction and advances from the other text fields.
Up/Down leaves a multiline Instruction at its first or last line. Use Page
Up/Page Down or the wheel to inspect a long match value.

## Know when a nudge applies

A **Nudge on** notice above the composer names enabled rules that match the
conversation. It remains visible between scheduled applications because the
rules are still enabled.

Rules are saved in `~/.vera/standing-nudges.json`, created on the first save.
An invalid file produces an error with its path. Form errors stay in the form
so you can correct them before saving. Deletion cannot be undone.
