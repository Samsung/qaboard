"""Tests for backend/project_settings.py: what owners set from a project's Admin pages"""
import pytest

from backend.project_settings import SettingsError, clean_gate, describe_yaml_gate, gate_changes


def test_clean_gate():
  assert clean_gate(None) is None
  assert clean_gate({}) == {"rules": [], "max_failed_runs": None, "require_bit_accuracy": False, "on_looser_rules": "warn"}
  gate = {"rules": [{"metric": "psnr", "max_regression": "1%", "min": 30}], "max_failed_runs": 0, "require_bit_accuracy": True, "on_looser_rules": "fail"}
  # stored as written: the page shows what its owner typed
  assert clean_gate(gate) == gate
  # rules for some batches or labels, and the batches the gate waits for: as written
  scoped = {"rules": [{"metric": "latency", "max_regression": "10%", "batch": "perf"}, {"metric": "accuracy", "min": 0.9, "label": ["nightly"]}],
            "max_failed_runs": None, "require_bit_accuracy": False, "expect_batches": {"default": ["ci", "perf"]}, "on_looser_rules": "warn"}
  assert clean_gate(scoped) == scoped
  assert clean_gate({"expect_batches": ["perf"]})["expect_batches"] == ["perf"]
  assert "expect_batches" not in clean_gate({"expect_batches": []})
  for bad, message in [
    ([], "expected an object"),
    ({"rules": [{"metric": "psnr", "min": 1, "batch": []}]}, "gate.rules[0].batch: expected a name"),
    ({"expect_batches": {"default": [True]}}, "gate.expect_batches.default"),
    ({"labels": ["nightly"]}, "unknown keys labels"),
    ({"batches": ["ci"]}, "unknown keys batches"),
    ({"rules": [{"metric": "psnr", "aggregate": "mean", "per_test_max_regression": "5%"}]}, "per_test_max_regression checks each test"),
    ({"rules": [{"metric": "psnr", "min": 1}] * 201}, "at most 200 rules"),
    ({"require_bit_accuracy": "yes"}, "gate.require_bit_accuracy"),
    # every comparison sends them: not megabytes of names
    ({"rules": [{"metric": "psnr", "min": 1, "batch": ["x" * 1000] * 100}]}, "too long, at most 64 KB"),
  ]:
    with pytest.raises(SettingsError) as error:
      clean_gate(bad)
    assert message in str(error.value)


def test_describe_yaml_gate():
  assert describe_yaml_gate(None)["has_config"] is False
  described = describe_yaml_gate({"project": {"reference_branch": "main"}})
  # a qaboard.yaml without a gate: `qa gate` would only check failed runs, the page says there are no rules
  assert (described["has_config"], described["has_gate"], described["rules"], described["max_failed_runs"], described["reference"]) == (True, False, [], None, "main")
  described = describe_yaml_gate({"gate": {"reference": "v1.0", "batches": "ci", "rules": [{"metric": "psnr", "min": 30, "aggregate": "min"}]}})
  assert described["rules"] == [{"metric": "psnr", "kind": "min", "limit": 30.0, "aggregate": "min", "batch": None, "label": None}]
  assert (described["reference"], described["batches"], described["max_failed_runs"], described["error"]) == ("v1.0", ["ci"], 0, None)
  assert (described["labels"], described["expect_batches"]) == (["ci"], {})
  # rules have their scope, and the page shows which batches the gate waits for
  described = describe_yaml_gate({"gate": {"labels": ["default", "nightly"], "expect_batches": ["ci", "perf"],
                                           "rules": [{"metric": "latency", "max_regression": "10%", "batch": "perf", "label": "default"}]}})
  assert described["rules"] == [{"metric": "latency", "kind": "max_regression", "limit": 0.1, "aggregate": "median", "batch": ["perf"], "label": ["default"]}]
  assert (described["labels"], described["batches"], described["expect_batches"]) == (["default", "nightly"], ["default", "nightly"], {"*": ["ci", "perf"]})
  # what `qa gate` would say of a broken section
  described = describe_yaml_gate({"gate": {"rules": "all of them"}})
  assert described["rules"] == [] and "gate.rules: expected a list" in described["error"]


def test_gate_changes():
  before = {"rules": [{"metric": "psnr", "min": 30}], "max_failed_runs": 0, "require_bit_accuracy": False, "on_looser_rules": "warn"}
  assert gate_changes(before, before) == {}
  assert gate_changes(None, before)["rules"] == {"from": None, "to": before["rules"]}
  assert gate_changes(before, {**before, "max_failed_runs": None}) == {"max_failed_runs": {"from": 0, "to": None}}
  assert set(gate_changes(before, None)) == {"rules", "max_failed_runs", "require_bit_accuracy", "on_looser_rules"}
