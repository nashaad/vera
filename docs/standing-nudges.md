---
title: "Standing instructions"
description: "Save short preferences that apply across matching conversations."
---

# Standing instructions

Standing nudges are short preferences Vera adds to matching user turns. Use
one for a preference such as concise answers or including test results in a
summary. Nudges belong to your Vera home and can apply everywhere, to one
definition, or to one workspace.

They add guidance alongside your message and project instructions. They do
not change tools or permissions.

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
