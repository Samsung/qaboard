"""
Metrics declared in code (qaboard/metrics.py): Metric, define_metric and metrics_definitions.json.
"""
import json
import pickle
import tempfile
import unittest
from pathlib import Path


# Imported lazily, like in test_gate.py: importing qaboard reads the configuration of the current directory,
# and the CLI tests import it again from the sample project
def metrics_module():
  from qaboard import metrics
  return metrics


class TestMetrics(unittest.TestCase):
  def setUp(self):
    metrics_module()._declared.clear()
    self.output_dir = Path(tempfile.mkdtemp())

  def tearDown(self):
    metrics_module()._declared.clear()

  def test_metric_is_a_float(self):
    m = metrics_module()
    latency = m.Metric(12, suffix=" ms", smaller_is_better=True)
    self.assertEqual(latency, 12.0)
    self.assertEqual(latency * 2, 24.0)
    self.assertNotIsInstance(latency * 2, m.Metric)
    self.assertEqual(json.dumps({"latency": latency}), '{"latency": 12.0}')
    self.assertEqual(latency.definition, {"suffix": " ms", "smaller_is_better": True})
    self.assertEqual(repr(latency), "Metric(12.0, smaller_is_better=True, suffix=' ms')")
    copy = pickle.loads(pickle.dumps(latency))
    self.assertEqual((copy, copy.definition), (latency, latency.definition))

  def test_metric_none_is_given(self):
    m = metrics_module()
    # None says there is no better direction, while leaving it out says nothing
    self.assertEqual(m.Metric(1, smaller_is_better=None).definition, {"smaller_is_better": None})
    self.assertEqual(m.Metric(1).definition, {})
    with self.assertRaises(TypeError):
      m.Metric(1, smaller_is_beter=True)  # type: ignore

  def test_split_metrics(self):
    m = metrics_module()
    values, definitions = m.split_metrics({"latency": m.Metric(12.5, suffix=" ms"), "is_failed": False, "status": "ok"})
    self.assertEqual(values, {"latency": 12.5, "is_failed": False, "status": "ok"})
    self.assertIs(type(values["latency"]), float)
    self.assertEqual(definitions, {"latency": {"suffix": " ms"}})

  def test_precedence(self):
    m = metrics_module()
    m.define_metric("latency", label="Latency", suffix=" s", smaller_is_better=True)
    m.define_metric("latency", target=15)  # adds to the previous declaration
    (self.output_dir / 'metrics_definitions.json').write_text(json.dumps({"latency": {"suffix": " ms"}, "psnr": {"suffix": " dB", "smaller_is_better": False}}))
    definitions = m.run_definitions(
      {"latency": 12.0, "psnr": 30.0, "frames": 10, "is_failed": False},
      {"latency": {"precision": 2}},
      self.output_dir,
      metrics_file={},
    )
    self.assertEqual(definitions, {
      "latency": {"label": "Latency", "suffix": " ms", "smaller_is_better": True, "target": 15, "precision": 2},
      "psnr": {"suffix": " dB", "smaller_is_better": False},
    })

  def test_only_returned_metrics(self):
    m = metrics_module()
    m.define_metric("psnr", smaller_is_better=False)
    self.assertEqual(m.run_definitions({"latency": 1.0}, {}, self.output_dir, metrics_file={}), {})

  def test_unknown_direction(self):
    m = metrics_module()
    # in metrics files, leaving out smaller_is_better means "smaller is better": metrics only declared in code say null
    m.define_metric("frames", label="Frames")
    m.define_metric("loss", label="Loss")
    definitions = m.run_definitions({"frames": 10, "loss": 0.1}, {}, self.output_dir, metrics_file={"loss": {"target": 0.05}})
    self.assertEqual(definitions, {"frames": {"label": "Frames", "smaller_is_better": None}, "loss": {"label": "Loss"}})

  def test_invalid_fields_are_left_out(self):
    m = metrics_module()
    definition, invalid = m.clean_definition({
      "label": "L", "target": "30", "scale": float("nan"), "precision": True, "smaller_is_better": "False",
      "plot_scale": "sqrt", "sufix": "%", "suffix": "x" * 201, "target_passfail": 1,
    })
    self.assertEqual(definition, {"label": "L", "smaller_is_better": False})
    self.assertEqual(sorted(invalid), ["plot_scale", "precision", "scale", "suffix", "sufix", "target", "target_passfail"])
    self.assertEqual(m.clean_definition(None), ({}, ["(not an object)"]))
    # what the run sends
    m.define_metric("psnr", target="30", suffix=" dB")  # type: ignore
    self.assertEqual(m.run_definitions({"psnr": 1.0}, {}, self.output_dir, metrics_file={}), {"psnr": {"suffix": " dB", "smaller_is_better": None}})

  def test_numpy_values(self):
    try:
      import numpy as np
    except ImportError:
      self.skipTest("numpy is not installed")
    m = metrics_module()
    definitions = m.run_definitions({"psnr": 1.0}, {"psnr": m.Metric(np.float32(30.5), target=np.float32(2), precision=np.int64(2)).definition}, self.output_dir, metrics_file={})
    self.assertEqual(definitions, {"psnr": {"target": 2.0, "precision": 2, "smaller_is_better": None}})
    self.assertEqual(json.dumps(definitions["psnr"]["target"]), "2.0")

  def test_without_metrics_file(self):
    # `available_metrics:` with nothing under it is null
    m = metrics_module()
    m.define_metric("psnr", smaller_is_better=False)
    self.assertEqual(m.run_definitions({"psnr": 1.0}, {}, self.output_dir, metrics_file=None), {"psnr": {"smaller_is_better": False}})

  def test_the_runs_file_is_not_changed(self):
    # qa postprocess reads it again: it must still say what the run wrote, not what qa merged
    m = metrics_module()
    path = self.output_dir / 'metrics_definitions.json'
    path.write_text('{"latency": {"suffix": " ms"}}')
    m.define_metric("latency", smaller_is_better=True)
    m.run_definitions({"latency": 1.0}, {"latency": {"precision": 2}}, self.output_dir, metrics_file={})
    self.assertEqual(path.read_text(), '{"latency": {"suffix": " ms"}}')

  def test_definitions_file(self):
    m = metrics_module()
    self.assertEqual(m.read_definitions_file(self.output_dir), {})
    (self.output_dir / 'metrics_definitions.json').write_text('{"a": {"suffix": "%"}, "b": 1}')
    self.assertEqual(m.read_definitions_file(self.output_dir), {"a": {"suffix": "%"}})
    (self.output_dir / 'metrics_definitions.json').write_text('not json')
    self.assertEqual(m.read_definitions_file(self.output_dir), {})

  def test_public_api(self):
    m = metrics_module()
    import qaboard
    self.assertIs(qaboard.Metric, m.Metric)
    self.assertIs(qaboard.define_metric, m.define_metric)


if __name__ == '__main__':
  unittest.main()
