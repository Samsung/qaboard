"""
Tests for qaboard/integrations/wandb: code written for Weights & Biases, logging to QA-Board.

Each test runs a script like a user's in a temporary project, offline (QA_OFFLINE=1), and checks the run's files.
wandb isn't needed: mirror mode is tested with a fake `wandb` package that records what it gets, shaped like the
real one (wandb.init() points the module's functions to the run's methods, the config and summary are objects).
"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

FAKE_WANDB = '''
import atexit, json, os
CALLS = []
run = None
config = None
summary = None
__version__ = "0.99.0"


class Config:
  def __init__(self, values):
    object.__setattr__(self, "_items", dict(values or {}))
  def __setitem__(self, key, value):
    self._items[key] = value
  __setattr__ = __setitem__
  def __getattr__(self, key):
    return self._items[key]
  def update(self, values, allow_val_change=None):
    self._items.update(values)
  def as_dict(self):
    return dict(self._items, _wandb={})


class Summary:
  def __init__(self):
    object.__setattr__(self, "_items", {})
  def update(self, values):
    CALLS.append(["summary", values])
    self._items.update(values)
  def __setitem__(self, key, value):
    self.update({key: value})
  __setattr__ = __setitem__


class Run:
  def __init__(self, **kwargs):
    self.kwargs = kwargs
    self.config = Config(kwargs.get("config"))
    self.summary = Summary()
    self.disabled = kwargs.get("mode") == "disabled"
    self.offline = kwargs.get("mode") == "offline"
  def log(self, data, step=None, commit=None):
    if os.environ.get("FAKE_WANDB_RAISES"):
      raise ValueError("W&B refused it")
    CALLS.append(["log", data, step, commit])
  def define_metric(self, name, step_metric=None, step_sync=None, hidden=None, summary=None, overwrite=None):
    CALLS.append(["define_metric", name, summary])
  def watch(self, *args, **kwargs):
    CALLS.append(["watch"])
  def finish(self, exit_code=None):
    global run
    CALLS.append(["finish", exit_code])
    run = None
  def __enter__(self):
    return self
  def __exit__(self, exc_type, exc, tb):
    self.finish(exit_code=1 if exc_type else 0)


def init(project=None, name=None, config=None, group=None, mode=None, **kwargs):
  global run, log, define_metric, watch, summary
  globals()["config"] = None
  run = Run(project=project, name=name, config=config, group=group, mode=mode, **kwargs)
  CALLS.append(["init", project, name])
  # like wandb: the module's functions are the run's methods, taken now
  log, define_metric, watch = run.log, run.define_metric, run.watch
  globals()["config"], summary = run.config, run.summary
  return run


def finish(exit_code=None):
  if run is not None:
    run.finish(exit_code)


def _save():
  with open(os.environ["FAKE_WANDB_CALLS"], "w") as f:
    json.dump(CALLS, f)


atexit.register(_save)
'''


class WandbTestCase(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    tmp = Path(self.tmp.name).resolve()
    self.project, self.home = tmp / 'detector', tmp / 'home'
    self.project.mkdir()
    self.home.mkdir()
    (self.project / 'qaboard.yaml').write_text("project:\n  name: kitefin/detector\n")
    for args in (('init', '-q', '.'), ('add', '.'), ('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init')):
      subprocess.run(['git', *args], cwd=self.project, check=True, capture_output=True)
    self.fake = tmp / 'fake'
    (self.fake / 'wandb').mkdir(parents=True)
    (self.fake / 'wandb' / '__init__.py').write_text(FAKE_WANDB)
    self.calls_file = tmp / 'calls.json'

  def python(self, code=None, args=(), fake_wandb=False, **env):
    """Runs `code` as the project's train.py, with `python train.py` or, with args, `python <args...>`"""
    if code is not None:
      (self.project / 'train.py').write_text(textwrap.dedent(code))
    environ = {k: v for k, v in os.environ.items() if not k.startswith(('QA', 'CI', 'GITHUB_', 'WANDB_', 'GITLAB')) and k not in ('RANK', 'LOCAL_RANK')}
    paths = [str(self.fake)] if fake_wandb else []
    environ.update({
      'PYTHONPATH': os.pathsep.join([*paths, str(ROOT)]), 'HOME': str(self.home), 'XDG_CONFIG_HOME': str(self.home),
      'QABOARD_IGNORE_SITE': '1', 'QA_USER': 'alice', 'QA_OFFLINE': '1', 'QA_QUIET': '1', 'FAKE_WANDB_CALLS': str(self.calls_file),
      **env,
    })
    command = [sys.executable, *args] if args else [sys.executable, 'train.py']
    return subprocess.run(command, cwd=self.project, env=environ, capture_output=True, text=True, timeout=120)

  def ok(self, result):
    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
    return result

  def runs(self):
    """The runs in the project's output/, by input"""
    found = {}
    for path in sorted((self.project / 'output').rglob('run.json')):
      found[json.loads(path.read_text())['input_path']] = path.parent
    return found

  def run_dir(self, input='train'):
    runs = self.runs()
    self.assertIn(input, runs, f"no run {input!r}: {list(runs)}")
    return runs[input]

  @staticmethod
  def info(run_dir):
    return json.loads((run_dir / 'run.json').read_text())

  @staticmethod
  def metrics(run_dir):
    return json.loads((run_dir / 'metrics.json').read_text())

  @staticmethod
  def series(run_dir):
    return [json.loads(line) for line in (run_dir / 'series.jsonl').read_text().splitlines()]


class TestDropIn(WandbTestCase):
  def test_a_training_loop(self):
    result = self.ok(self.python("""
      import qaboard.integrations.wandb as wandb
      run = wandb.init(project="detector", group="lr-sweep", name="coco-mini", config={"lr": 1e-3}, tags=["baseline"], notes="first")
      assert wandb.run is run and wandb.config is run.config
      wandb.config.update({"batch_size": 8})      # right after init: part of the run's identity
      wandb.config.epochs = 2
      wandb.define_metric("val/loss", summary="min")
      for epoch in range(3):
        wandb.log({"train/loss": 1.0 / (epoch + 1), "train": {"acc": 0.5 + epoch / 10}})
        wandb.log({"val/loss": [0.8, 0.4, 0.6][epoch]})
      run.summary["mAP"] = 0.41
      wandb.summary.update({"verdict": "ship"})
      assert wandb.summary["mAP"] == 0.41 and wandb.summary["train/loss"] == 1 / 3
      assert run.dir.endswith("coco-mini") and run.name == "coco-mini" and run.step == 6
      wandb.finish()
      assert wandb.run is None
    """))
    run_dir = self.run_dir('coco-mini')
    info = self.info(run_dir)
    self.assertEqual(info['configurations'], [{'lr': 0.001, 'batch_size': 8, 'epochs': 2}])
    self.assertTrue(info['batch'].endswith('lr-sweep'), info['batch'])
    self.assertEqual(info['logged']['params'], {'wandb/project': 'detector', 'wandb/group': 'lr-sweep', 'wandb/tags': ['baseline'], 'wandb/notes': 'first'})
    metrics = self.metrics(run_dir)
    self.assertEqual(metrics['val/loss'], 0.4)            # define_metric(summary="min")
    self.assertAlmostEqual(metrics['train/loss'], 1 / 3)  # the last, by default
    self.assertEqual((metrics['mAP'], metrics['verdict'], metrics['is_failed']), (0.41, 'ship', False))
    # each committed log() is a step, like in W&B
    self.assertEqual([(row['_step'], sorted(k for k in row if not k.startswith('_'))) for row in self.series(run_dir)][:2],
                     [(0, ['train/acc', 'train/loss']), (1, ['val/loss'])])
    self.assertNotIn("didn't keep", result.stderr)

  def test_identity_defaults_and_config_changed_later(self):
    result = self.ok(self.python("""
      import argparse
      import qaboard.integrations.wandb as wandb
      args = argparse.Namespace(lr=0.1, layers=3)
      run = wandb.init(project="detector", config=args)
      wandb.log({"loss": 1.0})
      wandb.config.update({"lr": 0.2}, allow_val_change=True)   # after the first log: a parameter
      run.finish()
    """))
    run_dir = self.run_dir('train')   # no name: the script's name, not a random name
    info = self.info(run_dir)
    self.assertEqual(info['configurations'], [{'lr': 0.1, 'layers': 3}])
    self.assertTrue(info['batch'].endswith('detector'), info['batch'])   # no group: the W&B project
    self.assertEqual(info['logged']['params']['lr'], 0.2)
    self.assertIn("config changed after the first log", result.stderr)

  def test_steps_and_commit(self):
    result = self.ok(self.python("""
      import qaboard.integrations.wandb as wandb
      wandb.init(name="steps")
      wandb.log({"a": 1}, commit=False)
      wandb.log({"b": 2})                # same step as a: 0
      wandb.log({"c": 3}, step=5)        # not committed yet: steps given, commit defaults to False
      wandb.log({"d": 4}, step=5)
      wandb.log({"e": 5}, step=3)        # before the current step: ignored, like W&B
      wandb.log({"f": 6}, step=7, commit=True)
      wandb.log({"g": 7})                # step 8
      wandb.log({"h": 8}, commit=False)  # committed when the run finishes
      wandb.finish()
    """))
    rows = {row['_step']: sorted(k for k in row if not k.startswith('_')) for row in self.series(self.run_dir('steps'))}
    self.assertEqual(rows, {0: ['a', 'b'], 5: ['c', 'd'], 7: ['f'], 8: ['g'], 9: ['h']})
    self.assertIn("step=3) is before the current step, 5", result.stderr)

  def test_summaries_from_define_metric(self):
    result = self.ok(self.python("""
      import qaboard.integrations.wandb as wandb
      wandb.init(name="summaries")
      wandb.define_metric("val/*", summary="max")
      wandb.define_metric("loss", summary="best", goal="minimize")
      wandb.define_metric("first", summary="first")
      wandb.define_metric("acc", step_metric="epoch")
      for i, v in enumerate([3, 1, 2]):
        wandb.log({"val/acc": v, "loss": v, "first": v, "acc": v, "epoch": i})
      wandb.define_metric("late", summary="mean")   # after the run started
      for v in (1, 2, 3):
        wandb.log({"late": v})
      wandb.finish()
    """))
    metrics = self.metrics(self.run_dir('summaries'))
    self.assertEqual((metrics['val/acc'], metrics['loss'], metrics['first'], metrics['late']), (3, 1, 2, 2))
    for warned in ('define_metric(summary="first")', 'define_metric(step_metric=...)'):
      self.assertIn(warned, result.stderr)

  def test_media_are_logged_at_their_step(self):
    result = self.ok(self.python("""
      from pathlib import Path
      import qaboard.integrations.wandb as wandb
      Path("sample.png").write_bytes(b"png")
      wandb.init(name="media")
      table = wandb.Table(columns=["x", "y"], data=[[0, 1]])
      table.add_data(1, 2)
      wandb.log({
        "predictions": table,
        "weights": wandb.Histogram([1, 2, 2, 3], num_bins=3),
        "report": wandb.Html("<b>ok</b>"),
        "samples": [wandb.Image("sample.png"), wandb.Image("sample.png", caption="b")],
        "curve": wandb.plot.line(table, "x", "y"),
        "loss": 0.5,
      })
      boxes = {"predictions": {"box_data": [
        {"position": {"minX": 0.1, "maxX": 0.5, "minY": 0.2, "maxY": 0.6}, "class_id": 1, "scores": {"conf": 0.9}},
        {"position": {"middle": [10, 10], "width": 4, "height": 2}, "domain": "pixel", "box_caption": "dog"},
      ], "class_labels": {1: "cat"}}}
      wandb.log({"detections": wandb.Image("sample.png", boxes=boxes, masks={"m": {}})})
      wandb.log({"other": object()})
      wandb.something_new(1)          # what wandb has and the shim doesn't: does nothing, said once
      wandb.watch(None)
      wandb.finish()
    """))
    run_dir = self.run_dir('media')
    from qaboard.media import read_media
    items = {(i['key'], i['index']): i for i in read_media(run_dir)}
    self.assertEqual({k: i['_step'] for k, i in items.items()}, {
      ('predictions', 0): 0, ('weights', 0): 0, ('report', 0): 0, ('samples', 0): 0, ('samples', 1): 0, ('curve', 0): 0, ('detections', 0): 1})
    table = json.loads((run_dir / items['predictions', 0]['path']).read_text())
    self.assertEqual(table, {'columns': ['x', 'y'], 'data': [[0, 1], [1, 2]]})
    self.assertEqual(items['weights', 0]['counts'], [1, 2, 1])
    self.assertEqual((run_dir / items['report', 0]['path']).read_text(), '<b>ok</b>')
    self.assertEqual((run_dir / 'media/samples/0_1.png').read_bytes(), b'png')
    self.assertEqual(items['samples', 1]['caption'], 'b')
    self.assertEqual(items['curve', 0]['kind'], 'table')
    self.assertEqual(items['detections', 0]['boxes'], [
      {'x': 0.1, 'y': 0.2, 'w': 0.4, 'h': 0.4, 'label': 'cat', 'group': 'predictions', 'units': 'fraction', 'score': 0.9},
      {'x': 8, 'y': 9, 'w': 4, 'h': 2, 'label': 'dog', 'group': 'predictions'},
    ])
    self.assertEqual(self.metrics(run_dir)['loss'], 0.5)
    report = result.stderr[result.stderr.index("didn't keep"):]
    for feature in ('wandb.plot.*', 'wandb.Image(masks=...)', 'values of type object', 'wandb.something_new()', 'wandb.watch()'):
      self.assertIn(feature, report)
    for kept in ('wandb.Table', 'wandb.Image in', 'wandb.Histogram', 'wandb.Html'):
      self.assertNotIn(kept, report)

  def test_artifacts_and_save(self):
    self.ok(self.python("""
      from pathlib import Path
      import qaboard.integrations.wandb as wandb
      Path("model").mkdir()
      Path("model/weights.pt").write_text("w")
      Path("model/config.json").write_text("{}")
      Path("notes.txt").write_text("n")
      run = wandb.init(name="files")
      artifact = wandb.Artifact("detector", type="model")
      artifact.add_dir("model")
      artifact.add_file("notes.txt", name="docs/notes.txt")
      with artifact.new_file("info.txt") as f:
        f.write("i")
      run.log_artifact(artifact, aliases=["best"])
      wandb.log_artifact("notes.txt")
      wandb.save("model/*.json")
      wandb.save(str(Path("model/weights.pt").resolve()), base_path=".")
      wandb.use_artifact("detector:latest").download()
      Path(run.dir, "direct.txt").write_text("d")   # run.dir is the run's folder
      wandb.finish()
    """))
    run_dir = self.run_dir('files')
    for name in ('artifacts/detector/weights.pt', 'artifacts/detector/config.json', 'artifacts/detector/docs/notes.txt',
                 'artifacts/detector/info.txt', 'artifacts/notes.txt', 'model/config.json', 'model/weights.pt', 'direct.txt'):
      self.assertTrue((run_dir / name).is_file(), name)

  def test_lifecycle(self):
    result = self.python("""
      import qaboard.integrations.wandb as wandb
      with wandb.init(name="ok") as run:
        wandb.log({"loss": 1})
      run = wandb.init(name="exit-code")
      wandb.log({"loss": 1})
      wandb.finish(exit_code=1)
      first = wandb.init(name="again")
      assert wandb.init(name="ignored") is first      # in a script, like W&B: the active run
      second = wandb.init(name="again2", reinit=True)  # finishes the first
      assert second is not first and wandb.run is second
      second.finish()
      assert wandb.init(mode="disabled").disabled
      wandb.log({"loss": 1})
      wandb.finish()
      offline = wandb.init(name="offline", mode="offline")
      assert offline.qaboard.share is False
      offline.finish()
      with wandb.init(name="crash"):
        wandb.log({"loss": 1})
        raise RuntimeError("diverged")
    """, QABOARD_URL='http://127.0.0.1:9')
    self.assertEqual(result.returncode, 1, result.stderr)
    self.assertIn('diverged', result.stderr)
    runs = self.runs()
    self.assertEqual(sorted(runs), ['again', 'again2', 'crash', 'exit-code', 'offline', 'ok'])
    failed = {name: self.metrics(run_dir)['is_failed'] for name, run_dir in runs.items()}
    self.assertEqual(failed, {'again': False, 'again2': False, 'crash': True, 'exit-code': True, 'offline': False, 'ok': False})

  def test_runs_end_with_the_process(self):
    self.ok(self.python("""
      import qaboard.integrations.wandb as wandb
      wandb.init(name="unfinished")
      wandb.log({"loss": 1}, commit=False)
    """))
    run_dir = self.run_dir('unfinished')
    self.assertEqual(self.metrics(run_dir)['loss'], 1)
    result = self.python("""
      import qaboard.integrations.wandb as wandb
      wandb.init(name="never-logged")
      raise ValueError("before any log")
    """)
    self.assertEqual(result.returncode, 1)
    self.assertTrue(self.metrics(self.run_dir('never-logged'))['is_failed'])

  def test_only_rank_0_logs(self):
    result = self.ok(self.python("""
      import qaboard.integrations.wandb as wandb
      run = wandb.init(name="ddp")
      wandb.log({"loss": 1})
      assert run.disabled
      wandb.finish()
      wandb.init(name="ddp2").finish()
    """, RANK='1'))
    self.assertEqual(self.runs(), {})
    self.assertEqual(result.stderr.count('only rank 0'), 1)


class TestMirror(WandbTestCase):
  TRAINING = """
    import sys
    import wandb
    run = wandb.init(project="detector", name="coco-mini", config={"lr": 0.1})
    wandb.config.update({"batch_size": 4})
    wandb.define_metric("loss", summary="min")
    for i in range(3):
      wandb.log({"loss": [3, 1, 2][i]})
    run.summary["mAP"] = 0.5
    wandb.watch(None)
    print("args", sys.argv)
    wandb.finish()
  """

  def test_python_m_mirrors_wandb(self):
    result = self.ok(self.python(self.TRAINING, args=('-m', 'qaboard.integrations.wandb', 'train.py', '--lr', '1e-3'), fake_wandb=True))
    self.assertIn("args ['train.py', '--lr', '1e-3']", result.stdout)
    # W&B got every call
    calls = json.loads(self.calls_file.read_text())
    self.assertEqual([c[0] for c in calls], ['init', 'define_metric', 'log', 'log', 'log', 'summary', 'watch', 'finish'])
    # and QA-Board too
    run_dir = self.run_dir('coco-mini')
    self.assertEqual(self.info(run_dir)['configurations'], [{'lr': 0.1, 'batch_size': 4}])
    metrics = self.metrics(run_dir)
    self.assertEqual((metrics['loss'], metrics['mAP'], metrics['is_failed']), (1, 0.5, False))
    self.assertIn('wandb.watch()', result.stderr)

  def test_mirror_from_code(self):
    self.ok(self.python("import qaboard.integrations.wandb\nqaboard.integrations.wandb.mirror()\n" + textwrap.dedent(self.TRAINING), fake_wandb=True))
    self.assertEqual(len(json.loads(self.calls_file.read_text())), 8)
    self.assertEqual(self.metrics(self.run_dir('coco-mini'))['loss'], 1)

  def test_our_failures_dont_break_wandb(self):
    result = self.ok(self.python("""
      import qaboard.integrations.wandb as qw
      from qaboard.integrations.wandb import _bridge
      def broken(*args, **kwargs):
        raise RuntimeError("QA-Board is broken")
      _bridge.Bridge.log = broken
      wandb = qw.mirror()
      wandb.init(name="robust")
      for i in range(3):
        wandb.log({"loss": i})
      wandb.finish()
    """, fake_wandb=True))
    calls = json.loads(self.calls_file.read_text())
    self.assertEqual([c[0] for c in calls].count('log'), 3)
    self.assertEqual(result.stderr.count('QA-Board is broken'), 1)
    self.assertIn('robust', self.runs())

  def test_wandb_errors_are_the_scripts(self):
    result = self.python("""
      import qaboard.integrations.wandb as qw
      wandb = qw.mirror()
      with wandb.init(name="refused"):
        wandb.log({"loss": 1})
    """, fake_wandb=True, FAKE_WANDB_RAISES='1')
    self.assertEqual(result.returncode, 1)
    self.assertIn('W&B refused it', result.stderr)
    self.assertTrue(self.metrics(self.run_dir('refused'))['is_failed'])

  def test_disabled_and_rank(self):
    self.ok(self.python("""
      import qaboard.integrations.wandb as qw
      wandb = qw.mirror()
      wandb.init(name="disabled", mode="disabled")
      wandb.log({"loss": 1})
      wandb.finish()
    """, fake_wandb=True))
    self.assertEqual(self.runs(), {})


class TestRunner(WandbTestCase):
  def test_without_wandb_the_shim_is_wandb(self):
    result = self.ok(self.python(TestMirror.TRAINING, args=('-m', 'qaboard.integrations.wandb', 'train.py', 'x')))
    self.assertIn("wandb isn't installed", result.stderr)
    self.assertIn("args ['train.py', 'x']", result.stdout)
    self.assertEqual(self.metrics(self.run_dir('coco-mini'))['loss'], 1)

  def test_exit_codes_and_failures(self):
    (self.project / 'pkg').mkdir()
    (self.project / 'pkg' / '__init__.py').write_text('')
    (self.project / 'pkg' / 'train.py').write_text(textwrap.dedent("""
      import sys
      import wandb
      wandb.init(name=sys.argv[1])
      wandb.log({"loss": 1})
      if sys.argv[1] == "exit":
        sys.exit(3)
      if sys.argv[1] == "raise":
        raise RuntimeError("diverged")
    """))
    for name, code in (('ok', 0), ('exit', 3), ('raise', 1)):
      result = self.python(args=('-m', 'qaboard.integrations.wandb', '-m', 'pkg.train', name))
      self.assertEqual(result.returncode, code, result.stderr)
      self.assertEqual(self.metrics(self.run_dir(name))['is_failed'], code != 0)
    self.assertIn('diverged', result.stderr)
    usage = self.python(args=('-m', 'qaboard.integrations.wandb'))
    self.assertEqual(usage.returncode, 2)
    self.assertIn('usage', usage.stderr)




class TestRealWandbObjects(unittest.TestCase):
  """What the real wandb's objects hold (checked against wandb 0.31.2): the tests' fake wandb is ours"""
  def test_boxes_of_bounding_boxes_2d(self):
    from qaboard.integrations.wandb import _media

    class BoundingBoxes2D:  # wandb.data_types: the boxes in _val, the labels in _class_labels
      def __init__(self, val):
        self._val, self._class_labels = val['box_data'], val.get('class_labels')

    class Image:
      _boxes = {'predictions': BoundingBoxes2D({'box_data': [{'position': {'minX': 1, 'maxX': 3, 'minY': 2, 'maxY': 6}, 'domain': 'pixel', 'class_id': 0, 'scores': {'conf': 'high'}}], 'class_labels': {0: 'cat'}})}
    self.assertEqual(_media._boxes(Image()), [{'x': 1.0, 'y': 2.0, 'w': 2.0, 'h': 4.0, 'group': 'predictions', 'label': 'cat'}])

  def test_plotly_kept_as_a_file(self):
    import tempfile
    from qaboard.integrations.wandb import _media
    with tempfile.TemporaryDirectory() as d:
      path = Path(d) / 'figure.plotly.json'
      path.write_text('{"data": [{"y": [1, 2]}]}')

      class Plotly:
        __module__ = 'wandb.sdk.data_types.plotly'
        _path, _caption = str(path), None
      Plotly.__name__ = 'Plotly'
      figure = _media.to_media(Plotly())
      self.assertEqual(figure.data, {'data': [{'y': [1, 2]}]})

  def test_a_list_with_an_item_we_cant_keep_isnt_logged(self):
    # else the other items would shift, and match the wrong samples of other steps and of the reference
    from qaboard.integrations.wandb import _media
    logged = []

    class Run:
      def log_media(self, key, value, step):
        logged.append((key, value, step))
    _media.save(Run(), 'samples', 3, [_media.Html('<b>a</b>'), _media.Object3D(None)])
    self.assertEqual(logged, [])
    _media.save(Run(), 'samples', 3, [_media.Html('<b>a</b>'), _media.Html('<b>b</b>')])
    self.assertEqual([(k, len(v), s) for k, v, s in logged], [('samples', 2, 3)])

  def test_histograms_of_arrays(self):
    import numpy
    from qaboard.integrations.wandb import _media
    histogram = _media.Histogram(numpy.array([[1.0, 2.0], [2.0, float('nan')]]), num_bins=2)
    self.assertEqual(histogram.histogram, [1, 2])


if __name__ == '__main__':
  unittest.main()
