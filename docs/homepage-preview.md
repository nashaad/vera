---
title: "Homepage"
description: "Vera connects models to tools and manages conversations, context, permissions, and saved work."
draft: true
layout: homepage
replay: model-picker
---

# Vera is an agent harness.

<section class="home-section">
<div>

## Work in your project

Ask a question, investigate a problem, or make a change. Choose the model,
set its access, and review the work in the same conversation.

[Start a conversation](getting-started.md)

</div>
<div>

- **Models:** connect a provider, choose a model, and save favourites.
- **Tools and permissions:** control what the selected role can do.
- **Context:** inspect what is loaded and provide project instructions.
- **Saved work:** return to a conversation or keep it running while you switch.

</div>
</section>

<section class="home-section" id="halcyon">
<div>

## Halcyon workflows

Halcyon is Vera's workflow framework. Write Python functions as steps and
save their results in a journal. On resume, completed steps return their
recorded results.

Your code decides the order, branches, and loops.

[Write your first workflow](python-workflows.md)

</div>
<div>

```python
from pathlib import Path
from vera.workflow.api import step, workflow

@step
def read_note(path: str) -> str:
    return Path(path).read_text()

@workflow
def collect(paths: list[str]) -> list[str]:
    return read_note.map(paths)
```

Completed results survive restarts. A step interrupted before its result is
saved can run again. [How workflow runs work](halcyon.md).

</div>
</section>

<section class="home-section" id="install">
<div>

## Install Vera

From a Vera checkout, install dependencies and activate a local release.
Then run `vera` in your project directory.

[Installation instructions](installation.md)

</div>
<div>

```sh
bun install --frozen-lockfile
bun run install:local
```

[Connect a provider](first-run-setup.md) to start using a model.

</div>
</section>
