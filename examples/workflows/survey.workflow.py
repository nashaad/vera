"""Propose themes for survey answers, let you edit them, then tag and count every answer.

Needs:       OPENROUTER_API_KEY, or --offline for canned replies with no key
Run it:      PYTHONPATH=python python3 examples/workflows/survey.workflow.py examples/workflows/data/survey.txt
Answer:      PYTHONPATH=python python3 -m vera.workflow answer <run_id>
Look:        PYTHONPATH=python python3 -m vera.workflow show <run_id>
Stop early:  STOP_AFTER=2 before the answer command ends it at the third batch
Resume:      PYTHONPATH=python python3 -m vera.workflow resume <run_id>

The input is a text file with one survey answer per line; the included
`data/survey.txt` holds 24 answers about a public library. The model proposes
themes, and the run stops so you can keep them (reply ok) or send your own
list, separated by commas or new lines. Answers are then tagged in batches of
five, each batch its own step and one call to openai/gpt-5.6-luna through
OpenRouter, and the tags are counted. Each call records the tokens and the
charge OpenRouter reports. STOP_AFTER=N ends the process the way a kill
would, once N steps have started in it. `resume` then skips the finished
steps. Tagging runs in the process that answers, so that is where to stop it.
"""

from __future__ import annotations

from collections import Counter
import json
import os
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen

from vera.workflow import ask, current, model_call, step, workflow


MODEL = "openai/gpt-5.6-luna"
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
BATCH = 5
CANNED_THEMES = ["Opening hours", "Book selection", "Noise", "Staff", "Events"]

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


def guess_theme(answer: str, themes: list[str]) -> str:
    """Offline stand-in for the model: a theme whose word starts a word in the answer."""
    words = re.findall(r"[a-z]+", answer.lower())
    for theme in themes:
        stems = [word[:4] for word in re.findall(r"[a-z]+", theme.lower()) if len(word) >= 4]
        if any(word.startswith(stem) for stem in stems for word in words):
            return theme
    return "other"


# --- steps ------------------------------------------------------------------

@step
def load(path: str) -> list[str]:
    stop_point("load")
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip()]


@step(retries=2, backoff=2.0)
def propose(answers: list[str], offline: bool) -> list[str]:
    stop_point("propose")
    reply = complete(
        "Read these survey answers and propose four to six themes that cover "
        "most of them. Reply with the theme names, one per line, nothing else.\n\n"
        + "\n".join(answers),
        offline,
        "\n".join(CANNED_THEMES),
    )
    themes = [line.strip(" -*0123456789.") for line in reply.splitlines()]
    return [theme for theme in themes if theme]


@step(retries=2, backoff=2.0)
def tag(first: int, batch: list[str], themes: list[str], offline: bool) -> list[str]:
    stop_point(f"tag {first}")
    drop_first_try(f"tag {first}", offline and first == BATCH)
    numbered = "\n".join(f"{index}: {answer}" for index, answer in enumerate(batch, 1))
    canned = "\n".join(
        f"{index}: {guess_theme(answer, themes)}" for index, answer in enumerate(batch, 1)
    )
    reply = complete(
        f"Tag each numbered survey answer with exactly one of these themes: "
        f"{', '.join(themes)}, or other. Reply one line per answer as "
        f"`<number>: <theme>`, nothing else.\n\n{numbered}",
        offline,
        canned,
    )
    by_name = {theme.lower(): theme for theme in themes}
    tags = ["other"] * len(batch)
    for line in reply.splitlines():
        found = re.match(r"\s*(\d+)\s*[:.)]\s*(.+?)\s*$", line)
        if found and 1 <= int(found.group(1)) <= len(batch):
            tags[int(found.group(1)) - 1] = by_name.get(found.group(2).lower(), "other")
    return tags


# --- the workflow -----------------------------------------------------------

@workflow
def survey(path: str, offline: bool = False) -> str:
    answers = load(path)
    proposed = propose(answers, offline)
    edit = ask(
        "Proposed themes:\n\n" + "\n".join(proposed)
        + "\n\nReply ok to keep them, or send your list, separated by commas or new lines."
    )
    themes = proposed
    if edit.strip().lower() not in ("", "ok"):
        themes = [theme.strip() for theme in re.split(r"[,\n]", edit) if theme.strip()]
    tickets = [
        tag.submit(first, answers[first:first + BATCH], themes, offline)
        for first in range(0, len(answers), BATCH)
    ]
    counts = Counter(label for ticket in tickets for label in ticket.result())
    lines = [f"{len(answers)} answers"]
    lines += [f"  {theme}: {counts[theme]}" for theme in [*themes, "other"]]
    return "\n".join(lines)


def usage() -> None:
    print(
        f"usage: {Path(sys.argv[0]).name} [--offline] <answers.txt>",
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
    run = survey.run(str(Path(arguments[0]).resolve()), offline)
    if run.status == "suspended":
        print(f"{run.id} is waiting for you to check the themes.")
        print(f"answer with: python3 -m vera.workflow answer {run.id}")
    else:
        print(run.id, run.status)
        print(run.result if run.error is None else run.error.message)
