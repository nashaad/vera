from __future__ import annotations

from collections.abc import Callable
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import importlib.util
import os
import secrets
import socket
import sys
from threading import Thread
from urllib.parse import parse_qs

from ._errors import WorkflowError
from ._store import default_journal_dir, store_from_path
from .api import _Workflow


USAGE = (
    "usage: python -m vera.workflow list [--journal-dir DIR]\n"
    "       python -m vera.workflow show <run_id> [--journal-dir DIR]\n"
    "       python -m vera.workflow resume <run_id> [--journal-dir DIR]\n"
    "       python -m vera.workflow cancel <run_id> [--journal-dir DIR]\n"
    "       python -m vera.workflow answer <run_id> [TEXT] [--journal-dir DIR]\n"
    "       python -m vera.workflow sweep [--resume] [--journal-dir DIR]"
)

CANCEL_REASON = "cancelled from the command line"


def _list(journal_dir: Path) -> None:
    summaries = store_from_path(journal_dir).runs()
    if not summaries:
        print(f"no workflow runs in {journal_dir}")
        return
    width = max(len(summary.workflow) for summary in summaries)
    for summary in summaries:
        print(
            f"{summary.run_id}  {summary.status:<9}  "
            f"{summary.workflow:<{width}}  {summary.started_at}"
        )


def _show(journal_dir: Path, run_id: str) -> None:
    store = store_from_path(journal_dir)
    journal = store.load(run_id, None)
    print(f"run    {journal.run_id}")
    print(f"name   {journal.header['workflow']}")
    print(f"status {journal.header['status']}")
    doc = journal.header["doc"]
    if doc:
        print(f"doc    {doc}")
    print("steps")
    for key in journal.records:
        timing = journal.timings.get(key, {})
        ms = timing.get("ms")
        print(f"  {key}" if ms is None else f"  {key}  {ms}ms")
    active = journal.header.get("active")
    if type(active) is dict:
        print(f"active {active['step']}  since {active['at']}")
    asking = journal.header.get("asking")
    if type(asking) is dict:
        print(f"asking {asking.get('question')}")
    spans = journal.spans()
    spend = _spend(spans)
    if spend is not None:
        print(f"cost   ${spend:.4f}")
    attempts = journal.header.get("attempts")
    if type(attempts) is list and attempts:
        print("attempts")
        for number, attempt in enumerate(attempts, start=1):
            print(f"  {number}  {_attempt_line(attempt)}")
            for span in spans:
                if _attributes_of(span).get("halcyon.attempt") != number:
                    continue
                depth = str(span.get("parent_id", "")).count(".")
                print(f"       {'  ' * depth}{_span_line(span)}")


def _attempt_line(attempt: object) -> str:
    if type(attempt) is not dict:
        return "unreadable"
    where = f"{attempt.get('host')} pid {attempt.get('pid')}"
    outcome = attempt.get("status")
    if outcome is None:
        return f"{attempt.get('started_at')}  {where}  did not finish"
    error = attempt.get("error")
    detail = f": {error['message']}" if type(error) is dict else ""
    return f"{attempt.get('started_at')}  {where}  {outcome}{detail}"


def _attributes_of(span: dict[str, object]) -> dict[str, object]:
    attributes = span.get("attributes")
    return attributes if type(attributes) is dict else {}


def _spend(spans: list[dict[str, object]]) -> float | None:
    """What the recorded model calls cost, or nothing when none said."""
    costs = [
        cost
        for span in spans
        if type(cost := _attributes_of(span).get("llm.cost.total")) in (int, float)
    ]
    return sum(costs) if costs else None


def _span_line(span: dict[str, object]) -> str:
    name = span.get("name")
    attributes = _attributes_of(span)
    outcome = attributes.get("halcyon.outcome")
    if outcome is None:
        return f"{name}  did not finish"
    message = span.get("status_message")
    detail = f": {message}" if outcome != "ok" and type(message) is str else ""
    line = f"{name}  {attributes.get('halcyon.duration_ms')}ms  {outcome}{detail}"
    return line + _usage_note(attributes)


def _usage_note(attributes: dict[str, object]) -> str:
    total = attributes.get("llm.token_count.total")
    if total is None:
        return ""
    cost = attributes.get("llm.cost.total")
    priced = f"  ${cost:.4f}" if type(cost) in (int, float) else ""
    return f"  {total} tokens{priced}"


def _sweep(journal_dir: Path, resume: bool) -> int:
    store = store_from_path(journal_dir)
    here = socket.gethostname()
    marked = 0
    crashed: list[str] = []
    for summary in store.runs():
        if summary.status not in ("running", "crashed"):
            continue
        journal = store.load(summary.run_id, None)
        if summary.status == "running":
            pid = _dead_pid(journal.header, here)
            if pid is None:
                continue
            marked += 1
            journal.mark_crashed(f"process {pid} on {here} did not come back")
            print(f"{summary.run_id} crashed  {summary.workflow}  pid {pid}")
        crashed.append(summary.run_id)
    if marked == 0:
        print(f"no new crashes in {journal_dir}")
    if not crashed:
        return 0
    if not resume:
        print(f"{len(crashed)} crashed; pass --resume to run them again")
        return 0
    code = 0
    for run_id in crashed:
        if store.load(run_id, None).cancel_requested() is not None:
            print(f"{run_id} not resumed; a cancel was asked for")
            continue
        code = max(code, _resume(journal_dir, run_id))
    return code


def _dead_pid(header: dict[str, object], here: str) -> int | None:
    """The pid of the process that left this run, when it is gone from here."""
    attempt = _open_attempt(header)
    if attempt is None or attempt.get("host") != here:
        return None
    pid = attempt.get("pid")
    if type(pid) is not int or _alive(pid):
        return None
    return pid


def _open_attempt(header: dict[str, object]) -> dict[str, object] | None:
    attempts = header.get("attempts")
    if type(attempts) is not list or not attempts:
        return None
    attempt = attempts[-1]
    if type(attempt) is not dict or "finished_at" in attempt:
        return None
    return attempt


def _alive(pid: int) -> bool:
    """Whether this machine still has that process.

    A pid the operating system has handed out again reads as alive, which keeps
    a crashed run listed as running rather than resuming something twice.
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _cancel(journal_dir: Path, run_id: str) -> int:
    journal = store_from_path(journal_dir).load(run_id, None)
    status = journal.header["status"]
    if status == "running":
        journal.request_cancel(CANCEL_REASON)
        print(f"{run_id} cancel requested; it stops before its next step")
        return 0
    if status == "suspended":
        journal.mark_cancelled(CANCEL_REASON)
        print(f"{run_id} cancelled")
        return 0
    print(f"{run_id} is already {status}", file=sys.stderr)
    return 2


def _answer(journal_dir: Path, run_id: str, text: str | None) -> int:
    journal = store_from_path(journal_dir).load(run_id, None)
    asking = journal.header.get("asking")
    if journal.header["status"] != "suspended" or type(asking) is not dict:
        print(f"{run_id} is not waiting on a question", file=sys.stderr)
        return 2
    key = asking.get("key")
    question = asking.get("question")
    if type(key) is not str or type(question) is not str:
        raise WorkflowError("journal", "workflow header asking is incomplete")
    if text is None:
        print(f"{run_id} is asking: {question}")
        try:
            text = _serve_answer(
                run_id,
                question,
                lambda url: print(f"answer at {url}", flush=True),
            )
        except KeyboardInterrupt:
            print(f"\n{run_id} is still waiting", file=sys.stderr)
            return 130
    journal.put_inbox(key, text)
    print(f"{run_id} answered")
    return _resume(journal_dir, run_id)


def _serve_answer(run_id: str, question: str, ready: Callable[[str], None]) -> str:
    """Serve one page on localhost that takes one answer, then stop."""
    token = secrets.token_urlsafe(12)
    path = f"/{token}"
    answers: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != path:
                self.send_error(404)
                return
            self._send(200, _answer_page(run_id, question))

        def do_POST(self) -> None:
            if self.path != path:
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length") or 0)
            form = parse_qs(self.rfile.read(length).decode("utf-8"))
            answer = form.get("answer", [""])[0].strip()
            if not answer:
                self._send(400, _answer_page(run_id, question))
                return
            answers.append(answer)
            self._send(200, _answered_page(run_id))
            Thread(target=self.server.shutdown, daemon=True).start()

        def log_message(self, format: str, *args: object) -> None:
            return

        def _send(self, status: int, body: str) -> None:
            encoded = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    try:
        ready(f"http://127.0.0.1:{server.server_port}{path}")
        server.serve_forever()
    finally:
        server.server_close()
    return answers[0]


_PAGE_STYLE = """
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #d6d3d1; --accent: #166534; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111110; --fg: #e7e5e4; --muted: #a8a29e; --line: #3a3835; --accent: #86efac; }
}
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 640px; margin: 48px auto; padding: 0 16px; }
.run { color: var(--muted); font: 12px ui-monospace, monospace; }
.question { white-space: pre-wrap; margin: 12px 0 20px; font-size: 17px; }
textarea { width: 100%; box-sizing: border-box; min-height: 96px; padding: 10px;
  background: transparent; color: inherit; border: 1px solid var(--line);
  border-radius: 6px; font: inherit; }
button { margin-top: 12px; padding: 8px 18px; border: 0; border-radius: 6px;
  background: var(--accent); color: var(--bg); font: inherit; cursor: pointer; }
"""


def _answer_page(run_id: str, question: str) -> str:
    return (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"<title>Answer {html.escape(run_id)}</title><style>{_PAGE_STYLE}</style>"
        f"</head><body><main><div class=\"run\">{html.escape(run_id)} is asking</div>"
        f"<div class=\"question\">{html.escape(question)}</div>"
        "<form method=\"post\"><textarea name=\"answer\" autofocus required>"
        "</textarea><button type=\"submit\">Send</button></form>"
        "</main></body></html>"
    )


def _answered_page(run_id: str) -> str:
    return (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        f"<title>Answered</title><style>{_PAGE_STYLE}</style></head><body><main>"
        f"<div class=\"run\">{html.escape(run_id)}</div>"
        "<p>Answered. The run carries on in the terminal.</p>"
        "</main></body></html>"
    )


def _resume(journal_dir: Path, run_id: str) -> int:
    store = store_from_path(journal_dir)
    journal = store.load(run_id, None)
    entry = journal.header.get("entry")
    if type(entry) is not dict:
        raise WorkflowError(
            "journal",
            "workflow header has no entry; call .resume in the original process",
        )
    file = entry.get("file")
    workflow_name = entry.get("workflow")
    cwd = entry.get("cwd")
    if type(file) is not str or type(workflow_name) is not str or type(cwd) is not str:
        raise WorkflowError("journal", "workflow header entry is incomplete")
    source = Path(file)
    if not source.is_file():
        raise WorkflowError("journal", f"workflow entry file does not exist: {source}")
    module = _load_entry_module(source, run_id)
    found = None
    for value in vars(module).values():
        if isinstance(value, _Workflow) and value.name == workflow_name:
            found = value
            break
    if found is None:
        raise WorkflowError(
            "journal",
            f"workflow {workflow_name!r} not found in {source}",
        )
    previous = Path.cwd()
    try:
        os.chdir(cwd)
    except OSError as error:
        raise WorkflowError(
            "journal",
            f"workflow entry cwd does not exist: {cwd}",
        ) from error
    try:
        run = found.resume(run_id, journal=store)
    finally:
        os.chdir(previous)
    if run.status == "ok":
        print(run.id, run.status, run.result)
        return 0
    print(run.id, run.status, run.error, file=sys.stderr)
    return 1


def _load_entry_module(source: Path, run_id: str) -> object:
    package = _package_entry(source)
    if package is not None:
        root, dotted = package
        sys.path.insert(0, str(root))
        try:
            return importlib.import_module(dotted)
        except ImportError as error:
            raise WorkflowError(
                "journal",
                f"cannot import workflow entry module {dotted}: {error}",
            ) from error

    name = f"vera_workflow_entry_{run_id}"
    spec = importlib.util.spec_from_file_location(name, source)
    if spec is None or spec.loader is None:
        raise WorkflowError("journal", f"cannot load workflow entry file: {source}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _package_entry(source: Path) -> tuple[Path, str] | None:
    """Where an entry file sits in a package, and what to import it as.

    A module loaded from a path cannot run its own relative imports, so a
    workflow defined inside a package is imported by dotted name instead.
    """
    parts = [source.stem]
    directory = source.parent
    while (directory / "__init__.py").is_file():
        parts.append(directory.name)
        directory = directory.parent
    if len(parts) == 1:
        return None
    return directory, ".".join(reversed(parts))


def _parse(arguments: list[str]) -> tuple[str, str, Path, bool, str | None] | None:
    commands = {"list", "show", "resume", "cancel", "sweep", "answer"}
    if not arguments or arguments[0] not in commands:
        return None
    command = arguments[0]
    rest = arguments[1:]
    directory: Path | None = None
    if len(rest) >= 2 and rest[-2] == "--journal-dir":
        directory = Path(rest[-1])
        rest = rest[:-2]
    resume = command == "sweep" and "--resume" in rest
    if resume:
        rest = [argument for argument in rest if argument != "--resume"]
    text: str | None = None
    if command == "answer" and len(rest) == 2:
        text = rest.pop()
    wanted = 0 if command in ("list", "sweep") else 1
    if len(rest) != wanted:
        return None
    run_id = rest[0] if wanted else ""
    return (
        command,
        run_id,
        directory if directory is not None else default_journal_dir(),
        resume,
        text,
    )


def _main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    parsed = _parse(arguments)
    if parsed is None:
        print(USAGE, file=sys.stderr)
        return 2
    command, run_id, path, resume, text = parsed
    try:
        if command == "list":
            _list(path)
            return 0
        if command == "sweep":
            return _sweep(path, resume)
        if command == "show":
            _show(path, run_id)
            return 0
        if command == "cancel":
            return _cancel(path, run_id)
        if command == "answer":
            return _answer(path, run_id, text)
        return _resume(path, run_id)
    except WorkflowError as error:
        print(error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(_main())
