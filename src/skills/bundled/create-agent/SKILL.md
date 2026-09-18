---
name: create-agent
description: "Create a reusable Vera agent definition from a job description. Draft its instructions, tools, scope, and model assignment, review it with the user, then save, validate, and try it."
disable-model-invocation: true
---

# Create an agent

Help the user turn a recurring job into a reusable definition. Keep the language
about the work they describe, whether it involves documents, research, planning,
code, or something else. Use the existing Markdown definition format.

Read `references/definition.md` first. It supplies the format; do not search
Vera's source code or read the validator to rediscover it. Available definition
names are already listed on the `subagent` tool. Use the tools already available
in this session; this skill grants no additional access.

## Draft

1. Use the request and conversation to identify the job, expected result, and
   boundaries. Ask only about missing choices that change the result or access.
   Choose routine details such as a short name yourself and show them in the draft.
2. Check available definition names and the intended destination. Propose project
   scope unless the user requests reuse across projects. Never overwrite a file
   or shadow an existing definition without pointing it out and getting approval.
3. Draft a lowercase, hyphenated name; a one-sentence description of when to use
   it; focused instructions; explicit tool and skill lists; and any needed
   permission restriction. Use actual available tool and skill names.
4. Bind delegated work to an assignment only when the user wants that, such as
   `eco` for inexpensive investigation. Otherwise omit `subagent_assignment`.
   Do not guess a provider identifier, library entry, or reasoning effort.
5. Send the complete proposed Markdown file in a fenced code block in the chat,
   together with its destination, scope, governing assignment, and small trial
   task. This must be visible text, not private reasoning or a summary of fields.
   Do not request approval until you have shown the actual file contents.
6. Call `ask_user` in the same response after the visible draft, offering saving
   and running that trial, revising, or cancelling. Keep the review inside this
   invocation instead of ending the turn with a question. Approval covers the
   displayed definition and trial only. If you must ask in text, tell the user
   to reply `/create-agent save` to approve, or `/create-agent <changes>` to revise.
   An ordinary "yes" on the next turn does not renew this skill's authority.

## Save and check

After approval, recheck the destination and save the approved text with the
ordinary file tools. Preserve unrelated content. Do not edit settings, model
assignments, standing instructions, or other definitions.

`/create-agent save` approves the most recent complete draft and its displayed
trial in this conversation. If both are present, continue here without asking
for the same approval again. If either is missing, present it before proceeding.

Validate the saved file using `skill_script` with these arguments:

```json
{"skill":"create-agent","script":"scripts/validate.sh","args":["/absolute/path/to/name.md"]}
```

`scripts/validate.sh` uses Vera's definition parser and requires a description
and instructions, and checks built-in permission mode names. It reads the file
without modifying it. Success does not establish tool availability, configured
assignments, custom permission modes, or task quality.
If the script is refused, report the refusal. Do not bypass it with a shell
command or a separate parser invocation.
If validation fails, report the error and fix only a mechanical formatting issue.
Show any change to meaning or access for approval before saving it.

## Try and report

Call `subagent` with the saved name and approved trial task. Use small supplied
sources or harmless sample material. Do not include publishing, messaging,
deletion, or changes to real work in a trial without specific approval.

If the definition is not yet visible, let the turn finish so the catalog can
refresh, then have the user continue with `/create-agent try <name>`. If the
launch fails because an assignment is missing or unavailable, report that
failure and point to `/models`; leave configuration changes to the user.
Do not substitute another definition or assignment to claim the trial passed.

Check the result against the agreed task and boundaries. Report the saved path,
what validation established, and the actual trial result, including the returned
agent, model, and reasoning effort. Distinguish saved, validated, and trial passed.
Tell the user they can select it with `/agent` or ask for it by name in chat.

For `/create-agent try <name>`, inspect the existing definition and agree on the
trial if the conversation does not already contain one. Do not recreate it.
