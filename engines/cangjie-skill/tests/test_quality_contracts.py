import copy
import json
import sys
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from run_output_evals import check_assertion, validate_suite


class QualityContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads((ROOT / "schemas/eval-suite.schema.json").read_text())
        cls.suite = json.loads((ROOT / "benchmarks/toolbook/output-suite.json").read_text())
        cls.validator = Draft202012Validator(cls.schema)

    def test_output_example_schema_and_runtime_contract(self):
        self.validator.validate(self.suite)
        self.assertEqual(len(validate_suite(self.suite)), 3)

    def test_numeric_expected_type_and_tolerance_are_checked(self):
        for change in ({"expected": True}, {"abs_tol": -1}):
            with self.subTest(change=change):
                suite = copy.deepcopy(self.suite)
                suite["output_cases"][0]["assertions"][0].update(change)
                self.assertTrue(list(self.validator.iter_errors(suite)))

    def test_synthetic_output_oracles(self):
        # 本测试验证断言器与固定答案，不声称模型完成了任务。
        outputs = [
            '{"total":36,"unit":"元"}',
            '{"status":"needs_input","missing":["unit_price"]}',
            '{"request_id":"R-7","status":"pending_confirmation"}',
        ]
        for case, answer in zip(self.suite["output_cases"], outputs):
            for assertion in case["assertions"]:
                self.assertTrue(check_assertion(assertion, answer, ROOT))
        for wrong in ('{"total":-999,"unit":"元"}', '{"total":36,"unit":"美元"}'):
            self.assertFalse(all(check_assertion(a, wrong, ROOT) for a in self.suite["output_cases"][0]["assertions"]))

    def test_resource_schema_rejects_escape_and_accepts_declared_text(self):
        schema = json.loads((ROOT / "schemas/capability.schema.json").read_text())["properties"]["resources"]
        validator = Draft202012Validator(schema)
        validator.validate(["resources/example.csv", "resources/scripts/calculate.py"])
        for paths in (["../private"], ["resources/../private"], ["resources/x.csv", "resources/x.csv"]):
            self.assertTrue(list(validator.iter_errors(paths)))


if __name__ == "__main__":
    unittest.main()
