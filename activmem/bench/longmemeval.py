"""LongMemEval-S. Same answering model for every condition. Resumable.

Conditions a and d use a fixed 100-question sample. b and c use all 500.
The judge prompt is LongMemEval's own. The judge model is ACTIVMEM_MODEL.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
DATA = ROOT / "bench" / "data" / "longmemeval_s_cleaned.json"
CACHE = ROOT / "bench" / "cache" / "longmemeval"
SAMPLE_PATH = ROOT / "bench" / "data" / "sample100.json"
MODEL = os.environ.get("ACTIVMEM_MODEL", "openrouter/deepseek/deepseek-v4.1-flash")

sys.path.insert(0, str(ROOT / "src"))

from activmem.memory import ActivMem
from activmem.recall import format_context


def main() -> int:
    rows = json.loads(DATA.read_text(encoding="utf-8"))
    sample = _sample(rows)
    by_id = {row["question_id"]: row for row in rows}
    plan = (
        [("a", qid) for qid in sample]
        + [("b", row["question_id"]) for row in rows]
        + [("c", row["question_id"]) for row in rows]
        + [("d", qid) for qid in sample]
    )
    calls = 0
    for condition, qid in plan:
        path = CACHE / condition / f"{qid}.json"
        if path.exists():
            continue
        print(condition, qid, flush=True)
        record, used = _run(condition, by_id[qid])
        calls += used
        if record.get("blocked"):
            print("BLOCKED", record["blocked"], flush=True)
            return 2
        if record.get("error") or not (record.get("answer") or "").strip():
            print("skip", qid, (record.get("error") or "empty")[:200], flush=True)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record), encoding="utf-8")
    _report(rows, sample)
    print("model_calls_this_process", calls, flush=True)
    return 0


def _sample(rows: list[dict]) -> list[str]:
    if SAMPLE_PATH.exists():
        return json.loads(SAMPLE_PATH.read_text(encoding="utf-8"))
    groups: dict[str, list[str]] = {}
    for row in rows:
        groups.setdefault(row["question_type"], []).append(row["question_id"])
    for ids in groups.values():
        ids.sort()
    picked: list[str] = []
    cursor = {key: 0 for key in groups}
    while len(picked) < 100:
        for key in sorted(groups):
            index = cursor[key]
            if index < len(groups[key]):
                picked.append(groups[key][index])
                cursor[key] = index + 1
            if len(picked) == 100:
                break
    SAMPLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    SAMPLE_PATH.write_text(json.dumps(picked), encoding="utf-8")
    return picked


def _run(condition: str, row: dict) -> tuple[dict, int]:
    calls = 0
    if condition == "a":
        excerpts = _full_text(row)
        recall_ms = 0.0
    else:
        excerpts, recall_ms, calls = _memory(row, condition)
    answer, answer_model, used = _ask(_answer_prompt(row["question"], excerpts), bare=True)
    calls += used
    if answer_model == "error":
        return {"error": answer}, calls
    if answer_model != MODEL:
        return {"blocked": f"answer model {answer_model}"}, calls
    prompt = _judge_prompt(row, answer)
    judgement, judge_model, used = _ask(prompt, bare=False)
    calls += used
    if judge_model == "error":
        return {"error": judgement}, calls
    if judge_model != MODEL:
        return {"blocked": f"judge model {judge_model}"}, calls
    return {
        "question_id": row["question_id"],
        "question_type": row["question_type"],
        "abstention": str(row["question_id"]).endswith("_abs"),
        "correct": "yes" in judgement.lower(),
        "judgement": judgement.strip(),
        "answer": answer.strip(),
        "recall_ms": recall_ms,
        "context_chars": len(excerpts),
        "model": MODEL,
    }, calls


def _memory(row: dict, condition: str) -> tuple[str, float, int]:
    calls = 0
    root = Path(tempfile.mkdtemp(prefix="lme-"))
    os.environ["ACTIVMEM_EMBED"] = "1"
    os.environ["ACTIVMEM_GRAPH"] = "off" if condition == "b" else "on"
    mem = ActivMem(root)
    try:
        for index, (session, date) in enumerate(zip(row["haystack_sessions"], row["haystack_dates"])):
            when = _when(date)
            _save_session(mem, session, f"s{index}", when)
            if condition == "d":
                calls += _revise_pass(mem, session)
        if condition == "b":
            mem.graph_on = False
        result = mem.recall(row["question"], k=5, carry=0)
        return format_context(result), result.ms, calls
    finally:
        mem.close()


def _save_session(mem: ActivMem, turns: list[dict], session: str, when: str) -> None:
    pending_user = None
    for turn in turns:
        role = turn.get("role")
        text = (turn.get("content") or "").strip()
        if not text:
            continue
        if role == "user":
            if pending_user:
                mem.save(pending_user, actor="nash", session=session, learned_at=when, true_at=when[:10])
            pending_user = text
        elif role == "assistant" and pending_user:
            mem.save_turn(pending_user, text, session, learned_at=when)
            pending_user = None
        else:
            mem.save(text, actor="assistant", session=session, learned_at=when, true_at=when[:10])
    if pending_user:
        mem.save(pending_user, actor="nash", session=session, learned_at=when, true_at=when[:10])


def _revise_pass(mem: ActivMem, turns: list[dict]) -> int:
    text = " ".join((turn.get("content") or "") for turn in turns if turn.get("role") == "user")[:400]
    if not text.strip():
        return 0
    recalled = mem.recall(text, k=5, carry=0)
    earlier = [hit for hit in recalled.results if hit.text not in text]
    if not earlier:
        return 0
    lines = "\n".join(f"{hit.item_id}: {hit.text}" for hit in earlier[:5])
    prompt = (
        "The new session may replace one earlier memory. "
        'Return only JSON: {"old_id": "<id or empty>"}\n\n'
        f"New session:\n{text}\n\nEarlier:\n{lines}"
    )
    raw, model, _used = _ask(prompt, bare=False)
    if model != MODEL:
        return 1
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        return 1
    try:
        old_id = json.loads(raw[start:end + 1]).get("old_id") or ""
    except json.JSONDecodeError:
        return 1
    if old_id and old_id in mem.index.graph:
        mem.revise(text[:200], old_id, actor="vera", session="revise")
    return 1


def _full_text(row: dict) -> str:
    parts = []
    for session, date in zip(row["haystack_sessions"], row["haystack_dates"]):
        parts.append(f"[{date}]")
        for turn in session:
            parts.append(f"{turn.get('role')}: {turn.get('content')}")
    return "\n".join(parts)


def _answer_prompt(question: str, excerpts: str) -> str:
    return (
        "Answer the question using only the excerpts. "
        "If they do not contain the answer, say you do not know.\n\n"
        f"Excerpts:\n{excerpts}\n\nQuestion: {question}"
    )


def _judge_prompt(row: dict, hypothesis: str) -> str:
    question = row["question"]
    answer = row["answer"]
    task = row["question_type"]
    abstention = str(row["question_id"]).endswith("_abs")
    if abstention:
        template = (
            "I will give you an unanswerable question, an explanation, and a response from a model. "
            "Please answer yes if the model correctly identifies the question as unanswerable. "
            "The model could say that the information is incomplete, or some other information is given but the asked information is not. "
            "\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\n"
            "Does the model correctly identify the question as unanswerable? Answer yes or no only."
        )
    elif task in ("single-session-user", "single-session-assistant", "multi-session"):
        template = (
            "I will give you a question, a correct answer, and a response from a model. "
            "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
            "If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. "
            "If the response only contains a subset of the information required by the answer, answer no. "
            "\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\n"
            "Is the model response correct? Answer yes or no only."
        )
    elif task == "temporal-reasoning":
        template = (
            "I will give you a question, a correct answer, and a response from a model. "
            "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
            "If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. "
            "If the response only contains a subset of the information required by the answer, answer no. "
            "In addition, do not penalize off-by-one errors for the number of days. "
            "If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. "
            "\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\n"
            "Is the model response correct? Answer yes or no only."
        )
    elif task == "knowledge-update":
        template = (
            "I will give you a question, a correct answer, and a response from a model. "
            "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
            "If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\n"
            "Question: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\n"
            "Is the model response correct? Answer yes or no only."
        )
    else:
        template = (
            "I will give you a question, a rubric for desired personalized response, and a response from a model. "
            "Please answer yes if the response satisfies the desired response. Otherwise, answer no. "
            "The model does not need to reflect all the points in the rubric. "
            "The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\n"
            "Question: {}\n\nRubric: {}\n\nModel Response: {}\n\n"
            "Is the model response correct? Answer yes or no only."
        )
    return template.format(question, answer, hypothesis)


_HOME: Path | None = None


def _ask(prompt: str, bare: bool) -> tuple[str, str, int]:
    home, env = _model_home()
    mode = "bare" if bare else "prompt_only"
    prompt_path = home / "prompt.txt"
    prompt_path.write_text(prompt, encoding="utf-8")
    session = home / "turn.jsonl"
    result = subprocess.run(
        ["bun", str(ROOT / "bench" / "ask.ts"), str(prompt_path), mode, MODEL, str(session)],
        cwd=str(Path(tempfile.mkdtemp(prefix="lme-ws-"))),
        env=env,
        text=True,
        capture_output=True,
        timeout=300,
    )
    printed = (result.stdout or "") + (result.stderr or "")
    if result.returncode != 0:
        return printed.strip(), "error", 1
    if "model " in printed and "->" in printed:
        return printed.strip(), "substituted", 1
    recorded = _one_model(home)
    return (result.stdout or "").strip(), recorded or MODEL, 1


def _model_home() -> tuple[Path, dict]:
    global _HOME
    if _HOME is None:
        _HOME = Path(tempfile.mkdtemp(prefix="lme-home-"))
        provider, model_id = MODEL.split("/", 1)
        (_HOME / "config.json").write_text(json.dumps({
            "schema_version": 1,
            "provider": provider,
            "model": model_id,
            "reasoning_effort": "low",
            "approval_mode": "auto",
        }), encoding="utf-8")
        env = os.environ.copy()
        env["HOME"] = "/Users/nash"
        env["VERA_HOME"] = str(_HOME)
        env["VERA_DEV_INSTANCE"] = "1"
        subprocess.run(
            ["bun", str(REPO / "clients/cli/main.ts"), "library", "add", MODEL],
            cwd=str(REPO), env=env, text=True, capture_output=True, timeout=60,
        )
    env = os.environ.copy()
    env["HOME"] = "/Users/nash"
    env["VERA_HOME"] = str(_HOME)
    env["VERA_DEV_INSTANCE"] = "1"
    return _HOME, env


def _one_model(home: Path) -> str:
    found = ""
    logs = home / "runtime" / "logs"
    if not logs.exists():
        return found
    files = sorted(logs.rglob("*.jsonl"), key=lambda path: path.stat().st_mtime)
    for path in files[-1:]:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "model_request" and event.get("provider") and event.get("model"):
                found = f"{event['provider']}/{event['model']}"
    return found


def _when(value: str) -> str:
    stamp = value.split(" (")[0].strip()
    parsed = datetime.strptime(stamp, "%Y/%m/%d %H:%M")
    return parsed.strftime("%Y-%m-%dT%H:%M:00Z")


def _report(rows: list[dict], sample: list[str]) -> None:
    print("sample100", len(sample), flush=True)
    for condition in "abcd":
        folder = CACHE / condition
        files = list(folder.glob("*.json")) if folder.exists() else []
        print(condition, "cached", len(files), flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
