---
title: "Vera manual"
description: "Use Vera in a project and customize its behavior."
---

# Vera manual

Vera is a coding agent, built on its own agent harness and runtime.

- **For everyday use**\
  Ask it to research, search the web, use a browser, or sort through files.
- **For coding**\
  It reads and changes code in your project, within your permissions.
- **For app builders**\
  Put agents in your own software: call Vera from code, add tools, and define agents.
- **Harness**\
  The code that gives a model tools, context, and permission checks. Without it, a model can only reply with text; with it, the model can work with you and act on your system.
- **Runtime**\
  A host process that keeps conversations running and saved.

Start with [Getting started](getting-started.md) to connect a model and run
your first conversation.

> [!WARNING]
> **Safety**
> No harness can guarantee safety, Vera included. Ask and auto are for normal
> work; run full access only in an isolated environment. See
> [What to expect](how-vera-works.md#what-to-expect).

> [!NOTE]
> **Privacy**
> Vera does not collect your data and never will. It has no telemetry. Your
> conversations go only to the model providers and tools you set up. Vera
> downloads a few public files, such as the recommended model list and model
> scores, and sends nothing about you with them.

## Core concepts

- [How Vera works](how-vera-works.md)
- [Vera's files and settings](config-reference.md)

## Set up

- [Installation and upgrades](installation.md)
- [Connect and manage providers](first-run-setup.md)
- [Models, favorites, and defaults](models.md)
- [Find a command](commands.md)

## Work in a project

- [Switch and search conversations](session-switching.md)
- [Conversations](screen.md)
- [Saved conversations](sessions.md)
- [Queue messages while work runs](queued-messages.md)
- [Browse workspace changes](workspace-diff.md)
- [Search the web](web-search.md)
- [Browser use](browser-use.md)
- [Usage and cost](usage.md)
- [Conversation budgets](budgets.md)

<div data-early-access="workflows-early-access">

## Workflows (early access)

- [How workflows run](workflows.md)
- [Write your first workflow](python-workflows.md)
- [Control workflow steps](workflow-steps.md)
- [Watch workflow runs](workflow-runs.md)
- [Run Vera from Python](python-agents.md)

</div>

## Customize

- [Browse and edit customization sources](customize.md)
- [Agents and delegated work](agents.md)
- [Use and create skills](skills.md)
- [Standing instructions](standing-nudges.md)
- [Rules](rules.md)
- [Session start hooks](session-start-hooks.md)
- [Inspect context usage](context-usage.md)
- [Context limits and compaction](context-levers.md)
- [Manage extensions](extensions.md)
- [Included extensions](included-extensions.md)
- [Extension credentials](extension-credentials.md)
- [Configure automatic approval](permission-classifier.md)
- [Choose a configuration file](configuration-files.md)
- [Themes](themes.md)
- [Keybindings](keybindings.md)
- [Dialog controls](tui-dialogs.md)

## Reference and integration

- [When something is not working](troubleshooting.md)
- [The installed command](installed-command.md)
- [Development instances and process cleanup](runtime-and-worktrees.md)
- [Use Vera from scripts](programmatic-use.md)
- [Build a reviewer with the embedded SDK](embedded-sdk-reviewer.md)
