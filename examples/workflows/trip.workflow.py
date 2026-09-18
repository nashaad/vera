"""Shortlist destinations, research each one, wait for a pick, then plan the days.

Needs:       OPENROUTER_API_KEY, or --offline for canned replies with no key
Run it:      PYTHONPATH=python python3 examples/workflows/trip.workflow.py "four days in May, food and long walks"
Answer:      PYTHONPATH=python python3 -m vera.workflow answer <run_id>
Look:        PYTHONPATH=python python3 -m vera.workflow show <run_id>
Stop early:  STOP_AFTER=2 before the run command ends it as the third step starts
Resume:      PYTHONPATH=python python3 -m vera.workflow resume <run_id>

Each step makes one call to openai/gpt-5.6-luna through OpenRouter and records
the tokens and the charge OpenRouter reports. Every destination is researched
by its own step (lodging, getting around, things to do). The run stops after
the research and waits for your pick, which the itinerary step reads.
STOP_AFTER=N ends the process the way a kill would, once N steps have
started in it. `resume` then skips the finished steps and runs the rest.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from urllib.request import Request, urlopen

from vera.workflow import ask, current, model_call, step, workflow


MODEL = "openai/gpt-5.6-luna"
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

# STOP_AFTER=N in the environment ends the process as step N+1 starts.
STOP_AFTER = os.environ.get("STOP_AFTER", "")
_started: set[str] = set()
_dropped: set[str] = set()


# --- one model call ---------------------------------------------------------

def complete(prompt: str, offline: bool, canned: str) -> str:
    """Send one prompt and record it, the reply and the usage on the current step."""
    with model_call(MODEL, provider="openrouter") as call:
        call.input(prompt)
        if offline:
            call.usage(input_tokens=len(prompt) // 4, output_tokens=len(canned) // 4)
            call.output(canned)
            return canned
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
        reply = answer["choices"][0]["message"]["content"]
        call.output(reply)
        return reply


def stop_point(label: str) -> None:
    """End the process, as a kill would, once STOP_AFTER steps have started here."""
    _started.add(label)
    if STOP_AFTER.isdigit() and len(_started) > int(STOP_AFTER):
        print(
            f"stopped at {label}. resume with: "
            f"python3 -m vera.workflow resume {current.run.id}",
            file=sys.stderr, flush=True,
        )
        os._exit(3)


def drop_first_try(label: str, offline: bool) -> None:
    # Offline, this fails once per process with a canned error so the retry shows in the spans.
    if offline and label not in _dropped:
        _dropped.add(label)
        raise ConnectionError(f"offline: canned dropped connection on {label}")


# --- steps ------------------------------------------------------------------

@step(retries=2, backoff=2.0)
def shortlist(brief: str, offline: bool) -> list[str]:
    stop_point("shortlist")
    reply = complete(
        f"Suggest three destinations for this trip: {brief}. "
        "Reply with the three place names, one per line, nothing else.",
        offline,
        "Lisbon\nKyoto\nOaxaca",
    )
    places = [line.strip(" -*0123456789.") for line in reply.splitlines()]
    return [place for place in places if place][:3]


@step(retries=2, backoff=2.0)
def research(place: str, brief: str, offline: bool) -> str:
    stop_point(f"research {place}")
    drop_first_try(f"research {place}", offline and place == "Lisbon")
    return complete(
        f"For a trip to {place} ({brief}), give three short lines: "
        "where to stay, how to get around, and the best things to do.",
        offline,
        f"{place}: stay central, walk and use the metro, eat at the markets.",
    )


@step(retries=2, backoff=2.0)
def itinerary(brief: str, notes: str, pick: str, offline: bool) -> str:
    stop_point("itinerary")
    return complete(
        f"Plan a day-by-day itinerary for this trip: {brief}.\n\n"
        f"Research on the options:\n\n{notes}\n\nThe traveller chose: {pick}",
        offline,
        f"Day 1: arrive, walk the old town. Day 2: markets. ({pick})",
    )


# --- the workflow -----------------------------------------------------------

@workflow
def trip(brief: str, offline: bool = False) -> str:
    places = shortlist(brief, offline)
    tickets = [research.submit(place, brief, offline) for place in places]
    notes = "\n\n".join(ticket.result() for ticket in tickets)
    pick = ask(f"Options for {brief}:\n\n{notes}\n\nWhich one, and any changes?")
    return itinerary(brief, notes, pick, offline)


def usage() -> None:
    print(
        f"usage: {Path(sys.argv[0]).name} [--offline] <brief>",
        file=sys.stderr,
    )
    raise SystemExit(2)


if __name__ == "__main__":
    arguments = sys.argv[1:]
    offline = "--offline" in arguments
    arguments = [argument for argument in arguments if argument != "--offline"]
    if len(arguments) != 1:
        usage()
    if not offline and not os.environ.get("OPENROUTER_API_KEY"):
        print("set OPENROUTER_API_KEY, or pass --offline", file=sys.stderr)
        raise SystemExit(2)
    run = trip.run(arguments[0], offline)
    if run.status == "suspended":
        print(f"{run.id} is waiting for your pick.")
        print(f"answer with: python3 -m vera.workflow answer {run.id}")
    else:
        print(run.id, run.status)
        print(run.result if run.error is None else run.error.message)
