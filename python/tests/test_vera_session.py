from __future__ import annotations

from pathlib import Path
import tempfile
import time
import unittest

from vera.agent import Agent
from vera.instance import Vera


AGENT = Agent(name="reader", instructions="Return the recorded reply.", tools=[])


class TestVeraSession(unittest.TestCase):
    def setUp(self) -> None:
        self._workspace = tempfile.TemporaryDirectory()
        self.workspace = Path(self._workspace.name)
        self.addCleanup(self._workspace.cleanup)

    def test_runs_share_one_child(self) -> None:
        with Vera.create(workspace=str(self.workspace), _replay=True) as vera:
            self.assertEqual(vera.run(AGENT, "one"), "one")
            assert vera._child is not None
            pid = vera._child.process.pid
            self.assertEqual(vera.run(AGENT, "two"), "two")
            self.assertEqual(vera._child.process.pid, pid)

    def test_a_named_session_keeps_the_conversation_until_close(self) -> None:
        vera = Vera.create(workspace=str(self.workspace), _replay=True)
        runtime = vera._runtime_dir
        try:
            vera.run(AGENT, "remember teal", session="sales")
            vera.run(AGENT, "what colour", session="sales")
            vera.run(AGENT, "unrelated")

            files = list(runtime.glob("**/sessions/*.jsonl"))
            self.assertEqual([path.name for path in files], ["sales.jsonl"])
            text = files[0].read_text()
            self.assertIn("remember teal", text)
            self.assertIn("what colour", text)
            self.assertNotIn("unrelated", text)
        finally:
            vera.close()
        self.assertFalse(runtime.exists())
        with self.assertRaisesRegex(RuntimeError, "closed"):
            vera.run(AGENT, "again", session="sales")

    def test_run_checks_session_and_timeout_before_the_child(self) -> None:
        with Vera.create(workspace=str(self.workspace), _replay=True) as vera:
            with self.assertRaises(ValueError):
                vera.run(AGENT, "x", session="../escape")
            with self.assertRaises(ValueError):
                vera.run(AGENT, "x", timeout=0)
            self.assertIsNone(vera._child)

    def test_timeout_aborts_the_turn_and_keeps_the_child(self) -> None:
        with Vera.create(
            workspace=str(self.workspace),
            _replay=True,
            _replay_delay=0.5,
        ) as vera:
            vera.run(AGENT, "warm")
            assert vera._child is not None
            pid = vera._child.process.pid
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                vera.run(AGENT, "slow", timeout=0.1)
            self.assertLess(time.monotonic() - started, 0.45)
            self.assertEqual(vera.run(AGENT, "after"), "after")
            self.assertEqual(vera._child.process.pid, pid)

    def test_a_dead_child_is_replaced_on_the_next_call(self) -> None:
        with Vera.create(workspace=str(self.workspace), _replay=True) as vera:
            vera.run(AGENT, "first")
            assert vera._child is not None
            dead = vera._child.process
            dead.kill()
            dead.wait()

            self.assertEqual(vera.run(AGENT, "second"), "second")
            self.assertNotEqual(vera._child.process.pid, dead.pid)

    def test_tool_returns_output_or_raises(self) -> None:
        (self.workspace / "note.txt").write_text("tool text\n")
        with Vera.create(workspace=str(self.workspace), _replay=True) as vera:
            self.assertIn("tool text", vera.tool("read", {"path": "note.txt"}))
            with self.assertRaisesRegex(PermissionError, "readonly"):
                vera.tool("write", {"path": "new.txt", "content": "x"})
            with self.assertRaisesRegex(RuntimeError, "ENOENT"):
                vera.tool("read", {"path": "absent.txt"})
            self.assertFalse((self.workspace / "new.txt").exists())

    def test_tool_writes_under_a_posture_that_allows_it(self) -> None:
        with Vera.create(
            workspace=str(self.workspace),
            posture="auto",
            _replay=True,
        ) as vera:
            vera.tool("write", {"path": "new.txt", "content": "x"})
        self.assertEqual((self.workspace / "new.txt").read_text(), "x")


if __name__ == "__main__":
    unittest.main()
