from __future__ import annotations

import ast
from pathlib import Path
import sys
import unittest


PACKAGE = Path(__file__).resolve().parent.parent / "vera" / "workflow"


def _sources() -> list[Path]:
    return sorted(PACKAGE.rglob("*.py"))


def _absolute_imports(source: Path) -> set[str]:
    tree = ast.parse(source.read_text(), filename=str(source))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                roots.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                continue
            if node.module:
                roots.add(node.module.split(".")[0])
    return roots


class TestPackageBoundary(unittest.TestCase):
    def test_sources_are_found(self) -> None:
        self.assertTrue(_sources(), f"no sources under {PACKAGE}")

    def test_halcyon_does_not_import_vera(self) -> None:
        for source in _sources():
            with self.subTest(source=source.name):
                self.assertNotIn(
                    "vera",
                    _absolute_imports(source),
                    f"{source.name} imports the vera package",
                )

    def test_halcyon_imports_only_the_standard_library(self) -> None:
        for source in _sources():
            for root in sorted(_absolute_imports(source)):
                with self.subTest(source=source.name, module=root):
                    self.assertTrue(
                        root in sys.stdlib_module_names,
                        f"{source.name} imports non-stdlib module {root!r}",
                    )


if __name__ == "__main__":
    unittest.main()
