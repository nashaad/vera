# Vera definition format

One Markdown file defines one role. The filename, without `.md`, is its name:
lowercase letters, numbers, and single hyphens, such as `meeting-reader.md`.
There is no `name` frontmatter field. The body contains the instructions.

## Scope

- Project: `<project-root>/.vera/agents/<name>.md`.
- Across projects in the current Vera home: `<current-vera-home>/agents/<name>.md`.
  Establish the active home before proposing this path. Do not assume `~/.vera`
  during a development instance or another relocated home.
- Project definitions override home definitions with the same name. Home
  definitions override extension definitions. Use a fresh name for a new role.

The `subagent` tool's catalog lists reusable definitions. `agent_roster` lists
live participants, not definitions. `/agent` selects a definition for the current
conversation; it does not start a child or switch the conversation's model.

## Fields

| Field | Meaning |
|---|---|
| `description` | A concise statement of when to use this definition, at most 1,024 characters. |
| `tools` | Exact allowed tool names. Omitted means all available tools; `[]` means none. |
| `skills` | Exact allowed skill names. Omitted means all available skills; `[]` means none. |
| `posture` | A permission mode: `readonly`, `ask`, `auto`, or `full_access`. It is not a tone or writing style. Restrictions cannot widen the session's access. |
| `forbidden_access` | Permission modes that cannot be selected while this definition is active. |
| `subagent_assignment` | The named model assignment governing delegated launches, such as `eco`. |
| `default_pair` | Optional preferred library entry: `{name: "existing-entry", effort: "supported-effort"}`. It must remain within the permitted assignment. Usually omit it. |

Omit `context` and `nudges` for ordinary definitions. Only `context: full` is
supported; nudges are interactive notices, not instructions for doing the job.
Unknown frontmatter fields are rejected. Do not add `model`, `agent_type`, or
`reasoning_effort` fields.

The bundled check validates built-in permission modes. If the user requests a
custom mode, explain that it needs verification against the active installation;
do not claim this check validates it. Put wording such as "factual" in the body,
never in `posture`.

A bound assignment replaces the ordinary Subagents list for delegated launches.
Its entries need not also appear under Subagents. If it is unset or unavailable,
the launch fails; the parent conversation's model is not a fallback. With no
binding, the existing Defaults > Subagents rules apply. A definition does not
configure either assignment.

## Example: reading meeting material on eco

Save as `meeting-reader.md`. Adapt the job and boundaries to the user's request.
The tools below are Vera's built-in file reading, search, and listing tools.

```markdown
---
description: "Find decisions, owners, and unresolved questions in meeting material, with references."
tools: [read, grep, list]
skills: []
posture: readonly
forbidden_access: [auto, full_access]
subagent_assignment: eco
---
Read the supplied meeting material without changing it. Locate decisions,
owners, and unresolved questions. Distinguish an explicit decision from a
suggestion, and identify later material that supersedes an earlier statement.
Return a concise account with precise source references. State when an owner
or decision is not recorded rather than guessing.
```

Read-only instructions need matching restrictions. For file investigation,
`read`, `grep`, and `list` avoid shell access and writing tools. Do not invent
tools such as `glob` or `ls`. For other sources, use only the installed tools
that provide the required access. A role that must not delegate needs to exclude
both `subagent` and shell execution tools.
