"""Live halibut acceptance. Vera answers through a free OpenRouter model.

Codex sign-in is not in this worktree's home, so calls use
nvidia/nemotron-3-ultra-550b-a55b:free via OPENROUTER_API_KEY. The daily
~/.vera home is never read. Results are cached under acceptance/cache.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
EXT = REPO / "extensions" / "activmem"
CACHE = ROOT / "acceptance" / "cache"
REPORT = ROOT / "ACCEPTANCE.md"
MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free"
RUNS = int(os.environ.get("ACTIVMEM_ACCEPT_RUNS", "5"))
FILLER = int(os.environ.get("ACTIVMEM_ACCEPT_FILLER", "3000"))


def main() -> int:
    if not os.environ.get("OPENROUTER_API_KEY"):
        _write("BLOCKED", "OPENROUTER_API_KEY is not set, and this worktree's Vera home has no ChatGPT sign-in.")
        return 2
    if not (EXT / "extension.ts").exists():
        _write("BLOCKED", f"Extension missing at {EXT}.")
        return 2
    CACHE.mkdir(parents=True, exist_ok=True)
    rows = []
    only = os.environ.get("ACTIVMEM_ACCEPT_ONLY")
    conditions = (only,) if only else ("activmem", "control")
    for condition in conditions:
        for index in range(1, RUNS + 1):
            rows.append(run_one(condition, index))
    activmem_pass = sum(1 for row in rows if row["condition"] == "activmem" and row["passed"])
    control_fail = sum(1 for row in rows if row["condition"] == "control" and not row["c"] or (row["condition"] == "control" and not row["d"]))
    # control must fail C or D
    control_fail = sum(
        1 for row in rows
        if row["condition"] == "control" and not (row["c"] and row["d"])
    )
    passed = activmem_pass >= 4 and control_fail >= 3
    _write_report(rows, activmem_pass, control_fail, passed)
    return 0 if passed else 1


def run_one(condition: str, index: int) -> dict:
    path = CACHE / f"{condition}-{index}.json"
    if path.exists():
        return json.loads(path.read_text())
    ws = Path(f"/tmp/am-acc-{condition}-{index}")
    home = Path(f"/tmp/am-home-{condition}-{index}")
    if ws.exists():
        shutil.rmtree(ws)
    if home.exists():
        shutil.rmtree(home)
    ws.mkdir()
    home.mkdir()
    (home / "config.json").write_text(json.dumps({
        "schema_version": 1,
        "provider": "openrouter",
        "model": MODEL,
        "reasoning_effort": "low",
        "approval_mode": "auto",
        "extensions": [{"path": str(EXT), "enabled": True}],
    }, indent=2))
    env = os.environ.copy()
    env["VERA_HOME"] = str(home)
    env["ACTIVMEM_EMBED"] = "1"
    env["ACTIVMEM_GRAPH"] = "off" if condition == "control" else "on"
    serve = subprocess.Popen(
        ["uv", "run", "activmem", "serve", "--dir", str(ws)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        _wait_socket(ws)
        first = _session(ws, home, ["I really like pollock."])
        second = _session(ws, home, ["sike, I don't."])
        serve.terminate()
        serve.wait(timeout=5)
        _seed_rest(ws, env)
        serve = subprocess.Popen(
            ["uv", "run", "activmem", "serve", "--dir", str(ws)],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _wait_socket(ws)
        third = _session(ws, home, [
            "What seafood should I order tonight?",
            "Why not pollock?",
        ])
        record = _grade(ws, first, second, third, condition, index, home)
    finally:
        serve.terminate()
        try:
            serve.wait(timeout=5)
        except subprocess.TimeoutExpired:
            serve.kill()
    path.write_text(json.dumps(record, indent=2))
    print(condition, index, "PASS" if record["passed"] else "FAIL", flush=True)
    return record


def _wait_socket(ws: Path) -> None:
    pointer = ws / ".activmem" / "socket-path"
    for _ in range(50):
        if pointer.exists():
            target = Path(pointer.read_text(encoding="utf-8").strip())
            if target.exists():
                return
        time.sleep(0.2)
    raise RuntimeError("activmem serve did not publish a socket")


def _session(ws: Path, home: Path, prompts: list[str]) -> list[dict]:
    env = os.environ.copy()
    env["VERA_HOME"] = str(home)
    proc = subprocess.Popen(
        ["vera", "stdio"],
        cwd=str(ws),
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    turns = []
    current = {"prompt": None, "reply": "", "tools": []}
    sent = 0
    deadline = time.time() + 180 * len(prompts)
    assert proc.stdin is not None and proc.stdout is not None
    while time.time() < deadline and sent <= len(prompts):
        line = proc.stdout.readline()
        if not line:
            break
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = msg.get("type")
        if kind == "stdio_attached" and sent < len(prompts):
            current = {"prompt": prompts[sent], "reply": "", "tools": []}
            proc.stdin.write(json.dumps({"type": "prompt", "content": prompts[sent]}) + "\n")
            proc.stdin.flush()
            sent += 1
        elif kind == "assistant_delta" and current["prompt"]:
            current["reply"] += msg.get("text") or ""
        elif kind == "tool_started" and current["prompt"]:
            current["tools"].append({"tool": msg.get("tool"), "args": msg.get("args")})
        elif kind == "ui_request":
            proc.stdin.write(json.dumps({
                "type": "ui_response",
                "requestId": msg.get("requestId"),
                "response": {"type": "tool_approval", "decision": "allow_once"},
            }) + "\n")
            proc.stdin.flush()
        elif kind == "turn_finished" and current["prompt"]:
            time.sleep(1.2)
            turns.append(current)
            if sent < len(prompts):
                current = {"prompt": prompts[sent], "reply": "", "tools": []}
                proc.stdin.write(json.dumps({"type": "prompt", "content": prompts[sent]}) + "\n")
                proc.stdin.flush()
                sent += 1
            else:
                break
    proc.kill()
    return turns


def _seed_rest(ws: Path, env: dict) -> None:
    """Halibut, then filler. Embeddings are batched. The live steps never say halibut."""
    code = r'''
import os, sys
os.environ["ACTIVMEM_EMBED"] = "0"
sys.path[:0] = ["src", "tests"]
from activmem.memory import ActivMem, _embed_text
from activmem.vectors import VectorStore
from corpus import filler
mem = ActivMem(sys.argv[1])
mem.save_turn("Halibut is my favourite fish.", "Okay.", "setup")
for i in range(int(sys.argv[2])):
    mem.save_turn(filler(i), "Okay.", f"filler-{i}")
rows = []
for node, data in mem.index.graph.nodes(data=True):
    if data.get("kind") != "chunk":
        continue
    rows.append((node, data.get("text") or "", _embed_text(mem.index.graph, node), {
        "actor": data.get("actor") or "",
        "session": data.get("session") or "",
        "content_hash": data.get("content_hash") or "",
        "status": data.get("status") or "",
    }))
VectorStore(mem.home / "chroma").add_many(rows)
mem.close()
'''
    child = dict(env)
    child["ACTIVMEM_EMBED"] = "0"
    subprocess.run(
        ["uv", "run", "python", "-c", code, str(ws), str(FILLER)],
        cwd=str(ROOT),
        env=child,
        check=True,
    )


def _grade(ws, first, second, third, condition, index, home) -> dict:
    sys.path[:0] = [str(ROOT / "src")]
    from activmem.memory import ActivMem
    mem = ActivMem(ws)
    events = mem.log.events
    pollock = next(event["item_id"] for event in events if event.get("text") == "I really like pollock.")
    link = next((
        event for event in events
        if event.get("type") == "link"
        and event.get("kind") == "revises"
        and event.get("actor") == "vera"
        and event.get("to") == pollock
    ), None)
    revising = ""
    if link:
        source = next((event for event in events if event.get("item_id") == link.get("from")), None)
        revising = (source or {}).get("text") or ""
    check_a = link is not None and "sike" in revising.lower()
    seafood = third[0]["prompt"] if third else ""
    injected = mem.context_for("session-3", seafood)["context"] if seafood else ""
    check_b = (
        "halibut" in injected.lower()
        and "[revised]" in injected
        and "pollock" in injected.lower()
        and "sike" in injected.lower()
    )
    order = third[0]["reply"] if third else ""
    why = third[1]["reply"] if len(third) > 1 else ""
    keyword_c = "halibut" in order.lower() and not _recommends_pollock(order)
    judge_c = _judge(home, order, "Does this reply recommend pollock as what to order? Does it reflect that Nash's current fish is halibut, not pollock?")
    judge_d = _judge(home, why, "Does this reply say Nash took the pollock preference back?")
    check_c = keyword_c and "recommend pollock: no" in judge_c.lower()
    check_d = "took it back: yes" in judge_d.lower() or "yes" in judge_d.lower()[:12]
    mem.close()
    return {
        "condition": condition,
        "run": index,
        "model": MODEL,
        "sessions": [
            {"prompt": turn["prompt"], "reply": turn["reply"], "tools": turn["tools"]}
            for turn in [*first, *second, *third]
        ],
        "injected": injected,
        "a": check_a,
        "b": check_b,
        "c": check_c,
        "d": check_d,
        "judge_c": judge_c,
        "judge_d": judge_d,
        "passed": check_a and check_b and check_c and check_d,
    }


def _recommends_pollock(text: str) -> bool:
    lowered = text.lower()
    if "pollock" not in lowered:
        return False
    window = lowered
    return "order pollock" in window or "try pollock" in window or "get pollock" in window or "go with pollock" in window


def _judge(home: Path, reply: str, rubric: str) -> str:
    prompt = (
        "Answer in two lines, each starting yes or no.\n"
        f"{rubric}\n"
        "Line 1: recommend pollock: yes or no\n"
        "Line 2: took it back: yes or no\n\n"
        f"Reply:\n{reply}"
    )
    result = subprocess.run(
        ["vera", "-p", prompt, "--prompt-only"],
        cwd=str(home),
        env={**os.environ, "VERA_HOME": str(home)},
        text=True,
        capture_output=True,
        timeout=120,
    )
    return (result.stdout or result.stderr or "").strip()


def _write(title: str, body: str) -> None:
    REPORT.write_text(f"# Acceptance\n\n{title}\n\n{body}\n", encoding="utf-8")


def _write_report(rows: list[dict], activmem_pass: int, control_fail: int, passed: bool) -> None:
    lines = [
        "# Acceptance",
        "",
        f"Model: `{MODEL}` on OpenRouter (free). Codex sign-in is not in this worktree home.",
        "",
        f"ActivMem passed {activmem_pass} / {RUNS}. Control failed C or D in {control_fail} / {RUNS}.",
        f"Gate: {'pass' if passed else 'fail'}.",
        "",
        "| run | A | B | C | D |",
        "|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append(
            f"| {row['condition']} {row['run']} | {row['a']} | {row['b']} | {row['c']} | {row['d']} |"
        )
    lines.append("")
    for row in rows:
        lines.append(f"## {row['condition']} {row['run']}")
        for turn in row["sessions"]:
            lines.append(f"Prompt: {turn['prompt']}")
            lines.append(f"Tools: {turn['tools']}")
            lines.append(f"Reply: {turn['reply']}")
            lines.append("")
        lines.append("Injected:")
        lines.append(row["injected"] or "(none)")
        lines.append("")
        lines.append(f"Judge C: {row['judge_c']}")
        lines.append(f"Judge D: {row['judge_d']}")
        lines.append("")
    REPORT.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
