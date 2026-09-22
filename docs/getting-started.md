---
title: "Getting started"
description: "Connect a model and complete your first task in a project."
---

# Getting started

This walkthrough takes you from opening Vera to asking about your project,
reviewing a change, and returning to the conversation later. You need the
[installed vera command](installation.md) and access to a model provider.

## Start in your project

In a terminal, open your project directory and start Vera:

```sh
cd /path/to/your/project
vera
```

Vera opens Home. This directory is the workspace for your conversation.
Personal settings and saved work live in your Vera home at `~/.vera`.

## Connect a provider

1. Choose **Connect a provider** on Home.
2. Choose **Add provider**.
3. Enter its name, endpoint, and API key, then save.

Vera reads the provider's available models. If the connection fails, your
input stays in the form with an explanation of what to fix.

For subscription sign-in or a local server, use the corresponding section of
[Connect and manage providers](first-run-setup.md).

## Choose a model

Run `/model`, type a model name, and press Enter on the result. If Vera asks
for reasoning effort, choose a level to finish opening the conversation.

To browse instead, open **Filter and sort** and choose **All connected**.
You do not need to favorite a model or assign a default before using it.
The composer status shows your current model and effort.

## Ask about the project

Start with a question whose answer you can check:

```text
Read the README and tell me how to run this project's tests. Do not change files.
```

Press Enter to send. Vera shows its reply and tool activity. If an approval
appears, read the action and decide whether to allow it.

### Make and review a change

Give Vera a concrete task and say what should count as finished:

```text
Fix the typo in the README's installation heading. Show me the change.
```

Run `/diff` to inspect the workspace changes. You can ask for a correction
in your next message.

## Stop and return later

Ctrl+C stops active work. When idle, it clears a draft first; with an empty
composer, it exits the TUI. Pressing it while a stop is in progress also exits.
Other conversations can remain running in the background.

Your conversation stays saved. Start Vera again and use `/resume` to choose
it, or run `vera -c` to continue the most recent one.

## Find the next control

| You want to | Use |
| --- | --- |
| Find an action | Ctrl+P |
| Read controls and help | `/help` |
| Inspect changes | `/diff` |
| Review usage | `/usage` |
| Set a $5 conversation budget | `/budget 5` |
| Browse instructions and skills | `/customize` |
| Diagnose a problem | `/diagnostics` |

Model requests can incur provider charges. A [budget](budgets.md) checks
reported spending before the next request; a reply can take the total past it.
