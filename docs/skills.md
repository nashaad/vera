---
title: "Use and write skills"
description: "Run, write, and turn off reusable instructions for recurring tasks, or create a reusable agent definition."
---

# Use and write skills

A skill packages instructions for a recurring task in a directory containing
`SKILL.md`. Vera discovers bundled skills, skills from enabled extensions, and
skills you write for your home or a project. The current definition determines
which skills are available.

## Run a skill

Enter the skill's slash command followed by the task. For an installed skill
named `consult`, for example:

```text
/consult should we raid the reef or the wreck first?
```

Allowed skills appear in the command palette under skills. They do not need a
separate extension or command declaration.

Writing `$consult` in a message asks the model to read and follow that skill,
unless the skill [requires an explicit command](#require-an-explicit-command).

If a name conflicts with an existing slash command, the existing command wins
and Vera reports the collision. Rename the skill to expose its command.

## Write a skill

Create a directory named after the skill and put a `SKILL.md` file in it:

```text
~/.vera/skills/
└── loot-ledger/
    └── SKILL.md
```

`SKILL.md` starts with YAML frontmatter. The rest of the file is the
instructions Vera follows when the skill runs:

```markdown
---
name: loot-ledger
description: Tally the crew's plunder and add it to the ledger.
---

Read every file in `hoard/` that changed today. List each item with the crow
who took it, then append the totals to `ledger.md`. Shiny things go first.
```

- `name` is required and must match the directory name. Use lowercase
  letters, numbers, and hyphens, with no hyphen at either end and no two in a
  row. The skill's command is `/` followed by its name, here `/loot-ledger`.
- `description` is required. The command palette shows it, and the model reads
  it to decide when the skill applies. Put it in quotes if it contains a colon.
- `disable-model-invocation` is optional. See
  [Require an explicit command](#require-an-explicit-command).

The command and any text after it, as in `/loot-ledger only the gold`, are
sent as your message. Vera does not paste the instructions in: the model reads
`SKILL.md` with the read tool, and your text is not substituted into the file,
so write the instructions to work with or without it.

### Choose where it lives

| Directory | Available |
| --- | --- |
| `~/.vera/skills/` | In every project. |
| `.vera/skills/` in the project root | In that project only. |

The project root is the folder Vera runs in, the same folder it reads
`AGENTS.md` from. In a git worktree, that is the worktree. See
[Files in a project](config-reference.md#files-in-a-project).

Skills load in this order: bundled with Vera, enabled extensions, your home,
then the project. When two skills share a name, the later one replaces the
earlier one and Vera reports the replacement as a warning. A project
`loot-ledger` replaces your home `loot-ledger` in that project.

To ship skills with an extension, see
[Contribute skills](extension-apis.md#contribute-skills).

### See the change

A new skill's command appears after the next completed turn, or when you
attach or switch conversations. Vera does not need a restart. If you add a
skill while idle, send any message first, then type its command.

Open `/customize` and choose Skills to confirm it loaded. A skill that fails to
load is left out while the others still load, and the reason appears above the
list, such as a name that does not match its directory. Replacement warnings
appear there too.

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

## Turn a skill off

Add a top-level `disabled_skills` list to `~/.vera/config.json` with the
names to turn off. Vera reads it only from the home config, and the change
applies the same way as an edited skill.

```json
"disabled_skills": ["loot-ledger", "crow-*"]
```

A trailing `*` matches every name that starts with the text before it, and
`["*"]` turns off every skill. A `*` anywhere else makes the config invalid.
This works for bundled and extension skills too.

A disabled skill has no slash command, and the model cannot load it.
`/customize` still lists it under Skills, marked `disabled by disabled_skills`.

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
