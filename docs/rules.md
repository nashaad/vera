---
title: "Rules"
description: "Standing instructions Vera loads at the start of a session, or when it reads a file you scope them to."
---

# Rules

A rule is a markdown file holding instructions Vera should follow. Rules live
in two places:

```text
~/.vera/rules/       your rules, for every project
<project>/.vera/rules/   the project's rules
```

Both directories are flat. Vera does not look in subdirectories, and it does
not look for rule files next to your code.

## Always-on rules

A rule with no frontmatter is always on. It joins the system prompt at the
start of the session and stays there.

```markdown
# Tone

Write plain sentences. Conclusion first.
```

Always-on rules render in this order: your rules, then `AGENTS.md` and
`AGENTS.local.md`, then the project's rules. Within a directory, rules sort by
file name.

## Rules scoped to paths

Frontmatter with a `paths:` list scopes a rule to the files it covers. The
rule stays out of the system prompt and arrives when Vera reads a matching
file.

```markdown
---
paths:
  - "src/api/**"
  - "src/api/*.test.ts"
---

# API conventions

Every handler validates its input before touching the database.
```

Globs match paths relative to the project root. `*` matches within one path
segment, `**/` matches any number of leading directories, and a trailing `**`
matches the rest of the path.

## When a scoped rule arrives

After Vera successfully reads a matching file, the rule joins the next request
in that turn. A rule arrives at most once until the conversation compacts, and
can arrive again after that. Search, listing, editing, writing, and failed
reads do not bring a rule in.

## See what applies

```console
$ vera rules which src/api/handler.ts
Rules for src/api/handler.ts:
  always      <home>/rules/tone.md
  src/api/**  .vera/rules/api.md
```

The command reads the rule files and reports; it changes nothing.

## Limits

A rule file larger than 128 KB is skipped. Always-on rules are capped at
256 KB per scope. A file whose frontmatter is not a `paths:` list is skipped,
and Vera reports it rather than failing the session. Unknown frontmatter keys
are ignored.
