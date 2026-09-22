---
title: "Use skills"
description: "Run reusable instructions for recurring tasks, or create a reusable agent definition."
---

# Use skills

A skill packages instructions for a recurring task in a directory containing
`SKILL.md`. Vera discovers bundled skills and skills installed for your home
or project. The current definition determines which skills are available.

## Run a skill

Enter the skill's slash command followed by the task. For an installed skill
named `consult`, for example:

```text
/consult should we raid the reef or the wreck first?
```

Allowed skills appear in the command browser under skills. They do not need a
separate extension or command declaration.

If a name conflicts with an existing slash command, the existing command wins
and Vera reports the collision. Rename the skill to expose its command.

## Require an explicit command

By default, Vera can choose a relevant skill automatically. To require the
user to invoke it, add this to the skill's frontmatter:

```yaml
---
name: deploy
description: Deploy the current service.
disable-model-invocation: true
---
```

This skill runs only after `/deploy`. Mentioning its name, writing `$deploy`,
or asking another agent to use it does not authorize invocation. Permission
lasts for that command's turn.

### Tools and permissions still apply

Invoking a skill does not add tools or change approval mode. The active
definition's skill restrictions are checked when the command runs, including
after a queued definition change.

Explicit invocation controls skill loading. It does not make the skill file
secret from file or shell tools that already have permission to read it.

## Create an agent definition

Use the included `/create-agent` skill to turn a recurring job into a named
role:

```text
/create-agent A reader that finds decisions and owners in meeting notes. Use eco.
```

Vera drafts a definition, shows where it will be saved, explains its model
assignment, and proposes a small trial. Choose to save and try it, revise it,
or cancel. Project scope is proposed unless you ask for reuse across projects.
An existing definition is replaced only with your approval.

### Save and try the result

After approval, Vera saves the definition, validates its format and permission
modes, and runs the agreed trial. Validation and trial results are reported
separately. If a model assignment is missing, the definition stays saved;
configure the assignment in Defaults, from `/models`, before trying again.

If you need to continue in another turn, invoke `/create-agent` again with your
decision. `/create-agent save` approves the latest complete draft and displayed
trial. `/create-agent try <name>` tries a saved definition.

Select the saved role with `/agent`, or ask Vera to delegate to it by name.
The creation skill does not change model assignments or other settings.
