# Agents

An agent is a thing you wear: instructions, the tools and skills it may reach,
and how it asks before acting. It is not a model. Models and reasoning effort
are dials, set from the dial strip.

```
/agent              open the picker, and see what is live
/agent reviewer     wear one by name
```

Wearing is deliberate. The agent's instructions live in the cached part of the
prompt, so switching re-reads the prefix once — which is exactly why it is a
command and not a chord.

## Where agents live

```
~/.vera/profiles/<profile>/agents/<name>.md    yours
<workspace>/.vera/agents/<name>.md             the project's
```

Project beats profile beats anything an extension registered; a collision is a
notice at startup, not an error. The name comes from the filename.

`default` is virtual: all tools, all skills, the host's own posture, no pair of
its own. There is no `/agent off` — `default` is the bottom. Writing your own
`agents/default.md` shadows it, which is what makes it editable.

## Writing one

```markdown
---
description: read-only code reviewer
tools: [read, grep, ls, bash]
skills: [code-review]
posture: readonly
forbidden_access: [auto, full_access]
default_pair: { name: sol, effort: medium }
nudges:
  - on: write
    text: "This agent is read-only. /agent default to allow writes."
---
You are a code reviewer. Read, do not modify. Report findings with
file:line references, most severe first.
```

| key | meaning |
| --- | --- |
| `description` | one line, shown in the picker |
| `tools` | **omitted means every tool, present and future.** A list is a restriction to exactly those names |
| `skills` | same rule, kept separate |
| `posture` | a permission mode by name. Omitted means the host's current default, resolved fresh each turn |
| `forbidden_access` | permission modes this agent cannot coexist with. Choosing the agent falls back to an allowed posture; explicitly choosing a forbidden permission switches to `default` and explains why |
| `default_pair` | a pool name and optionally an effort. Adopted only if you have not dialled the session yourself |
| `nudges` | what to say when a tool is refused. Interactive sessions only |

Everything else is a parse error, named rather than ignored: an unknown key, a
posture no mode answers to, a malformed nudge. `context` is reserved and
accepts only `"full"` today.

## What scope actually means

A tool the worn agent does not list is not described to the model, and a call
to it is denied by name before any hook runs. A skill it does not list is
absent from the catalog and refused by `skill_script`.

Skill scope is catalog visibility and script execution, and that is all: an
agent with a general `read` tool can still open a skill's files on disk. That
is the same trust boundary as any other file, and it is documented rather than
defended.

## Nudges

A nudge is appended to a refusal, never substituted for it, and only for
refusals the agent could plausibly explain:

| refusal | nudge |
| --- | --- |
| the agent's own scope | fires |
| the permission mode | fires |
| the automatic reviewer | fires |
| you said no | silent — you know why |
| an extension's hook blocked it | silent — the hook wrote its own message |

Each nudge fires at most once per tool between your messages.

## Wearing, precisely

`/agent <name>` joins the queue behind whatever is already waiting. A prompt
you sent before the switch runs under the old agent; a prompt you send after it
runs under the new one. No turn is ever half one agent and half another. If it
is queued behind work, the transcript says so, and the confirmation appears
when it actually applies.

The pair follows the agent only if you have not dialled the session yourself.
If you have, the override survives the switch — that is the difference between
a dial and a default. `[d]` in the picker writes the session's current pair
into the highlighted agent's file, which is the only write into an agent file
any command does.

## Resume

| what resume finds | what it does |
| --- | --- |
| the agent, unchanged | wears it, silently |
| the agent, edited since | wears it **as it is now**, and says what changed |
| no such agent any more | wears `default`, and says so |
| no record (an older session) | `default`, no notice |

Agents are by reference. A definition you edited is the definition you get; the
notice is what keeps that from being a silent change of what a session can do.

## Subagents

The `subagent` tool takes an optional `agent`. The child wears it, and:

- **Model.** An explicit `model`/`reasoning_effort` wins; the agent's
  `default_pair` is next; the existing subagent ladder is what runs when
  nobody said anything. A spawn without `agent` is unchanged.
- **Tools and skills** are the intersection of the agent's lists and what the
  spawning session could already reach. Delegation narrows and never widens:
  an agent that grants a tool the parent does not have does not hand it over.
- **Posture** is clamped per action rather than by intersecting modes — modes
  are ordered predicate programs, not levels, so "the intersection of two
  modes" names nothing. Each action is evaluated under the child's mode and
  the parent's, and the stricter outcome wins. The parent's grants and
  preferences do not propagate: a grant you gave one session is not a grant to
  everything it spawns.
- **Nudges** on a spawned agent are a validation error. A subagent has no
  surface to show one on, and failing loudly beats doing nothing quietly.

`context` does not apply: children start fresh, and `"full"` is the only value
v1 accepts.

## Extensions

An extension can register an agent (`agents.register`) and, on the client side,
a compose-time suggester (`client.compose.suggester`) that offers to wear it.
Core never guesses intent from what you are typing; a suggester does, and it
exists only inside an extension you installed. See `examples/extensions/plan`
and `examples/extensions/explore` for the pattern.

Extension-registered agents are read-only definitions: a file of the same name
shadows them, and `[d]` refuses to write into them because there is no file of
theirs to write.
