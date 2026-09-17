from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from vera.workflow.api import (
    FileJournalStore,
    SqliteJournalStore,
    WorkflowError,
    step,
    workflow,
)
from vera.workflow._sql import PostgresDialect, SqliteDialect


class TestJournalStore(unittest.TestCase):
    def test_sqlite_run_resume_and_blob(self) -> None:
        value = "x" * 9000

        @step
        def large() -> str:
            return value

        @workflow
        def produce() -> str:
            return large()

        with tempfile.TemporaryDirectory() as temporary_directory:
            db = Path(temporary_directory) / "runs.sqlite"
            store = SqliteJournalStore(db)
            first = produce.run(journal=store)
            resumed = produce.resume(first.id, journal=store)

            self.assertEqual(first.status, "ok")
            self.assertEqual(first.result, value)
            self.assertEqual(resumed.result, value)
            self.assertTrue(db.is_file())

    def test_file_store_matches_journal_dir(self) -> None:
        @step
        def add(n: int) -> int:
            return n + 1

        @workflow
        def total(n: int) -> int:
            return add(n)

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = total.run(3, journal=FileJournalStore(journal_dir))
            header = json.loads(
                (journal_dir / run.id / "header.json").read_text(encoding="utf-8")
            )
            self.assertEqual(run.result, 4)
            self.assertEqual(header["entry"]["workflow"], "total")
            self.assertTrue(header["entry"]["file"].endswith(".py"))
            self.assertEqual(header["entry"]["cwd"], str(Path.cwd()))

    def test_refuse_both_journal_and_journal_dir(self) -> None:
        @workflow
        def empty() -> int:
            return 1

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            with self.assertRaises(WorkflowError) as raised:
                empty.run(
                    journal_dir=journal_dir,
                    journal=FileJournalStore(journal_dir),
                )
            self.assertEqual(raised.exception.kind, "journal")

    def test_postgres_dialect_uses_percent_s(self) -> None:
        sqlite = SqliteDialect()
        postgres = PostgresDialect()
        self.assertEqual(sqlite.placeholder, "?")
        self.assertEqual(postgres.placeholder, "%s")
        self.assertIn("?", sqlite.insert_run())
        self.assertIn("%s", postgres.insert_run())
        self.assertNotIn("?", postgres.insert_run())
        self.assertIn("ON CONFLICT", postgres.blob_insert)
        self.assertEqual(sqlite.values(3), "?,?,?")
        self.assertEqual(postgres.values(3), "%s,%s,%s")
        self.assertEqual(postgres.blob_type, "BYTEA")


class TestCliResume(unittest.TestCase):
    def test_resume_from_entry_file(self) -> None:
        python_pkg_root = str(Path(__file__).resolve().parents[1])
        script = '''
from pathlib import Path
import sys
from vera.workflow.api import Suspend, current, step, workflow

@step
def gate() -> bool:
    if not current.run.inbox.get("approved"):
        raise Suspend("waiting")
    return True

@workflow
def job() -> bool:
    return gate()

if __name__ == "__main__":
    run = job.run(journal_dir=Path(sys.argv[1]))
    print(run.id)
    print(run.status)
'''
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            journal_dir = root / "journals"
            journal_dir.mkdir()
            source = root / "job.workflow.py"
            source.write_text(script, encoding="utf-8")
            created = subprocess.run(
                [sys.executable, str(source), str(journal_dir)],
                env=os.environ | {"PYTHONPATH": python_pkg_root},
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(created.returncode, 0, created.stderr)
            run_id, status = created.stdout.strip().splitlines()
            self.assertEqual(status, "suspended")
            header_path = journal_dir / run_id / "header.json"
            header = json.loads(header_path.read_text(encoding="utf-8"))
            header["inbox"] = {"approved": True}
            header_path.write_text(json.dumps(header), encoding="utf-8")

            resumed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "vera.workflow",
                    "resume",
                    run_id,
                    "--journal-dir",
                    str(journal_dir),
                ],
                env=os.environ | {"PYTHONPATH": python_pkg_root},
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(resumed.returncode, 0, resumed.stderr)
            self.assertIn(run_id, resumed.stdout)
            self.assertIn("ok", resumed.stdout)

    def test_resume_without_entry_fails_closed(self) -> None:
        python_pkg_root = str(Path(__file__).resolve().parents[1])

        @step
        def add(n: int) -> int:
            return n

        @workflow
        def total(n: int) -> int:
            return add(n)

        with tempfile.TemporaryDirectory() as temporary_directory:
            journal_dir = Path(temporary_directory)
            run = total.run(1, journal_dir=journal_dir)
            header_path = journal_dir / run.id / "header.json"
            header = json.loads(header_path.read_text(encoding="utf-8"))
            header.pop("entry")
            header_path.write_text(json.dumps(header), encoding="utf-8")
            missing = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "vera.workflow",
                    "resume",
                    run.id,
                    "--journal-dir",
                    str(journal_dir),
                ],
                env=os.environ | {"PYTHONPATH": python_pkg_root},
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(missing.returncode, 2)
            self.assertIn("no entry", missing.stderr)

    def test_cli_resume_relative_journal_dir_from_other_cwd(self) -> None:
        python_pkg_root = str(Path(__file__).resolve().parents[1])
        script = '''
from pathlib import Path
import sys
from vera.workflow.api import Suspend, current, step, workflow

@step
def gate() -> bool:
    if not current.run.inbox.get("approved"):
        raise Suspend("waiting")
    return True

@workflow
def job() -> bool:
    return gate()

if __name__ == "__main__":
    run = job.run(journal_dir=Path(sys.argv[1]))
    print(run.id)
    print(run.status)
'''
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            proj = root / "proj"
            sub = proj / "sub"
            journals = proj / "journals"
            proj.mkdir()
            sub.mkdir()
            journals.mkdir()
            source = proj / "job.workflow.py"
            source.write_text(script, encoding="utf-8")
            created = subprocess.run(
                [sys.executable, str(source), str(journals)],
                env=os.environ | {"PYTHONPATH": python_pkg_root},
                check=False,
                capture_output=True,
                text=True,
                cwd=str(proj),
            )
            self.assertEqual(created.returncode, 0, created.stderr)
            run_id, status = created.stdout.strip().splitlines()
            self.assertEqual(status, "suspended")
            header_path = journals / run_id / "header.json"
            header = json.loads(header_path.read_text(encoding="utf-8"))
            header["inbox"] = {"approved": True}
            header_path.write_text(json.dumps(header), encoding="utf-8")
            resumed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "vera.workflow",
                    "resume",
                    run_id,
                    "--journal-dir",
                    str(Path("..") / "journals"),
                ],
                env=os.environ | {"PYTHONPATH": python_pkg_root},
                check=False,
                capture_output=True,
                text=True,
                cwd=str(sub),
            )
            self.assertEqual(resumed.returncode, 0, resumed.stderr)
            self.assertIn("ok", resumed.stdout)

    def test_cli_resume_imported_workflow_module(self) -> None:
        python_pkg_root = str(Path(__file__).resolve().parents[1])
        workflow_source = '''
from vera.workflow.api import step, workflow

@step
def add(n: int) -> int:
    return n + 1

@workflow
def total(n: int) -> int:
    return add(n)
'''
        runner_source = '''
from pathlib import Path
import sys
import wf

if __name__ == "__main__":
    run = wf.total.run(1, journal_dir=Path(sys.argv[1]))
    print(run.id)
    print(run.status)
'''
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "wf.py").write_text(workflow_source, encoding="utf-8")
            (root / "runner.py").write_text(runner_source, encoding="utf-8")
            journals = root / "journals"
            journals.mkdir()
            created = subprocess.run(
                [sys.executable, str(root / "runner.py"), str(journals)],
                env=os.environ
                | {"PYTHONPATH": python_pkg_root + os.pathsep + str(root)},
                check=False,
                capture_output=True,
                text=True,
                cwd=str(root),
            )
            self.assertEqual(created.returncode, 0, created.stderr)
            run_id, status = created.stdout.strip().splitlines()
            self.assertEqual(status, "ok")
            header = json.loads(
                (journals / run_id / "header.json").read_text(encoding="utf-8")
            )
            self.assertEqual(header["entry"]["file"], str((root / "wf.py").resolve()))
            resumed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "vera.workflow",
                    "resume",
                    run_id,
                    "--journal-dir",
                    str(journals),
                ],
                env=os.environ
                | {"PYTHONPATH": python_pkg_root + os.pathsep + str(root)},
                check=False,
                capture_output=True,
                text=True,
                cwd=str(root),
            )
            self.assertEqual(resumed.returncode, 0, resumed.stderr)
            self.assertIn("ok", resumed.stdout)

    def test_cli_resume_missing_cwd_fails_closed(self) -> None:
        python_pkg_root = str(Path(__file__).resolve().parents[1])
        script = '''
from pathlib import Path
import sys
from vera.workflow.api import step, workflow

@step
def add(n: int) -> int:
    return n

@workflow
def total(n: int) -> int:
    return add(n)

if __name__ == "__main__":
    run = total.run(1, journal_dir=Path(sys.argv[1]))
    print(run.id)
'''
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            journals = root / "journals"
            journals.mkdir()
            source = root / "job.workflow.py"
            source.write_text(script, encoding="utf-8")
            created = subprocess.run(
                [sys.executable, str(source), str(journals)],
                env=os.environ | {"PYTHONPATH": python_pkg_root},
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(created.returncode, 0, created.stderr)
            run_id = created.stdout.strip()
            missing = root / "gone"
            missing.mkdir()
            header_path = journals / run_id / "header.json"
            header = json.loads(header_path.read_text(encoding="utf-8"))
            header["entry"]["cwd"] = str(missing)
            header_path.write_text(json.dumps(header), encoding="utf-8")
            missing.rmdir()
            resumed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "vera.workflow",
                    "resume",
                    run_id,
                    "--journal-dir",
                    str(journals),
                ],
                env=os.environ | {"PYTHONPATH": python_pkg_root},
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(resumed.returncode, 2, resumed.stderr)
            self.assertIn("cwd does not exist", resumed.stderr)
            self.assertNotIn("Traceback", resumed.stderr)

    def test_cli_resume_sqlite(self) -> None:
        python_pkg_root = str(Path(__file__).resolve().parents[1])
        script = '''
from pathlib import Path
import sys
from vera.workflow.api import SqliteJournalStore, Suspend, current, step, workflow

@step
def gate() -> bool:
    if not current.run.inbox.get("approved"):
        raise Suspend("waiting")
    return True

@workflow
def job() -> bool:
    return gate()

if __name__ == "__main__":
    store = SqliteJournalStore(Path(sys.argv[1]))
    run = job.run(journal=store)
    print(run.id)
    print(run.status)
'''
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            db = root / "runs.sqlite"
            source = root / "job.workflow.py"
            source.write_text(script, encoding="utf-8")
            created = subprocess.run(
                [sys.executable, str(source), str(db)],
                env=os.environ | {"PYTHONPATH": python_pkg_root},
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(created.returncode, 0, created.stderr)
            run_id, status = created.stdout.strip().splitlines()
            self.assertEqual(status, "suspended")
            connection = sqlite3.connect(str(db))
            inbox, = connection.execute(
                "SELECT inbox FROM runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            parsed = json.loads(inbox)
            parsed["approved"] = True
            connection.execute(
                "UPDATE runs SET inbox = ? WHERE run_id = ?",
                (json.dumps(parsed), run_id),
            )
            connection.commit()
            connection.close()
            resumed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "vera.workflow",
                    "resume",
                    run_id,
                    "--journal-dir",
                    str(db),
                ],
                env=os.environ | {"PYTHONPATH": python_pkg_root},
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(resumed.returncode, 0, resumed.stderr)
            self.assertIn("ok", resumed.stdout)


class TestSqliteLoadErrors(unittest.TestCase):
    def test_corrupt_inline_json_is_workflow_error(self) -> None:
        @step
        def add(n: int) -> int:
            return n + 1

        @workflow
        def total(n: int) -> int:
            return add(n)

        with tempfile.TemporaryDirectory() as temporary_directory:
            db = Path(temporary_directory) / "runs.sqlite"
            run = total.run(1, journal=SqliteJournalStore(db))
            connection = sqlite3.connect(str(db))
            connection.execute(
                "UPDATE records SET value = 'not-json' WHERE run_id = ?",
                (run.id,),
            )
            connection.commit()
            connection.close()
            with self.assertRaises(WorkflowError) as raised:
                SqliteJournalStore(db).load(run.id, "total")
            self.assertEqual(raised.exception.kind, "journal")
            self.assertIn("invalid JSON", str(raised.exception))

    def test_non_utf8_blob_is_workflow_error(self) -> None:
        @step
        def large() -> str:
            return "x" * 9000

        @workflow
        def produce() -> str:
            return large()

        with tempfile.TemporaryDirectory() as temporary_directory:
            db = Path(temporary_directory) / "runs.sqlite"
            run = produce.run(journal=SqliteJournalStore(db))
            connection = sqlite3.connect(str(db))
            blob_ref, blob_bytes = connection.execute(
                "SELECT blob_ref, blob_bytes FROM records WHERE run_id = ?",
                (run.id,),
            ).fetchone()
            body = b"\xff" * blob_bytes
            digest = hashlib.sha256(body).hexdigest()
            connection.execute("DELETE FROM blobs")
            connection.execute(
                "INSERT INTO blobs (digest, body) VALUES (?, ?)",
                (digest, body),
            )
            connection.execute(
                "UPDATE records SET blob_ref = ?, blob_bytes = ? WHERE run_id = ?",
                (digest, blob_bytes, run.id),
            )
            connection.commit()
            connection.close()
            with self.assertRaises(WorkflowError) as raised:
                SqliteJournalStore(db).load(run.id, "produce")
            self.assertEqual(raised.exception.kind, "journal")
            self.assertIn("not UTF-8", str(raised.exception))

    def test_nan_inbox_is_workflow_error(self) -> None:
        @step
        def add(n: int) -> int:
            return n

        @workflow
        def total(n: int) -> int:
            return add(n)

        with tempfile.TemporaryDirectory() as temporary_directory:
            db = Path(temporary_directory) / "runs.sqlite"
            run = total.run(1, journal=SqliteJournalStore(db))
            connection = sqlite3.connect(str(db))
            connection.execute(
                "UPDATE runs SET inbox = ? WHERE run_id = ?",
                ('{"x": NaN}', run.id),
            )
            connection.commit()
            connection.close()
            with self.assertRaises(WorkflowError) as raised:
                SqliteJournalStore(db).load(run.id, "total")
            self.assertEqual(raised.exception.kind, "journal")
            self.assertIn("invalid JSON", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
