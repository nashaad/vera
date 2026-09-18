"""Plan a menu around the guests' allergies, wait for an OK, then write the shopping list.

Needs:       OPENROUTER_API_KEY, or --offline for canned replies with no key
Run it:      PYTHONPATH=python python3 examples/workflows/dinner.workflow.py "Ana: peanuts; Ben: gluten; Chloe; Dev: shellfish; Eli: dairy, eggs; Fay"
Answer:      PYTHONPATH=python python3 -m vera.workflow answer <run_id>
Look:        PYTHONPATH=python python3 -m vera.workflow show <run_id>
Stop early:  STOP_AFTER=2 before the run command ends it as the third step starts
Resume:      PYTHONPATH=python python3 -m vera.workflow resume <run_id>

The guest list is `Name: allergy, allergy` entries separated by semicolons; a
name alone has no allergies. Each course (starter, main, dessert) is its own
step and one call to openai/gpt-5.6-luna through OpenRouter, which records the
tokens and the charge OpenRouter reports. The run stops with the menu and
waits for an OK or changes, then writes a shopping list grouped by aisle.
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

COURSES = ("starter", "main", "dessert")
CANNED_COURSES = {
    "starter": "Roast carrot and cumin soup with olive oil and herbs",
    "main": "Lemon and herb roast chicken, crushed potatoes, green beans",
    "dessert": "Poached pears in spiced red wine with coconut yoghurt",
}
CANNED_LIST = (
    "Produce: carrots, lemons, fresh herbs, potatoes, green beans, pears\n"
    "Meat: one large chicken\n"
    "Pantry: olive oil, cumin, cinnamon sticks, sugar\n"
    "Chilled: coconut yoghurt\n"
    "Drinks: one bottle of red wine"
)

# STOP_AFTER=N in the environment ends the process as step N+1 starts.
STOP_AFTER = os.environ.get("STOP_AFTER", "")
_started: set[str] = set()
_dropped: set[str] = set()


# --- one model call ---------------------------------------------------------

def complete(prompt: str, offline: bool, canned: str) -> str:
    """Send one prompt and record what it used on the current step."""
    with model_call(MODEL, provider="openrouter") as call:
        if offline:
            call.usage(input_tokens=len(prompt) // 4, output_tokens=len(canned) // 4)
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
        return answer["choices"][0]["message"]["content"]


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


def read_guests(guests: str) -> list[tuple[str, list[str]]]:
    """Turn "Ana: peanuts; Chloe" into [("Ana", ["peanuts"]), ("Chloe", [])]."""
    parsed = []
    for entry in guests.split(";"):
        name, _, avoids = entry.partition(":")
        if name.strip():
            allergies = [item.strip() for item in avoids.split(",") if item.strip()]
            parsed.append((name.strip(), allergies))
    return parsed


# --- steps ------------------------------------------------------------------

@step(retries=2, backoff=2.0)
def course(name: str, count: int, avoid: list[str], offline: bool) -> str:
    stop_point(name)
    drop_first_try(name, offline and name == "main")
    free_of = ", ".join(avoid) or "nothing in particular"
    return complete(
        f"Suggest one {name} for a dinner party of {count}. It must be free of: "
        f"{free_of}. Reply with the dish in one line, no preamble.",
        offline,
        CANNED_COURSES[name],
    )


@step(retries=2, backoff=2.0)
def shopping(menu: str, count: int, verdict: str, offline: bool) -> str:
    stop_point("shopping")
    return complete(
        f"Write a shopping list for this menu, for {count} people, grouped by "
        f"supermarket aisle, one aisle per line as `Aisle: item, item`.\n\n{menu}\n\n"
        f"The host said about the menu: {verdict}",
        offline,
        CANNED_LIST,
    )


# --- the workflow -----------------------------------------------------------

@workflow
def dinner(guests: str, offline: bool = False) -> str:
    party = read_guests(guests)
    avoid = sorted({allergy for _, allergies in party for allergy in allergies})
    tickets = [course.submit(name, len(party), avoid, offline) for name in COURSES]
    menu = "\n".join(
        f"{name.title()}: {ticket.result()}" for name, ticket in zip(COURSES, tickets)
    )
    verdict = ask(
        f"Menu for {len(party)} guests, avoiding {', '.join(avoid) or 'nothing'}:\n\n"
        f"{menu}\n\nOK to shop for this? Reply ok, or say what to change."
    )
    return f"{menu}\n\n{shopping(menu, len(party), verdict, offline)}"


def usage() -> None:
    print(
        f"usage: {Path(sys.argv[0]).name} [--offline] <guests>",
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
    run = dinner.run(arguments[0], offline)
    if run.status == "suspended":
        print(f"{run.id} is waiting for your OK on the menu.")
        print(f"answer with: python3 -m vera.workflow answer {run.id}")
    else:
        print(run.id, run.status)
        print(run.result if run.error is None else run.error.message)
