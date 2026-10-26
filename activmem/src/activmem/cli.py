"""argparse CLI. Human text by default, JSON with --json."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from activmem.events import ActivMemError, BrokenChainError, scan
from activmem.ingest import ingest_chat, ingest_text
from activmem.memory import ActivMem
from activmem.recall import format_explain, format_recall, format_true_at


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    except BrokenChainError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except ActivMemError as exc:
        print(str(exc), file=sys.stderr)
        return 1


def _main(argv: list[str] | None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    directory, as_json, force, rest = _globals(raw)
    parser = argparse.ArgumentParser(prog="activmem")
    sub = parser.add_subparsers(dest="command", required=True)

    save = sub.add_parser("save", help="save a piece of prose")
    save.add_argument("text", nargs="+")
    save.add_argument("--actor", required=True)
    save.add_argument("--session")
    save.add_argument("--true-at")
    save.add_argument("--learned-at")
    save.add_argument("--status", default="confirmed")

    annotate = sub.add_parser("annotate", help="record that one item revises another")
    annotate.add_argument("from_id")
    annotate.add_argument("kind")
    annotate.add_argument("to_id")
    annotate.add_argument("--actor", required=True)
    annotate.add_argument("--learned-at")

    recall = sub.add_parser("recall", help="spread activation from a question")
    recall.add_argument("question", nargs="+")
    recall.add_argument("--k", type=int)
    recall.add_argument("--steps", type=int)
    recall.add_argument("--retain", type=float)
    recall.add_argument("--carry", type=float)
    recall.add_argument("--as-of")
    recall.add_argument("--true-on")
    recall.add_argument("--explain", action="store_true")
    recall.add_argument("--seeds", choices=("words", "vectors", "both"), default="both")

    ingest = sub.add_parser("ingest", help="import chat jsonl or plain text")
    ingest_sub = ingest.add_subparsers(dest="ingest_command", required=True)
    chat = ingest_sub.add_parser("chat")
    chat.add_argument("file")
    text = ingest_sub.add_parser("text")
    text.add_argument("file")
    text.add_argument("--actor", default="nash")

    forget = sub.add_parser("forget", help="drop an item and tombstone it")
    forget.add_argument("item_id")
    forget.add_argument("--actor", required=True)

    sub.add_parser("rebuild", help="replay the log and report counts")
    sub.add_parser("stats", help="counts and log size")
    show = sub.add_parser("show", help="text, metadata, and links for an item")
    show.add_argument("item_id")
    sub.add_parser("verify", help="check the hash chain")
    sub.add_parser("serve", help="listen on .activmem/activmem.sock")

    args = parser.parse_args(rest)
    if args.command == "verify":
        return _verify(directory, as_json)
    if args.command == "serve":
        from activmem.server import serve

        return serve(directory, force=force)
    remote = _remote(directory, args, as_json)
    if remote is not None:
        return remote

    mem = ActivMem(directory, force=force)
    try:
        if mem.log.repaired_from is not None:
            print(
                f"dropped broken tail from line {mem.log.repaired_from.line}",
                file=sys.stderr,
            )
        if args.command == "save":
            item_id = mem.save(
                " ".join(args.text),
                actor=args.actor,
                session=args.session,
                true_at=_parse_true_at(args.true_at),
                status=args.status,
                learned_at=args.learned_at,
            )
            return _emit({"item_id": item_id}, as_json, item_id)
        if args.command == "annotate":
            mem.annotate(args.from_id, args.kind, args.to_id, actor=args.actor, learned_at=args.learned_at)
            message = f"linked {args.from_id} {args.kind} {args.to_id}"
            return _emit(
                {"from": args.from_id, "kind": args.kind, "to": args.to_id},
                as_json,
                message,
            )
        if args.command == "recall":
            result = mem.recall(
                " ".join(args.question),
                k=args.k,
                steps=args.steps,
                retain=args.retain,
                carry=args.carry,
                as_of=args.as_of,
                true_on=args.true_on,
                explain=args.explain,
                seeds=args.seeds,
            )
            if as_json:
                return _emit(result.to_dict(), True, "")
            if args.explain:
                print(format_explain(result, mem.index.graph))
            else:
                print(format_recall(result))
            return 0
        if args.command == "ingest":
            if args.ingest_command == "chat":
                report = ingest_chat(mem, args.file)
            else:
                report = ingest_text(mem, args.file, actor=args.actor)
            human = f"added {report.added}, skipped {report.skipped}"
            return _emit(report.to_dict(), as_json, human)
        if args.command == "forget":
            mem.forget(args.item_id, actor=args.actor)
            return _emit({"forgot": args.item_id}, as_json, f"forgot {args.item_id}")
        if args.command == "rebuild":
            stats = mem.rebuild()
            human = (
                f"replayed {stats['replayed']} events\n"
                f"chunks: {stats['chunks']}\n"
                f"terms: {stats['terms']}\n"
                f"edges: {stats['edges']}\n"
                f"log_bytes: {stats['log_bytes']}"
            )
            return _emit(stats, as_json, human)
        if args.command == "stats":
            stats = mem.stats()
            human = (
                f"events: {stats['events']}\n"
                f"chunks: {stats['chunks']}\n"
                f"terms: {stats['terms']}\n"
                f"edges: {stats['edges']}\n"
                f"log_bytes: {stats['log_bytes']}"
            )
            return _emit(stats, as_json, human)
        if args.command == "show":
            view = mem.show(args.item_id)
            return _emit(view, as_json, _format_show(view))
    finally:
        mem.close()
    return 0


def _remote(directory: str, args, as_json: bool) -> int | None:
    from activmem.server import try_call

    method = None
    params: dict = {}
    human = ""
    if args.command == "save":
        # CLI save is one chunk. Vera uses save_turn on the socket.
        return None
    if args.command == "recall":
        method = "recall"
        params = {
            "question": " ".join(args.question),
            "k": args.k,
            "seeds": args.seeds,
            "explain": args.explain,
            "carry": args.carry,
        }
    elif args.command == "forget":
        method = "forget"
        params = {"item": args.item_id, "actor": args.actor}
        human = f"forgot {args.item_id}"
    elif args.command == "annotate":
        method = "revise"
        params = {"new_item": args.from_id, "old_item": args.to_id, "actor": args.actor}
        human = f"linked {args.from_id} {args.kind} {args.to_id}"
    elif args.command == "stats":
        method = "stats"
    else:
        return None
    response = try_call(directory, method, params)
    if response is None:
        return None
    if not response.get("ok"):
        print(response.get("error") or "server error", file=sys.stderr)
        return 1
    result = response.get("result")
    if args.command == "recall" and not as_json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    if args.command == "stats" and not as_json and isinstance(result, dict):
        human = (
            f"events: {result.get('events')}\n"
            f"chunks: {result.get('chunks')}\n"
            f"terms: {result.get('terms')}\n"
            f"edges: {result.get('edges')}\n"
            f"log_bytes: {result.get('log_bytes')}"
        )
    if args.command == "forget":
        human = f"forgot {args.item_id}"
    return _emit(result if isinstance(result, dict) else {"result": result}, as_json, human)


def _verify(directory: str, as_json: bool) -> int:
    path = Path(directory) / ".activmem" / "events.jsonl"
    events, info = scan(path)
    if info is not None:
        payload = {"ok": False, "line": info.line, "message": info.message, "events": len(events)}
        text = f"broken at line {info.line}: {info.message}"
        _emit(payload, as_json, text, stream=sys.stderr)
        return 1
    payload = {"ok": True, "events": len(events)}
    return _emit(payload, as_json, f"ok ({len(events)} events)")


def _parse_true_at(value: str | None):
    if value is None:
        return None
    if ".." in value:
        start, end = value.split("..", 1)
        start = start.strip() or None
        end = end.strip() or None
        return (start, end)
    return value


def _format_show(view: dict) -> str:
    lines = [
        view["id"],
        f"text: {view.get('text')}",
        f"kind: {view.get('kind')}",
        f"actor: {view.get('actor')}",
        f"status: {view.get('status')}",
        f"learned_at: {view.get('learned_at')}",
        f"true_at: {format_true_at(view.get('true_at'))}",
        f"session: {view.get('session')}",
        f"revised_by: {view.get('revised_by') or 'none'}",
    ]
    if view.get("revising_text"):
        lines.append(f"revising: {view['revising_text']}")
    lines.append("out:")
    if not view["out"]:
        lines.append("  (none)")
    for edge in view["out"]:
        lines.append(f"  {edge['kind']} {edge['other']} {edge['weight'] * edge['sign']:+.1f}")
    lines.append("in:")
    if not view["in"]:
        lines.append("  (none)")
    for edge in view["in"]:
        lines.append(f"  {edge['kind']} {edge['other']} {edge['weight'] * edge['sign']:+.1f}")
    return "\n".join(lines)


def _emit(payload: dict, as_json: bool, human: str, stream=None) -> int:
    out = stream or sys.stdout
    if as_json:
        json.dump(payload, out, indent=2, ensure_ascii=False)
        out.write("\n")
    elif human:
        print(human, file=out)
    return 0


def _globals(argv: list[str]) -> tuple[str, bool, bool, list[str]]:
    directory = "."
    as_json = False
    force = False
    rest: list[str] = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--json":
            as_json = True
        elif arg == "--force":
            force = True
        elif arg == "--dir" and index + 1 < len(argv):
            index += 1
            directory = argv[index]
        elif arg.startswith("--dir="):
            directory = arg.split("=", 1)[1]
        else:
            rest.append(arg)
        index += 1
    return directory, as_json, force, rest
