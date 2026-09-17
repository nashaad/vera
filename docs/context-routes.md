---
title: "Load instructions for specific files"
description: "Use context routes to supply project guidance when Vera reads matching files."
---

# Load instructions for specific files

Context routes connect parts of your codebase to the instructions needed to
work on them. For example, reading a file under `src/api/` can load your API
conventions before Vera makes its next request.

Routes run automatically after a successful file read. Skills are different:
Vera or the user chooses when to invoke them.

## Create a route

Create the router and its instruction file in your project:

```text
.vera/
  context-routes.yaml
  context-routes/
    api.md
```

Put the API instructions in `api.md`. Then add this route to
`.vera/context-routes.yaml`:

```yaml
version: 1
routes:
  - trigger:
      read: src/api/**
    consequence:
      inject: context-routes/api.md
```

The payload path is relative to `.vera/` and must stay inside
`context-routes/`. Both files can be committed with the project.

## When instructions load

After Vera successfully reads `src/api/handler.ts` or `src/api/nested/db.ts`,
it includes `api.md` in the next request during that turn. Reading a file
outside that pattern does not load it.

Each payload loads at most once until the conversation compacts. It can load
again after compaction. Search, listing, editing, writing, and failed reads
do not trigger a route.

## Check the format

Use numeric `version: 1`. Omitting the version is accepted as version 1 for
compatibility. An unsupported or non-numeric version disables the file's routes.

Only read triggers run. An `about_to_run` entry can be stored but has no effect.
Mentioning a topic or invoking a skill does not trigger a context route.
