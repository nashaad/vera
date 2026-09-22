---
title: "Vera"
description: "A durable, open agent runtime and harness. Use the SDK library and workflow to script in Python and build your application."
layout: homepage
---

<section class="home-section" id="workflows">
<div>

## Workflows in plain Python

Write each step as a function. Steps retry, branch like any Python, pick up
after a crash, and can stop to ask a person.

<p class="vera-warning">Workflows are under heavy development, and the API will change.</p>

[Write your first workflow](python-workflows.md)

</div>
<div>

```python
from vera.workflow.api import ask, step, workflow

@step(retries=3)
def fetch(url: str) -> str: ...

@step
def publish(page: str) -> None: ...

@workflow
def review(url: str) -> str:
    page = fetch(url)
    if ask("Publish this page?") == "yes":
        publish(page)
    return page
```

</div>
</section>

<section class="home-section" id="install">
<div>

## Install

From a Vera checkout, install dependencies and activate a local release.
Then run `vera` in your project directory.

[Installation instructions](installation.md)

</div>
<div>

```sh
bun install
bun run install:local
```

[Connect a provider](first-run-setup.md) to start using a model.

</div>
</section>
