---
title: "Conversation budgets"
description: "Set spending reminders and require a decision before continuing past a conversation budget."
---

# Conversation budgets

A conversation budget lets you decide when Vera should pause and ask before
spending more. It uses reported costs and checks before each new model
request. A reply can take the total past the budget because its final cost is
not known in advance.

## Set or remove a budget

Enter a dollar amount without a currency symbol:

```text
/budget 5
```

This sets a $5 budget against the conversation's total reported spending,
including work already done. `/budget .5` sets $0.50. Run `/budget` with no
amount to turn the budget off. `/budget -1` is also supported.

The setting survives reconnect and resume. Turning it off keeps the recorded
cost. Setting a budget prints what has been spent and what remains.

## Respond to spending notices

Vera shows reminders at 50% and 80% before the next request. Each reminder
appears once for the current budget amount. Changing the amount resets them.

At or above the budget, choose how to continue:

| Choice | Result |
| --- | --- |
| Stop, or Escape | End work without another request. |
| Ignore budget and continue | Keep the budget visible but allow further spending without another budget prompt. |
| Increase budget and continue | Enter a new total above the amount already spent, then continue. |

Use Up/Down and Enter, or the choice number. Stop is selected initially.
Choosing Increase turns its row into an input. Type the new total, such as
`5`, and press Enter.

<div data-widget="screen-steps" data-steps="budget-limit"></div>

Ignore survives reconnect and resume. Setting a budget again, even to the same
amount, restores budget prompts. A pending question survives reconnecting to
the same running host.

## Understand the cost total

The total includes intermediate model replies and billed compactions.
Rewinding does not erase spending. Each child conversation has its own budget
and total.

When some calls have no reported price, the notices and the prompt count
known spend only and say *Known spend only; some replies have no reported
cost.* Budget checks do not estimate missing prices.

For historical spending and estimates across conversations, see
[Usage and cost](usage.md).
