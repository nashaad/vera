"""Research a topic, outline it, wait for a sign-off, then write the draft.

Needs:       OPENROUTER_API_KEY, or --offline for canned replies with no key
Run it:      PYTHONPATH=python python3 examples/workflows/writer.workflow.py "sea otters"
Answer:      PYTHONPATH=python python3 -m vera.workflow answer <run_id>
Look:        PYTHONPATH=python python3 -m vera.workflow show <run_id>

Each step makes one call to openai/gpt-5.6-luna through OpenRouter and records
the tokens and the charge OpenRouter reports. The run stops after the outline
and waits for an answer, which the draft step reads as the editor's notes.
Kill it at any point and `resume` picks up after the last finished step.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from urllib.request import Request, urlopen

from vera.workflow import ask, model_call, step, workflow


MODEL = "openai/gpt-5.6-luna"
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"


# --- one model call ---------------------------------------------------------

def complete(prompt: str, offline: bool) -> str:
    """Send one prompt and record what it used on the current step."""
    with model_call(MODEL, provider="openrouter") as call:
        if offline:
            reply = f"(offline reply to: {prompt.splitlines()[0]})"
            call.usage(input_tokens=len(prompt) // 4, output_tokens=len(reply) // 4)
            return reply
        body = json.dumps({
            "model": MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "usage": {"include": True},
        }).encode("utf-8")
        request = Request(ENDPOINT, data=body, headers={
            "Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}",
            "Content-Type": "application/json",
        })
        with urlopen(request, timeout=120) as response:
            answer = json.load(response)
        usage = answer.get("usage", {})
        cached = usage.get("prompt_tokens_details", {}).get("cached_tokens", 0)
        call.usage(
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
            cached_input_tokens=cached or 0,
            cost=usage.get("cost"),
        )
        return answer["choices"][0]["message"]["content"]


# --- steps ------------------------------------------------------------------

@step(retries=2, backoff=2.0)
def research(topic: str, offline: bool) -> str:
    return complete(
        f"List the ten most useful facts about {topic} for a short article. "
        "One line each, no preamble.",
        offline,
    )


@step(retries=2, backoff=2.0)
def outline(topic: str, notes: str, offline: bool) -> str:
    return complete(
        f"Outline a 400-word article about {topic} in four to six headings, "
        f"using these notes:\n\n{notes}",
        offline,
    )


@step(retries=2, backoff=2.0)
def draft(topic: str, plan: str, feedback: str, offline: bool) -> str:
    return complete(
        f"Write a 400-word article about {topic} from this outline:\n\n{plan}\n\n"
        f"Editor's notes on the outline: {feedback}",
        offline,
    )


# --- the workflow -----------------------------------------------------------

@workflow
def writer(topic: str, offline: bool = False) -> str:
    notes = research(topic, offline)
    plan = outline(topic, notes, offline)
    feedback = ask(f"Outline for {topic}:\n\n{plan}\n\nNotes for the writer?")
    return draft(topic, plan, feedback, offline)


if __name__ == "__main__":
    arguments = sys.argv[1:]
    offline = "--offline" in arguments
    topics = [argument for argument in arguments if argument != "--offline"]
    if len(topics) != 1:
        print(
            f"usage: {Path(sys.argv[0]).name} [--offline] <topic>",
            file=sys.stderr,
        )
        raise SystemExit(2)
    if not offline and not os.environ.get("OPENROUTER_API_KEY"):
        print("set OPENROUTER_API_KEY, or pass --offline", file=sys.stderr)
        raise SystemExit(2)
    run = writer.run(topics[0], offline)
    if run.status == "suspended":
        print(f"{run.id} is waiting for your notes on the outline.")
        print(f"answer with: python3 -m vera.workflow answer {run.id}")
    else:
        print(run.id, run.status)
        print(run.result if run.error is None else run.error.message)
