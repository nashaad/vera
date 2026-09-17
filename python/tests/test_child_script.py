from __future__ import annotations

from pathlib import Path
import unittest
from unittest import mock

from vera.instance import child_script


class TestChildScript(unittest.TestCase):
    def test_a_checkout_runs_the_typescript_source(self) -> None:
        with mock.patch.object(Path, "is_file", return_value=False):
            self.assertEqual(child_script().name, "_child.ts")

    def test_a_wheel_runs_the_bundle_beside_the_package(self) -> None:
        with mock.patch.object(Path, "is_file", return_value=True):
            path = child_script()

        self.assertEqual(path.name, "child.js")
        self.assertEqual(path.parent.parent.parent.name, "_bun")


if __name__ == "__main__":
    unittest.main()
