"""Tests the snapshots of the batches a command ran (qaboard/batch_snapshot.py)."""
import tempfile
import unittest
from pathlib import Path

import yaml

from qaboard.batch_snapshot import snapshot, select, available_batches, reproduce_argv, header_lines


root_dir = Path(__file__).parent.parent.resolve()


def parsed(text):
  return yaml.safe_load(text)


class TestSelect(unittest.TestCase):
  def test_nested_aliases_keep_only_what_they_reach(self):
    files = [("qa/batches.yaml", {
      "aliases": {"nightly": ["ci", "slow"], "ci": ["a", "b"], "unused": ["c"]},
      "a": {"inputs": ["a.txt"]},
      "b": {"inputs": ["b.txt"]},
      "c": {"inputs": ["c.txt"]},
      "slow": {"inputs": ["slow.txt"]},
    })]
    result = snapshot(["nightly"], files)
    self.assertEqual(result["batches"], ["a", "b", "slow"])
    self.assertEqual(result["aliases"], ["nightly", "ci"])
    data = parsed(result["yaml"])
    self.assertEqual(data["aliases"], {"nightly": ["ci", "slow"], "ci": ["a", "b"]})
    self.assertNotIn("c", data)
    self.assertEqual(result["files"], ["qa/batches.yaml"])

  def test_aliases_that_refer_to_each_other_stop(self):
    batches, aliases = available_batches([("f", {"aliases": {"x": ["y"], "y": ["x", "a"]}, "a": {}})])
    selected, used, not_batches = select(["x"], batches, aliases)
    self.assertEqual(selected, ["a"])
    self.assertEqual(used, ["x", "y"])

  def test_patterns_inputs_and_pipelines(self):
    files = [("f.yaml", {
      "night-1": {"inputs": ["1"]},
      "night-2": {"inputs": ["2"]},
      "day": {"inputs": ["d"]},
      "step": {"inputs": ["s"]},
      "aliases": {"steps": ["step"]},
      "pipe": {"type": "pipeline", "configurations": [{"batch": "steps"}, {"other": 1}]},
    })]
    result = snapshot(["night-*", "pipe", "some/input.txt"], files)
    self.assertEqual(result["batches"], ["night-1", "night-2", "pipe", "step"])
    self.assertEqual(result["inputs"], ["some/input.txt"])
    self.assertNotIn("day", parsed(result["yaml"]))

  def test_last_file_wins_and_file_defaults_are_copied(self):
    files = [
      ("commit.yaml", {"database": "/db/commit", "a": {"inputs": ["old"]}, "b": {"inputs": ["b"]}}),
      ("extra-batches.yml", {"platform": "windows", "configurations": ["base"], "a": {"inputs": ["new"]}, "c": {"inputs": ["c"]}}),
    ]
    data = parsed(snapshot(["a", "b"], files)["yaml"])
    self.assertEqual(data["a"], {"inputs": ["new"], "platform": "windows", "configurations": ["base"]})
    self.assertEqual(data["b"], {"inputs": ["b"], "database": "/db/commit"})
    self.assertNotIn("database", data)
    self.assertNotIn("c", data)

  def test_duplicate_batches_when_allowed(self):
    files = [("one.yaml", {"a": {"inputs": ["1"]}}), ("two.yaml", {"a": {"inputs": ["2"]}})]
    data = parsed(snapshot(["a"], files, allow_duplicate_batches=True)["yaml"])
    self.assertEqual(data["aliases"], {"a": ["a_FIRST", "a@two.yaml"]})
    self.assertEqual(data["a_FIRST"], {"inputs": ["1"]})
    self.assertEqual(data["a@two.yaml"], {"inputs": ["2"]})

  def test_yaml_anchors_are_expanded(self):
    text = "\n".join([
      ".defaults: &defaults",
      "  configurations: [base]",
      "a:",
      "  <<: *defaults",
      "  inputs: [a]",
      "b:",
      "  <<: *defaults",
      "  inputs: [b]",
    ])
    result = snapshot(["a", "b"], [("f", yaml.safe_load(text))])
    self.assertNotIn("&", result["yaml"])
    self.assertNotIn(".defaults", result["yaml"])
    self.assertEqual(parsed(result["yaml"])["b"], {"configurations": ["base"], "inputs": ["b"]})

  def test_header_says_how_to_run_again(self):
    result = snapshot(["a b"], [("f", {"a b": {}})], header=header_lines(["a b"], command="qa batch 'a b'"))
    self.assertTrue(result["yaml"].startswith("# The batches"))
    self.assertIn("qa batch --batches-file batches.yaml 'a b'", result["yaml"])
    self.assertEqual(parsed(result["yaml"]), {"a b": {}})


class TestReproduceArgv(unittest.TestCase):
  def test_batch_files_are_replaced(self):
    argv = ["/venv/bin/qa", "--share", "--label", "x", "batch", "--batches-file", "a.yaml", "--batches-file=b.yaml", "ci", "--runner", "lsf"]
    self.assertEqual(reproduce_argv(argv, "snap.yaml"), ["qa", "--share", "--label", "x", "batch", "--batches-file", "snap.yaml", "ci", "--runner", "lsf"])

  def test_without_batch_files(self):
    self.assertEqual(reproduce_argv(["qa", "optimize", "-b", "ci"], "s.yaml"), ["qa", "optimize", "--batches-file", "s.yaml", "-b", "ci"])


sample = root_dir / "qaboard/sample_project/cli_tests"

class TestSameRuns(unittest.TestCase):
  """`qa batch` runs the same inputs and configurations from a snapshot as from the batch files"""

  def runs(self, names, files):
    from qaboard.iterators import iter_inputs
    return [
      (run.batch, str(run.input_path), str(run.database), run.platform, repr(run.configurations), repr(run.job_options))
      for run in iter_inputs(names, files, sample, [], 'linux', {"type": "local"}, {
        "project": {"entrypoint": root_dir / "qaboard/sample_project/qa/main.py"},
        "inputs": {"globs": '*.txt', "database": {"linux": sample, "windows": sample}, "types": {
          "test-vector": {"globs": "*.txt", "database": {"linux": sample, "windows": sample}, "runners": {"default": "local", "lsf": {"queue": "q"}}},
        }},
      })
    ]

  def test_sample_batches(self):
    from tests.test_iterators import sample_batches_yaml
    with tempfile.TemporaryDirectory() as tmp:
      original = Path(tmp) / "batches.yaml"
      original.write_text(sample_batches_yaml)
      extra = Path(tmp) / "extra.yaml"
      extra.write_text("database: .\nmy-batch:\n  inputs: [a.txt]\naliases:\n  everything: [my-alias, 'matrix-*', all]\n  all: [my-batch]\n")
      files = [original, extra]
      contents = [(str(f), yaml.safe_load(f.read_text())) for f in files]
      names = [n for n in yaml.safe_load(sample_batches_yaml) if not n.startswith('.') and n not in ('aliases', 'database')]
      for selection in [*([n] for n in names), ["my-*"], ["everything"], ["../cli_tests/dir"]]:
        with self.subTest(selection=selection):
          snap = Path(tmp) / "snapshot.yaml"
          snap.write_text(snapshot(selection, contents)["yaml"])
          self.assertEqual(self.runs(selection, [snap]), self.runs(selection, files))


if __name__ == '__main__':
  unittest.main()
