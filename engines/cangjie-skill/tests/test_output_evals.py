import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import run_output_evals as evaluator


class OutputEvalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.suite = {"target": "test", "output_cases": [
            {"case_id": case, "prompt": "计算", "assertions": [{"kind": "contains", "value": "ok"}]}
            for case in ("one", "two")
        ]}
        self.mapping = {case: {"vA": "new_skill"} for case in ("one", "two")}

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def score(self):
        suite = self.write("suite.json", json.dumps(self.suite))
        mapping = self.write("mapping.json", json.dumps(self.mapping))
        with contextlib.redirect_stdout(io.StringIO()):
            code = evaluator.cmd_score(suite, self.root / "outputs", mapping, self.root / "report.md")
        return code, (self.root / "report.md").read_text()

    def test_missing_output_counts_in_denominator_and_is_incomplete(self):
        self.write("outputs/one/vA.md", "ok")
        code, report = self.score()
        self.assertEqual(code, 2)
        self.assertIn("new_skill: 1/2", report)
        self.assertIn("输出缺失", report)

    def test_complete_legacy_layout_passes(self):
        for case in ("one", "two"):
            self.write(f"outputs/{case}/vA.md", "ok")
        code, report = self.score()
        self.assertEqual(code, 0)
        self.assertIn("new_skill: 2/2", report)

    def test_failed_assertion_returns_one(self):
        self.write("outputs/one/vA.md", "ok")
        self.write("outputs/two/vA.md", "wrong")
        self.assertEqual(self.score()[0], 1)

    def test_all_missing_does_not_look_successful(self):
        code, report = self.score()
        self.assertEqual(code, 2)
        self.assertIn("new_skill: 0/2", report)

    def test_missing_mapping_is_invalid(self):
        self.mapping.pop("two")
        with self.assertRaises(ValueError):
            self.score()

    def test_inconsistent_variants_are_invalid(self):
        self.mapping["two"]["vB"] = "without_skill"
        with self.assertRaises(ValueError):
            self.score()

    def test_duplicate_variant_is_invalid(self):
        self.mapping["one"]["vB"] = "new_skill"
        with self.assertRaises(ValueError):
            self.score()

    def test_duplicate_case_id_is_invalid(self):
        self.suite["output_cases"][1]["case_id"] = "one"
        with self.assertRaises(ValueError):
            self.score()

    def test_no_cases_or_no_assertions_is_invalid(self):
        for cases in ([], [{"case_id": "one", "prompt": "x", "assertions": []}]):
            with self.subTest(cases=cases):
                self.suite["output_cases"] = cases
                with self.assertRaises(ValueError):
                    self.score()

    def test_variant_artifacts_are_isolated(self):
        for case in ("one", "two"):
            self.write(f"outputs/{case}/vA.md", "ok")
            self.write(f"outputs/{case}/result.csv", "shared artifact must not count")
            self.suite["output_cases"][0 if case == "one" else 1]["assertions"] = [
                {"kind": "file_exists", "value": "result.csv"}]
        self.assertEqual(self.score()[0], 1)
        for case in ("one", "two"):
            self.write(f"outputs/{case}/vA/result.csv", "own artifact")
        self.assertEqual(self.score()[0], 0)

    def test_new_layout_output(self):
        for case in ("one", "two"):
            self.write(f"outputs/{case}/vA/output.md", "ok")
        self.assertEqual(self.score()[0], 0)

    def test_prepare_uses_isolated_directories(self):
        suite = self.write("suite.json", json.dumps(self.suite))
        with contextlib.redirect_stdout(io.StringIO()):
            evaluator.cmd_prepare(suite, self.root / "prepared", ["new_skill", "without_skill"])
        task = json.loads((self.root / "prepared/one/vA/task.json").read_text())
        self.assertEqual(task["case_id"], "one")
        self.assertNotIn("assertions", task)
        with self.assertRaises(ValueError):
            evaluator.cmd_prepare(suite, self.root / "prepared", ["new_skill", "without_skill"])

    def test_legacy_json_with_prose_and_ambiguous_json(self):
        assertion = {"kind": "json_path", "value": "$.total"}
        self.assertTrue(evaluator.check_assertion(assertion, '结果为 {"total":36}，单位元。', self.root))
        self.assertFalse(evaluator.check_assertion(assertion, '{"total":36} {"total":99}', self.root))
        self.assertFalse(evaluator.check_assertion(assertion, '{"broken": {"total":36}, oops}', self.root))
        self.assertFalse(evaluator.check_assertion(assertion, '结果 {"broken": {"total":36}, oops}', self.root))

    def test_score_cli_incomplete_exit_code(self):
        suite = self.write("suite.json", json.dumps(self.suite))
        mapping = self.write("mapping.json", json.dumps(self.mapping))
        result = subprocess.run([
            sys.executable, evaluator.__file__, "score", str(suite), "--outputs", str(self.root / "outputs"),
            "--mapping", str(mapping), "--out", str(self.root / "report.md")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("new_skill: 0/2", result.stdout)

    def test_json_numeric_and_exact_assertions(self):
        a = {"kind": "json_number", "value": "$.total", "expected": 10, "abs_tol": 0.01}
        for value, passed in [(10, True), (10.005, True), (11, False), (-999, False), (True, False), ("10", False)]:
            with self.subTest(value=value):
                self.assertEqual(evaluator.check_assertion(a, json.dumps({"total": value}), self.root), passed)
        self.assertTrue(evaluator.check_assertion(
            {"kind": "json_equals", "value": "$.unit", "expected": "元"},
            '```json\n{"unit":"元"}\n```', self.root))
        self.assertFalse(evaluator.check_assertion(
            {"kind": "json_equals", "value": "$.total", "expected": 1}, '{"total":true}', self.root))
        self.assertTrue(evaluator.check_assertion(
            {"kind": "json_path", "value": "$.total"}, '{"total":-999}', self.root))

    def test_nonfinite_or_invalid_numeric_config_is_rejected(self):
        for text in ('{"total":NaN}', '{"total":Infinity}', '{"total":1e999}'):
            self.assertFalse(evaluator.check_assertion(
                {"kind": "json_number", "value": "$.total", "expected": 10}, text, self.root))
        for kwargs in ({"expected": True}, {"expected": float("nan")}, {"expected": 10, "abs_tol": -1}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                evaluator.check_assertion({"kind": "json_number", "value": "$.total", **kwargs}, '{"total":10}', self.root)

    def test_file_assertion_cannot_escape_variant(self):
        self.write("secret.csv", "private")
        with self.assertRaises(ValueError):
            evaluator.check_assertion({"kind": "file_exists", "value": "../secret.csv"}, "", self.root / "variant")


if __name__ == "__main__":
    unittest.main()
