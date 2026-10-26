import json

from activmem.cli import main


def _run(argv: list[str]) -> tuple[int, str, str]:
    import contextlib
    from io import StringIO

    out = StringIO()
    err = StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = main(argv)
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
    return code, out.getvalue(), err.getvalue()


def test_commands_run_end_to_end(tmp_path):
    root = str(tmp_path)
    code, out, err = _run(["--dir", root, "save", "I really like pollock.", "--actor", "nash", "--session", "life"])
    assert code == 0, err
    pollock = out.strip()
    assert pollock.startswith("like-pollock-")

    code, out, err = _run(["--dir", root, "save", "psych, I don't", "--actor", "nash", "--session", "life"])
    assert code == 0, err
    psych = out.strip()

    code, out, err = _run(["--dir", root, "save", "Halibut is my favourite fish.", "--actor", "nash"])
    assert code == 0, err
    assert out.strip().startswith("halibut-favourite-fish-")

    code, out, err = _run(["--dir", root, "annotate", psych, "revises", pollock, "--actor", "nash"])
    assert code == 0, err
    assert "revises" in out

    code, out, err = _run(["--dir", root, "recall", "What fish do I like?", "--explain"])
    assert code == 0, err
    assert "seeds" in out
    assert "step 1" in out
    assert "inhibitions" in out
    assert "Halibut" in out
    assert "final ranking" in out

    code, out, err = _run(["--dir", root, "--json", "recall", "What fish do I like?"])
    assert code == 0, err
    payload = json.loads(out)
    assert "results" in payload and "suppressed" in payload and "ms" in payload
    assert "nodes_touched" in payload
    assert any("Halibut" in hit["text"] for hit in payload["results"])

    code, out, err = _run(["--dir", root, "show", pollock])
    assert code == 0, err
    assert "I really like pollock." in out
    assert "revises" in out or "revised_by" in out

    code, out, err = _run(["--dir", root, "stats"])
    assert code == 0, err
    assert "events:" in out
    assert "chunks:" in out
    assert "log_bytes:" in out

    code, out, err = _run(["--dir", root, "--json", "rebuild"])
    assert code == 0, err
    rebuilt = json.loads(out)
    assert rebuilt["replayed"] >= 4
    assert rebuilt["chunks"] == 3

    chat = tmp_path / "chat.jsonl"
    chat.write_text('{"role":"user","text":"The kettle lives on the hob."}\n', encoding="utf-8")
    code, out, err = _run(["--dir", root, "ingest", "chat", str(chat)])
    assert code == 0, err
    assert "added 1" in out
    code, out, err = _run(["--dir", root, "ingest", "chat", str(chat)])
    assert code == 0, err
    assert "skipped 1" in out

    notes = tmp_path / "notes.txt"
    notes.write_text("Plain note about velvet.\n\nAnother note about copper.\n", encoding="utf-8")
    code, out, err = _run(["--dir", root, "ingest", "text", str(notes), "--actor", "nash"])
    assert code == 0, err
    assert "added 2" in out

    code, out, err = _run(["--dir", root, "recall", "Where is the kettle?", "--as-of", "2026-10-25", "--true-on", "2026-10-25"])
    assert code == 0, err

    code, out, err = _run(["--dir", root, "forget", pollock, "--actor", "nash"])
    assert code == 0, err
    assert "forgot" in out

    code, out, err = _run(["--dir", root, "verify"])
    assert code == 0, err
    assert "ok" in out

    code, out, err = _run(["--dir", root, "show", "not-an-item"])
    assert code == 1
    assert "unknown item" in err

    code, out, err = _run(["--dir", root, "annotate", psych, "causes", psych, "--actor", "nash"])
    assert code == 1
    assert "bad link kind" in err

    code, out, err = _run(["--dir", root, "save", "Missing the actor."])
    assert code != 0


def test_verify_reports_a_tampered_line(tmp_path):
    root = str(tmp_path)
    assert _run(["--dir", root, "save", "Hello chain.", "--actor", "nash"])[0] == 0
    assert _run(["--dir", root, "save", "Second line stays.", "--actor", "nash"])[0] == 0
    path = tmp_path / ".activmem" / "events.jsonl"
    lines = path.read_text(encoding="utf-8").splitlines()
    lines[1] = lines[1].replace("Second", "Sec0nd", 1)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    code, out, err = _run(["--dir", root, "verify"])
    assert code == 1
    assert "line 2" in err
    code, out, err = _run(["--dir", root, "--json", "verify"])
    assert code == 1
    payload = json.loads(out or err)
    assert payload["ok"] is False
    assert payload["line"] == 2
