---
name: consult
description: Consult two independent subagents in parallel, then reconcile their agreements, disagreements, evidence, risks, and recommendations. Use when a decision benefits from two independent investigations.
---
# Consult

Call exactly two sibling subagents in the same assistant response so they run concurrently.

Give both subagents the same question and the relevant context. Tell them to investigate only and not edit files. They must work independently and must not see each other's answer.

After both return, synthesize:

- agreements;
- disagreements;
- strongest evidence;
- risks or uncertainty;
- one final recommendation.

Do not use Arc for this bounded one-turn consultation.
