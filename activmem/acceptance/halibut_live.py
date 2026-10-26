"""Live halibut acceptance.

Every model call uses ACTIVMEM_MODEL, which defaults to
openrouter/deepseek/deepseek-v4.1-flash. A preflight checks vera inspect.
A run whose session file records a different model is discarded.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
EXT = REPO / "extensions" / "activmem"
CACHE = ROOT / "acceptance" / "cache"
REPORT = ROOT / "ACCEPTANCE.md"
MODEL = os.environ.get("ACTIVMEM_MODEL", "openrouter/deepseek/deepseek-v4.1-flash")
DEV_HOME = os.environ.get(
    "ACTIVMEM_VERA_HOME",
    "/var/folders/qs/72rgxnlj6djf0j_rwhx0l60m0000gn/T/vera-dev/faf872b0021f/.vera",
)
RUNS = int(os.environ.get("ACTIVMEM_ACCEPT_RUNS", "5"))
FILLER = int(os.environ.get("ACTIVMEM_ACCEPT_FILLER", "3000"))


def main() -> int:
    blocked = _preflight()
    if blocked:
        _write("BLOCKED", blocked)
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
    discarded = [row for row in rows if row.get("discarded")]
    if discarded:
        _write(
            "BLOCKED",
            "A live session recorded a model other than "
            f"{MODEL}. Those runs were discarded and are not a score.",
        )
        return 2
    passed = activmem_pass >= 4 and control_fail >= 3
    _write_report(rows, activmem_pass, control_fail, passed)
    return 0 if passed else 1


def run_one(condition: str, index: int) -> dict:
    path = CACHE / f"{condition}-{index}.json"
    if path.exists():
        cached = json.loads(path.read_text())
        if cached.get("model") == MODEL and not cached.get("discarded"):
            return cached
    ws = Path(f"/tmp/am-acc-{condition}-{index}")
    home = Path(f"/tmp/am-home-{condition}-{index}")
    if ws.exists():
        shutil.rmtree(ws)
    if home.exists():
        shutil.rmtree(home)
    ws.mkdir()
    home.mkdir()
    dist = REPO / "dist"
    if dist.exists():
        os.symlink(dist, ws / "dist")
    _write_home_config(home)
    env = _home_env(home)
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
        _library_add(home, env)
        _wait_socket(ws)
        first = _session(ws, home, ["I really like pollock."])
        second = _session(ws, home, ["sike, I don't."])
        said_halibut = _session(ws, home, ["Halibut is my favourite fish."])
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
        record = _grade(ws, home, first, second, said_halibut, third, condition, index)
    finally:
        serve.terminate()
        try:
            serve.wait(timeout=5)
        except subprocess.TimeoutExpired:
            serve.kill()
        _stop_hosts(home)
    path.write_text(json.dumps(record, indent=2))
    print(condition, index, "PASS" if record["passed"] else "FAIL", flush=True)
    return record


def _cli() -> list[str]:
    return ["bun", str(REPO / "clients/cli/main.ts")]


def _home_env(home: Path) -> dict:
    env = os.environ.copy()
    env["HOME"] = "/Users/nash"
    env["VERA_HOME"] = str(home)
    env["VERA_DEV_INSTANCE"] = "1"
    return env


def _write_home_config(home: Path) -> None:
    provider, model_id = MODEL.split("/", 1)
    (home / "config.json").write_text(json.dumps({
        "schema_version": 1,
        "provider": provider,
        "model": model_id,
        "reasoning_effort": "low",
        "approval_mode": "auto",
        "extensions": [{"path": str(EXT), "enabled": True}],
    }, indent=2) + "\n", encoding="utf-8")


def _library_add(home: Path, env: dict) -> str | None:
    result = subprocess.run(
        [*_cli(), "library", "add", MODEL],
        cwd=str(REPO),
        env=env,
        text=True,
        capture_output=True,
        timeout=60,
    )
    text = (result.stdout or "") + (result.stderr or "")
    if result.returncode != 0 or MODEL not in _library_text(env):
        return f"Could not add {MODEL} to the library. {text.strip()}"
    return None


def _library_text(env: dict) -> str:
    result = subprocess.run(
        [*_cli(), "library", "list"],
        cwd=str(REPO),
        env=env,
        text=True,
        capture_output=True,
        timeout=60,
    )
    return (result.stdout or "") + (result.stderr or "")


def _session_files(home: Path) -> list[Path]:
    found: list[Path] = []
    for relative in ("runtime/sessions", "runtime/logs"):
        root = home / relative
        if root.exists():
            found.extend(root.rglob("*.jsonl"))
    return sorted(found)


def _recorded_models(home: Path) -> set[str]:
    found: set[str] = set()
    for path in _session_files(home):
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "model_request":
                continue
            model = event.get("model") or ""
            provider = event.get("provider") or ""
            if provider and model:
                found.add(f"{provider}/{model}")
            elif model:
                found.add(model)
    return found


def _preflight() -> str | None:
    if not os.environ.get("OPENROUTER_API_KEY"):
        return "OPENROUTER_API_KEY is not set."
    home = Path("/tmp/am-preflight-home")
    if home.exists():
        shutil.rmtree(home)
    home.mkdir()
    _write_home_config(home)
    env = _home_env(home)
    failed = _library_add(home, env)
    if failed:
        return failed
    session_path = home / "preflight.jsonl"
    result = subprocess.run(
        [*_cli(), "-p", "reply with OK", "--prompt-only", "--model", MODEL, "--session", str(session_path)],
        cwd=str(REPO),
        env=env,
        text=True,
        capture_output=True,
        timeout=180,
    )
    printed = (result.stdout or "") + (result.stderr or "")
    if result.returncode != 0:
        return "Preflight call failed: " + printed.strip()
    if "model " in printed and "->" in printed:
        return "Preflight substituted the model: " + printed.strip()
    ws = Path("/tmp/am-preflight-ws")
    if ws.exists():
        shutil.rmtree(ws)
    ws.mkdir()
    dist = REPO / "dist"
    if dist.exists():
        os.symlink(dist, ws / "dist")
    _session(ws, home, ["reply with OK"])
    fresh = _session_files(home)
    if not fresh:
        return "Preflight saved no session to inspect."
    inspected = subprocess.run(
        [*_cli(), "inspect", str(fresh[-1])],
        cwd=str(REPO),
        env=env,
        text=True,
        capture_output=True,
        timeout=60,
    )
    recorded = _recorded_models(home)
    if MODEL not in recorded:
        detail = (inspected.stdout or inspected.stderr or "").strip()
        return f"Preflight recorded {sorted(recorded) or '(none)'}, not {MODEL}. inspect: {detail[:500]}"
    return None


def _stop_hosts(home: Path) -> None:
    listing = subprocess.run(["ps", "eww", "-ax"], capture_output=True, text=True)
    marker = str(home)
    for line in (listing.stdout or "").splitlines():
        if "vera-host" not in line or marker not in line:
            continue
        pid = int(line.split()[0])
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


def _library() -> str:
    result = subprocess.run(
        ["bun", "clients/cli/main.ts", "library", "list"],
        cwd=str(REPO),
        env={**os.environ, "VERA_DEV_INSTANCE": "1", "VERA_HOME": DEV_HOME},
        text=True,
        capture_output=True,
        timeout=60,
    )
    return (result.stdout or "") + (result.stderr or "")


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
    env["HOME"] = "/Users/nash"
    env["VERA_HOME"] = str(home)
    env["VERA_DEV_INSTANCE"] = "1"
    proc = subprocess.Popen(
        ["bun", str(REPO / "clients/cli/main.ts"), "stdio"],
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
    """Filler only. Nash says the halibut line himself, in an earlier session."""
    code = r'''
import os, sys
os.environ["ACTIVMEM_EMBED"] = "0"
sys.path[:0] = ["src", "tests"]
from activmem.memory import ActivMem, _embed_text
from activmem.vectors import VectorStore
from corpus import filler
mem = ActivMem(sys.argv[1])
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


def _injected(ws: Path, message: str) -> str:
    path = ws / ".activmem" / "context-log.jsonl"
    if not path.exists() or not message:
        return ""
    found = ""
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("message") == message:
            found = row.get("context") or ""
    return found


def _grade(ws, home, first, second, said_halibut, third, condition, index) -> dict:
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
    injected = _injected(ws, seafood)
    lowered = injected.lower()
    check_b = (
        "current:" in lowered
        and "halibut" in lowered
        and "taken back:" in lowered
        and "pollock" in lowered
        and "sike" in lowered
        and "no longer true" in lowered
    )
    order = third[0]["reply"] if third else ""
    why = third[1]["reply"] if len(third) > 1 else ""
    judge_c = _judge(
        home,
        order,
        'Does the reply pick halibut as the recommendation, rather than merely listing it among options? '
        'Does it recommend pollock? Return only JSON: '
        '{"recommends_pollock": false, "picks_halibut": false}',
    )
    judge_d = _judge(
        home,
        why,
        'Does the reply say Nash took the pollock preference back? '
        'Does it recommend pollock? Return only JSON: '
        '{"recommends_pollock": false, "says_taken_back": false}',
    )
    parsed_c = _parse_json(judge_c)
    parsed_d = _parse_json(judge_d)
    check_c = parsed_c.get("picks_halibut") is True and parsed_c.get("recommends_pollock") is False
    check_d = parsed_d.get("says_taken_back") is True
    recorded = _recorded_models(home)
    discarded = any(model != MODEL for model in recorded) or not recorded
    mem.close()
    return {
        "condition": condition,
        "run": index,
        "model": MODEL,
        "recorded_models": sorted(recorded),
        "discarded": discarded,
        "sessions": [
            {"prompt": turn["prompt"], "reply": turn["reply"], "tools": turn["tools"]}
            for turn in [*first, *second, *said_halibut, *third]
        ],
        "injected": injected,
        "a": check_a,
        "b": check_b,
        "c": check_c,
        "d": check_d,
        "judge_c": judge_c,
        "judge_d": judge_d,
        "passed": (not discarded) and check_a and check_b and check_c and check_d,
    }


def _parse_json(text: str) -> dict:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        value = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _judge(home: Path, reply: str, rubric: str) -> str:
    prompt = f"{rubric}\n\nReply:\n{reply}"
    result = subprocess.run(
        ["bun", str(REPO / "clients/cli/main.ts"), "-p", prompt, "--prompt-only", "--model", MODEL],
        cwd=str(REPO),
        env=_home_env(home),
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
        f"Model recorded in the session files: `{MODEL}`.",
        "",
        f"ActivMem passed {activmem_pass} / {RUNS}. Control failed C or D in {control_fail} / {RUNS}.",
        "B is the injected block, C is whether the answer picked halibut, D is whether the explanation said the preference was taken back.",
        "If B passes and C fails, the memory worked and the model did not use it.",
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
