---
title: "Vera manual"
description: "Use Vera in a project, customize its behavior, and write Python workflows."
---

# Vera manual

Vera is an agent runtime. It connects models to tools and manages conversations,
context, permissions, and saved work. You can use it interactively in your
project or call it from application code.

Vera workflows run Python steps and record their results so work can resume
after interruption.

Start with [Getting started](getting-started.md) to connect a model and run
your first conversation. For recorded Python workflows, start with
[How workflows run](workflows.md).

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

## Workflows

- [How workflows run](workflows.md)
- [Write your first workflow](python-workflows.md)
- [Control workflow steps](workflow-steps.md)
- [Watch workflow runs](workflow-runs.md)
- [Run Vera from Python](python-agents.md)

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
