---
title: "Python review workflow example"
description: "Draft review example that requires live Python model calls."
draft: true
---

# Python review workflow example

This review example remains unvalidated. The SDK now accepts `provider` and
`model` and makes live calls. References below to overlapping calls do not
describe Halcyon’s serial `.submit` behavior.

## Example

```python
"""Sequential step, overlapping .submit, and Vera.run on OpenRouter Solar Pro."""

from __future__ import annotations

from pathlib import Path
import json
import sys

from vera.agent import Agent
from vera.instance import Vera
from vera.workflow.api import step, workflow


PROVIDER = "openrouter"
MODEL = "upstage/solar-pro4"

class _Open:
    vera: Vera | None = None


def _agent(name: str, instructions: str) -> Agent:
    return Agent(
        name=name,
        instructions=instructions,
        tools=[],
        posture="readonly",
        provider=PROVIDER,
        model=MODEL,
    )


market_analyst = _agent(
    "market",
    "No tools. Do not emit tool calls. Two sentences of market context for the ticker.",
)
financial_analyst = _agent(
    "fundamental",
    "No tools. Do not emit tool calls. Two sentences of fundamental view for the ticker.",
)
technical_analyst = _agent(
    "technical",
    "No tools. Do not emit tool calls. Two sentences of technical view for the ticker.",
)
committee_chair = _agent(
    "committee",
    "No tools. Do not emit tool calls. First word Buy, Hold, or Sell. Then one sentence why.",
)


def ask(agent: Agent, prompt: str) -> str:
    if _Open.vera is None:
        raise RuntimeError("Vera is not open")
    return _Open.vera.run(agent, prompt)


@step
def market(ticker: str) -> str:
    return ask(market_analyst, ticker)


@step
def fundamental(ticker: str) -> str:
    return ask(financial_analyst, ticker)


@step
def technical(ticker: str) -> str:
    return ask(technical_analyst, ticker)


@step
def decide(packet: dict[str, str]) -> dict[str, str]:
    notes = (
        f"{packet['ticker']}\n"
        f"market: {packet['market']}\n"
        f"fundamental: {packet['fundamental']}\n"
        f"technical: {packet['technical']}\n"
    )
    return {
        "ticker": packet["ticker"],
        "market": packet["market"],
        "fundamental": packet["fundamental"],
        "technical": packet["technical"],
        "decision": ask(committee_chair, notes),
    }


@workflow
def review(ticker: str) -> dict[str, str]:
    """Market, overlapping specialists, then a decision."""
    snapshot = market(ticker)
    fund = fundamental.submit(ticker)
    tech = technical.submit(ticker)
    return decide(
        {
            "ticker": ticker,
            "market": snapshot,
            "fundamental": fund.result(),
            "technical": tech.result(),
        }
    )


if __name__ == "__main__":
    if len(sys.argv) not in {2, 3}:
        print(
            f"usage: {Path(sys.argv[0]).name} <journal_dir> [ticker]",
            file=sys.stderr,
        )
        raise SystemExit(2)
    journal_dir = Path(sys.argv[1])
    ticker = sys.argv[2] if len(sys.argv) == 3 else "NVDA"
    workspace = journal_dir / "workspace"
    workspace.mkdir(exist_ok=True)
    _Open.vera = Vera.create(workspace=str(workspace), posture="readonly")
    try:
        run = review.run(ticker, journal_dir=journal_dir)
    finally:
        opened = _Open.vera
        if opened is not None:
            opened.close()
        _Open.vera = None
    print(run.id, run.status)
    if run.status != "ok":
        print(run.error, file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(run.result, indent=2, sort_keys=True))
```

## Original run instructions

Incubating here until the shape is worth copying into Vera's
`examples/workflows/`.

`review.workflow.py` is the investment-shaped demo: one sequential `@step`,
two overlapping `.submit` specialists, then a decision step. Each step calls
`Vera.run` with empty tools on OpenRouter `upstage/solar-pro4`. Needs a Vera
`python/` tree whose `Agent` accepts `provider` and `model`.

```sh
mkdir -p /tmp/wf-review
PYTHONPATH=/path/to/vera/python python3 examples/workflows/review.workflow.py /tmp/wf-review NVDA
PYTHONPATH=/path/to/vera/python python3 -m vera.workflow show /tmp/wf-review <run-id>
```
