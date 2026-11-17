"""
Tests for qaboard/series.py: the files of what runs log while they run, series.jsonl and series.json.
The web app's parser (webapp/src/viewers/series/series.js) is tested on the same fixtures: tests/fixtures/series/.
"""
import ast
import json
import math
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from qaboard.series import (
  HISTORY, SUMMARY, Downsampled, Point, SeriesWriter, as_number, flatten, read_history, read_series, series_keys,
)

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'series'


class TestFixtures(unittest.TestCase):
  """What Python and the web app both read: change the format, change both."""
  def summary(self, max_points):
    with tempfile.TemporaryDirectory() as d:
      shutil.copy(FIXTURES / 'training.series.jsonl', Path(d) / HISTORY)
      summary = SeriesWriter(d, resume=True, max_points=max_points).summary()
    del summary['updated_at']
    return summary

  def test_history_to_summary(self):
    self.assertEqual(self.summary(500), json.loads((FIXTURES / 'training.expected.json').read_text()))

  def test_downsampled(self):
    self.assertEqual(self.summary(2), json.loads((FIXTURES / 'training.downsampled.expected.json').read_text()))

  def test_reading_skips_what_is_not_a_point(self):
    rows = list(read_history(FIXTURES / 'training.series.jsonl'))
    # not the text, the list, the empty line, nor the last line, cut when the run was killed
    self.assertEqual([step for step, _, _ in rows], [0, 1, 2, 3, 4, 5, 6, 7, 8])
    self.assertEqual(rows[4][2], {'train/loss': 0.75, 'lr': 0.0005})  # texts and booleans are not series
    self.assertTrue(math.isnan(rows[3][2]['train/loss']))
    self.assertEqual(rows[6][2]['train/loss'], math.inf)


class TestWriter(unittest.TestCase):
  def setUp(self):
    self.dir = tempfile.TemporaryDirectory()
    self.addCleanup(self.dir.cleanup)
    self.output_dir = Path(self.dir.name)

  def test_appends_and_reads_back(self):
    writer = SeriesWriter(self.output_dir)
    self.assertEqual(writer.append({'loss': 1.0}, time=100.0), 0)
    self.assertEqual(writer.append({'loss': 0.5, 'lr': 0.1}, time=101.0), 1)
    self.assertEqual(writer.append({'loss': 0.25}, step=10, time=102.0), 10)
    self.assertEqual(writer.append({'loss': 0.2}, time=103.0), 11)  # steps go on from the last
    writer.close()
    self.assertEqual(read_series(self.output_dir, 'loss'), [Point(0, 1.0, 100.0), Point(1, 0.5, 101.0), Point(10, 0.25, 102.0), Point(11, 0.2, 103.0)])
    self.assertEqual(read_series(self.output_dir, 'lr'), [Point(1, 0.1, 101.0)])
    self.assertEqual(read_series(self.output_dir, 'unknown'), [])
    self.assertEqual(series_keys(self.output_dir), ['loss', 'lr'])
    summary = json.loads((self.output_dir / SUMMARY).read_text())
    self.assertEqual(summary['format'], 'qaboard-series')
    self.assertEqual(summary['series']['loss'], {'points': 4, 'step': [0, 1, 10, 11], 'time': [0.0, 1.0, 2.0, 3.0], 'value': [1.0, 0.5, 0.25, 0.2]})

  def test_flush_writes_only_when_something_changed(self):
    writer = SeriesWriter(self.output_dir)
    self.assertFalse(writer.flush())
    self.assertFalse((self.output_dir / SUMMARY).exists())
    writer.append({'loss': 1.0})
    self.assertTrue(writer.flush())
    self.assertFalse(writer.flush())
    # nothing left behind by the atomic replace
    self.assertEqual(sorted(p.name for p in self.output_dir.iterdir()), [SUMMARY, HISTORY])
    writer.close()

  def test_non_finite_values_are_valid_json(self):
    writer = SeriesWriter(self.output_dir)
    for value in (1.0, math.nan, math.inf, -math.inf, 3.0):
      writer.append({'loss': value})
    writer.close()
    for line in (self.output_dir / HISTORY).read_text().splitlines():
      json.loads(line, parse_constant=lambda c: self.fail(f"{c} is not JSON"))
    json.loads((self.output_dir / SUMMARY).read_text(), parse_constant=lambda c: self.fail(f"{c} is not JSON"))
    values = [p.value for p in read_series(self.output_dir, 'loss')]
    self.assertTrue(math.isnan(values[1]))
    self.assertEqual([values[0], values[2], values[3], values[4]], [1.0, math.inf, -math.inf, 3.0])
    # the plot has gaps, and the series' aggregates ignore them
    self.assertEqual(writer.summary()['series']['loss']['value'], [1.0, None, None, None, 3.0])
    self.assertEqual([writer.aggregate('loss', how) for how in ('last', 'min', 'max', 'mean')], [3.0, 1.0, 3.0, 2.0])
    self.assertIsNone(writer.aggregate('unknown'))

  def test_a_new_run_replaces_the_files_and_resume_continues_them(self):
    writer = SeriesWriter(self.output_dir)
    for step in range(5):
      writer.append({'loss': float(step)})
    writer.close()
    # a run killed while it wrote leaves a line cut short
    with open(self.output_dir / HISTORY, 'a') as f:
      f.write('{"_step":5,"_time":17315000')
    resumed = SeriesWriter(self.output_dir, resume=True)
    self.assertEqual(resumed.last_step, 4)
    self.assertEqual(resumed.append({'loss': 5.0}), 5)
    resumed.close()
    self.assertEqual([p.step for p in read_series(self.output_dir, 'loss')], [0, 1, 2, 3, 4, 5])
    self.assertEqual(resumed.summary()['series']['loss']['points'], 6)
    again = SeriesWriter(self.output_dir)
    self.assertFalse((self.output_dir / HISTORY).exists() or (self.output_dir / SUMMARY).exists())
    self.assertEqual(again.append({'loss': 1.0}), 0)
    again.close()


class TestDownsampled(unittest.TestCase):
  def test_bounded_whatever_the_length(self):
    series = Downsampled(max_points=100)
    for step in range(100_000):
      series.add(step, 1000.0 if step == 54_321 else float(step % 7), float(step))
    d = series.to_dict()
    self.assertEqual(d['points'], 100_000)
    self.assertTrue(100 <= len(d['step']) <= 200)
    self.assertEqual(len({len(d[k]) for k in ('step', 'time', 'value', 'min', 'max')}), 1)
    # the last point is the last step, and a spike between two plotted points still shows
    self.assertEqual(d['step'][-1], 99_999)
    self.assertEqual(max(d['max']), 1000.0)
    self.assertEqual(min(d['min']), 0.0)
    self.assertEqual(d['step'], sorted(d['step']))

  def test_short_series_are_exact(self):
    series = Downsampled(max_points=100)
    for step in range(150):
      series.add(step, step / 3, 0.0)
    d = series.to_dict()
    self.assertEqual(d['step'], list(range(150)))
    self.assertNotIn('min', d)
    self.assertEqual(d['value'][1], 0.333333)  # 6 significant digits


class TestValues(unittest.TestCase):
  def test_flatten(self):
    self.assertEqual(flatten({'train': {'loss': 1, 'acc': {'top1': 2}}, 'lr': 3}), {'train/loss': 1, 'train/acc/top1': 2, 'lr': 3})

  def test_numbers(self):
    class Scalar:  # numpy scalars, 0-d arrays, torch tensors
      def __init__(self, value):
        self.value = value
      def item(self):
        return self.value
    self.assertEqual(as_number(1), 1)
    self.assertEqual(as_number(0.5), 0.5)
    self.assertEqual(as_number(True), 1)
    self.assertEqual(as_number(Scalar(0.25)), 0.25)
    self.assertEqual(as_number(Scalar(True)), 1)
    for value in ('1', None, [1], Scalar('text'), {'a': 1}):
      with self.subTest(value=value), self.assertRaises(TypeError):
        as_number(value)


class TestIsolation(unittest.TestCase):
  """Programs can use qaboard/series.py alone, to read or write series: it needs only the standard library."""
  def test_imports_only_the_standard_library(self):
    path = Path(__file__).resolve().parent.parent / 'qaboard' / 'series.py'
    for node in ast.walk(ast.parse(path.read_text())):
      if isinstance(node, ast.ImportFrom):
        self.assertEqual(node.level, 0, f'series.py imports from qaboard: {node.module}')
        names = [node.module or '']
      elif isinstance(node, ast.Import):
        names = [alias.name for alias in node.names]
      else:
        continue
      for name in names:
        self.assertIn(name.split('.')[0], sys.stdlib_module_names, f'series.py imports {name}')


if __name__ == '__main__':
  unittest.main()
