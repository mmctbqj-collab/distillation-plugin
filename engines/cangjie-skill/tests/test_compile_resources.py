import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from compile_single import build_tree
from compile_pack import compile_pack_tree


class ResourceCompileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = {
            "schema_version": 1, "promotion_budget": 8,
            "bundle_id": "bundle.test", "book": {"title": "Synthetic handbook", "source_pack": "synthetic"},
            "entry": {"name": "handbook", "description": "Use the synthetic handbook to calculate totals and check the input units.",
                      "core_principles": ["Use source rules", "Check units", "Ask for missing inputs"],
                      "out_of_scope": ["Unknown inputs"], "stop_conditions": ["Missing units"]},
            "router_entry": {"name": "handbook", "description": "Route tasks to the synthetic handbook calculation and input checks."},
            "capabilities": [{"capability_id": "cap.test.calculate", "revision": 1, "status": "active",
                              "slug": "calculate", "title": "Calculate", "importance": "high",
                              "importance_rationale": "A complete task with explicit input units and outputs",
                              "intents": ["Calculate total"], "keywords": ["total"], "one_liner": "Add amounts",
                              "card": "cards/calculate.md", "promotion": {"destination": "promoted"}}],
        }
        self.write("cards/calculate.md", "# Calculate\n\nUse the source formula.\n")

    def write(self, rel, content):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def compile(self, pack=False):
        self.write("verified.yaml", yaml.safe_dump(self.bundle))
        return compile_pack_tree(self.root) if pack else build_tree(self.root, "single")

    def test_legacy_without_resources_is_unchanged(self):
        files = self.compile()
        self.assertEqual(set(files), {"SKILL.md", "references/capabilities/calculate.md",
                                     "references/capability-index.md", "references/cheatsheet.md"})
        self.assertEqual(files["references/capabilities/calculate.md"], "# Calculate\n\nUse the source formula.\n")

    def test_single_and_pack_carry_same_declared_resources(self):
        self.bundle["capabilities"][0]["resources"] = ["resources/input.csv", "resources/calculate.py"]
        self.write("resources/input.csv", "金额,单位\n10,元\n")
        self.write("resources/calculate.py", "raise RuntimeError('must never run during compilation')\n")
        self.write("resources/undeclared.txt", "must not be bundled")
        single, pack = self.compile(), self.compile(pack=True)
        for path in self.bundle["capabilities"][0]["resources"]:
            self.assertEqual(single[path], pack[f"handbook/{path}"])
            self.assertEqual(single[path], pack[f"calculate/{path}"])
        self.assertNotIn("resources/undeclared.txt", single)
        self.assertIn("../../resources/input.csv", single["references/capabilities/calculate.md"])
        self.assertIn("](resources/input.csv)", pack["calculate/SKILL.md"])
        self.assertEqual(json.loads(pack["capability-destinations.json"])["capability_count"], 1)

    def test_invalid_resource_paths_fail_closed(self):
        for rel in ("../outside.txt", "/etc/passwd", "resources/../cards/calculate.md", "cards/calculate.md", "resources\\x.py"):
            with self.subTest(rel=rel):
                self.bundle["capabilities"][0]["resources"] = [rel]
                with self.assertRaises(ValueError):
                    self.compile()

    def test_cli_compile_with_resources_validates_and_preserves_bytes(self):
        self.write("book/overview.md", "# Overview\nSynthetic source only.\n")
        self.write("book/glossary.md", "# Glossary\namount: quantity times price\n")
        self.bundle["capabilities"][0]["resources"] = ["resources/input.csv"]
        source = self.write("resources/input.csv", "")
        source.write_bytes("金额,单位\r\n10,元\r\n".encode("utf-8"))
        self.write("verified.yaml", yaml.safe_dump(self.bundle))
        script = Path(__file__).resolve().parents[1] / "scripts/cangjie.py"
        for mode in ("single", "pack"):
            with self.subTest(mode=mode):
                out = self.root / f"output-{mode}"
                result = subprocess.run([sys.executable, str(script), "compile", "--bundle", str(self.root),
                                         "--out", str(out), "--output", mode], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                paths = [out / "resources/input.csv"] if mode == "single" else [
                    out / "handbook/resources/input.csv", out / "calculate/resources/input.csv"]
                for path in paths:
                    self.assertEqual(path.read_bytes(), source.read_bytes())

    def test_missing_directory_symlink_and_binary_rejected(self):
        self.bundle["capabilities"][0]["resources"] = ["resources/input.csv"]
        with self.assertRaises(ValueError):
            self.compile()
        resource_dir = self.root / "resources"
        resource_dir.mkdir()
        (resource_dir / "input.csv").mkdir()
        with self.assertRaises(ValueError):
            self.compile()
        (resource_dir / "input.csv").rmdir()
        (resource_dir / "input.csv").symlink_to(self.root / "cards/calculate.md")
        with self.assertRaises(ValueError):
            self.compile()
        (resource_dir / "input.csv").unlink()
        (resource_dir / "input.csv").write_bytes(b"\x00\xff")
        with self.assertRaises(ValueError):
            self.compile()


if __name__ == "__main__":
    unittest.main()
