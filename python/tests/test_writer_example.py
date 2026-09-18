from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "examples" / "workflows" / "writer.workflow.py"


class TestWriterExample(unittest.TestCase):
    def test_offline_run_waits_for_notes_then_drafts(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            env = os.environ | {
                "PYTHONPATH": str(ROOT / "python"),
                "VERA_HOME": home,
            }
            env.pop("OPENROUTER_API_KEY", None)
            first = self._run(env, str(EXAMPLE), "--offline", "sea otters")
            self.assertIn("is waiting for your notes", first.stdout)
            run_id = first.stdout.split()[0]

            answered = self._run(
                env, "-m", "vera.workflow", "answer", run_id, "keep it short"
            )
            self.assertIn(f"{run_id} ok", answered.stdout)

            run_dir = Path(home) / "workflows" / run_id
            header = json.loads((run_dir / "header.json").read_text("utf-8"))
            self.assertEqual(header["status"], "ok")
            calls = [
                json.loads(line)
                for line in (run_dir / "spans.ndjson").read_text("utf-8").splitlines()
            ]
            models = [
                call["name"]
                for call in calls
                if call.get("attributes", {}).get("openinference.span.kind") == "LLM"
            ]
            self.assertEqual(models, ["openai/gpt-5.6-luna"] * 3)

    def test_a_live_run_needs_a_key(self) -> None:
        env = os.environ | {"PYTHONPATH": str(ROOT / "python")}
        env.pop("OPENROUTER_API_KEY", None)
        completed = subprocess.run(
            [sys.executable, str(EXAMPLE), "sea otters"],
            env=env, check=False, capture_output=True, text=True,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("OPENROUTER_API_KEY", completed.stderr)

    def _run(self, env: dict[str, str], *arguments: str) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            [sys.executable, *arguments],
            env=env, check=False, capture_output=True, text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return completed


if __name__ == "__main__":
    unittest.main()
