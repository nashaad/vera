---
name: consult
description: Consult independent Vera agents and reconcile their evidence, disagreements, risks, and recommendations. Use when a consequential question or decision benefits from multiple independent investigations, including an immediate two-agent consultation or an asynchronous consultation with named live participants.
---

# Consult

Choose the mode from the user's intent.

## Immediate consultation

Unless the user names existing participants, call exactly two sibling subagents in the same assistant response so they run concurrently.

Give both the same question, relevant context, constraints, and requested output. Tell them to investigate without editing. They must work independently and must not see each other's answer. Do not inherit unrelated conversation detail.

If the user names pooled models, pass those exact model IDs to the respective subagents and label their answers by model. Otherwise use Vera's configured subagent defaults. Do not guess which models are pooled, add models, or claim cross-model diversity that was not explicitly selected.

After both return, synthesize:

- agreements;
- disagreements;
- strongest evidence;
- risks and uncertainty;
- one final recommendation.

## Existing Vera participants

When the user explicitly asks to consult named, paired, or already-running agents, call `agent_roster` and resolve them by participant ID. Send each the same self-contained question with `agent_send`.

Messages are asynchronous and do not wake recipients. Do not block the current turn, spawn replacements, or invent replies. Report who received the request. On a later turn, read actual replies with `agent_inbox` and then synthesize them using the same rubric.

Do not treat every live participant as consenting to consultation. Use only those the user names or clearly selects.

Do not invoke the Arc CLI. Vera's native agent tools own both modes. `/pair` remains the user-facing surface for ongoing visible collaboration rather than a one-shot consultation.
