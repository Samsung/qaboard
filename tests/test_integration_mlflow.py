"""
Tests for qaboard/integrations/mlflow: code that logs with MLflow logs to QA-Board with MLFLOW_TRACKING_URI=qaboard:
(or qaboard+<uri>, mirror mode). Needs the `mlflow` extra (uv sync --extra mlflow): skipped without it.

Like tests/test_active_run.py, each test runs a script like a user's in a temporary project, offline (QA_OFFLINE=1),
and checks the QA-Board run's folder: run.json (identity, parameters), metrics.json, series.jsonl, files.
MLflow finds the plugin with the entry points of the installed qaboard package (pyproject.toml).
"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

try:
  import mlflow
except ImportError:
  mlflow = None

try:
  import pandas  # noqa: F401  mlflow.sklearn needs it, mlflow-skinny doesn't install it
  import sklearn  # noqa: F401
  has_sklearn_autolog = True
except ImportError:
  has_sklearn_autolog = False

ROOT = Path(__file__).resolve().parent.parent

# the end of each script: where the QA-Board runs of its MLflow runs are
REPORT = """
import json as _json
from qaboard.integrations.mlflow.recorder import recorder as _recorder
print('RUNS=' + _json.dumps({run_id: str(r.qb.output_dir) if r.qb is not None else None for run_id, r in _recorder.runs.items()}))
"""


def git(cwd, *args):
  return subprocess.run(['git', '-c', 'user.email=alice@example.com', '-c', 'user.name=alice', *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@unittest.skipIf(mlflow is None, "needs MLflow: uv sync --extra mlflow")
class MlflowTestCase(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    tmp = Path(self.tmp.name).resolve()
    self.project, self.home = tmp / 'detector', tmp / 'home'
    self.project.mkdir()
    self.home.mkdir()
    (self.project / 'qaboard.yaml').write_text("project:\n  name: kitefin/detector\n  url: git@example.com:kitefin/detector.git\n")
    (self.project / 'train.py').write_text("print('training')\n")
    git(self.project, 'init', '-q', '.')
    git(self.project, 'add', '.')
    git(self.project, 'commit', '-q', '-m', 'Train the detector')
    self.commit = git(self.project, 'rev-parse', 'HEAD')

  def python(self, code, uri='qaboard:', **env):
    """Runs `code` as the project's train.py, offline, and returns (process, {MLflow run id: QA-Board run folder})"""
    from qaboard.config import ci_env_variables
    (self.project / 'train.py').write_text(textwrap.dedent(code) + REPORT)
    environ = {k: v for k, v in os.environ.items() if not k.startswith(('QA', 'CI_', 'GITHUB_', 'MLFLOW_', 'RANK', 'LOCAL_RANK')) and k not in ci_env_variables}
    environ.update({
      'PYTHONPATH': str(ROOT), 'HOME': str(self.home), 'XDG_CONFIG_HOME': str(self.home), 'QABOARD_IGNORE_SITE': '1', 'QA_USER': 'alice',
      'QA_OFFLINE': '1', 'MLFLOW_TRACKING_URI': uri, 'MLFLOW_DISABLE_AGENT_HINT': '1', 'MLFLOW_ALLOW_FILE_STORE': 'true',
      **env,
    })
    result = subprocess.run([sys.executable, 'train.py'], cwd=self.project, env=environ, capture_output=True, text=True, timeout=300)
    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
    line = next(line for line in result.stdout.splitlines() if line.startswith('RUNS='))
    return result, {run_id: Path(d) if d else None for run_id, d in json.loads(line[len('RUNS='):]).items()}

  def only(self, runs):
    self.assertEqual(len(runs), 1, runs)
    return next(iter(runs.values()))

  def run_json(self, run_dir):
    return json.loads((run_dir / 'run.json').read_text())

  def metrics(self, run_dir):
    return json.loads((run_dir / 'metrics.json').read_text())

  def series(self, run_dir, key):
    rows = [json.loads(line) for line in (run_dir / 'series.jsonl').read_text().splitlines() if line.strip()]
    return [(row['_step'], row[key]) for row in rows if key in row]


class TestFluentApi(MlflowTestCase):
  def test_a_training_becomes_a_qaboard_run(self):
    result, runs = self.python("""
      import mlflow
      mlflow.set_experiment("lr-sweep")
      with mlflow.start_run(run_name="coco-mini") as run:
          mlflow.log_params({"lr": 0.001, "model": "resnet50", "epochs": 3, "pretrained": True})
          mlflow.set_tags({"team": "vision", "mlflow.note.content": "baseline"})
          for step in range(5):
              mlflow.log_metric("train/loss", 1 / (1 + step), step=step)
          mlflow.log_metric("acc", 0.5)
          mlflow.log_metric("acc", 0.7)
          mlflow.log_metrics({"val/loss": 0.4}, step=4)
          # MLflow still works: from memory
          assert mlflow.get_run(run.info.run_id).data.metrics == {"train/loss": 0.2, "acc": 0.7, "val/loss": 0.4}, mlflow.get_run(run.info.run_id).data.metrics
          assert [m.value for m in mlflow.MlflowClient().get_metric_history(run.info.run_id, "acc")] == [0.5, 0.7]
          assert len(mlflow.search_runs(experiment_names=["lr-sweep"], filter_string="params.model = 'resnet50'", output_format="list")) == 1
          assert mlflow.get_experiment_by_name("lr-sweep").experiment_id == run.info.experiment_id
    """)
    run_dir = self.only(runs)
    info = self.run_json(run_dir)
    # the identity: experiment -> batch, run name -> input, parameters logged first -> configurations, git commit
    self.assertEqual((info['batch'], info['input_path'], info['commit']), ('lr-sweep', 'coco-mini', self.commit))
    self.assertEqual(info['configurations'], [{'lr': 0.001, 'model': 'resnet50', 'epochs': 3, 'pretrained': True}])
    params = info['logged']['params']
    self.assertEqual((params['tags/team'], params['mlflow/note'], params['mlflow/run_name']), ('vision', 'baseline', 'coco-mini'))
    self.assertIn('mlflow/run_id', params)
    # series, and their last values as metrics
    self.assertEqual(self.series(run_dir, 'train/loss'), [(s, 1 / (1 + s)) for s in range(5)])
    # logged again at step 0, MLflow's default: the next steps
    self.assertEqual(self.series(run_dir, 'acc'), [(0, 0.5), (1, 0.7)])
    metrics = self.metrics(run_dir)
    self.assertEqual((metrics['train/loss'], metrics['acc'], metrics['val/loss'], metrics['is_failed']), (0.2, 0.7, 0.4, False))
    self.assertIn('finished:', result.stderr)

  def test_random_names_are_not_inputs(self):
    _, runs = self.python("""
      import mlflow
      with mlflow.start_run() as run:
          assert run.info.run_name  # MLflow still gets its random name
          mlflow.log_metric("loss", 1.0)
      print("NAME=" + run.info.run_name)
    """)
    info = self.run_json(self.only(runs))
    # the script's name, stable from a commit to the next, and the default batch
    self.assertEqual((info['input_path'], info['batch']), ('train', 'default'))
    self.assertEqual(info['configurations'], [])

  def test_params_after_the_first_metric_are_params(self):
    result, runs = self.python("""
      import mlflow
      with mlflow.start_run(run_name="a"):
          mlflow.log_param("lr", 0.1)
          mlflow.log_metric("loss", 1.0)
          mlflow.log_param("device", "cuda:0")
    """)
    info = self.run_json(self.only(runs))
    self.assertEqual(info['configurations'], [{'lr': 0.1}])
    self.assertEqual(info['logged']['params']['device'], 'cuda:0')
    self.assertIn("mlflow.log_param after the run's first metric", result.stderr)

  def test_choose_the_params_that_identify_runs(self):
    _, runs = self.python("""
      import mlflow
      with mlflow.start_run(run_name="a"):
          mlflow.log_params({"lr": 0.1, "data_dir": "/tmp/xyz", "seed": 3})
    """, QABOARD_MLFLOW_CONFIGS='*,!data_dir')
    info = self.run_json(self.only(runs))
    self.assertEqual(info['configurations'], [{'lr': 0.1, 'seed': 3}])
    self.assertEqual(info['logged']['params']['data_dir'], '/tmp/xyz')

  def test_commit_tag(self):
    git(self.project, 'commit', '-q', '--allow-empty', '-m', 'Later')
    _, runs = self.python(f"""
      import mlflow
      with mlflow.start_run(run_name="a", tags={{"mlflow.source.git.commit": "{self.commit}"}}):
          mlflow.log_metric("loss", 1.0)
    """)
    self.assertEqual(self.run_json(self.only(runs))['commit'], self.commit)

  def test_failed_runs(self):
    _, runs = self.python("""
      import mlflow
      try:
          with mlflow.start_run(run_name="a"):
              mlflow.log_metric("loss", 1.0)
              raise RuntimeError("diverged")
      except RuntimeError:
          pass
      run = mlflow.start_run(run_name="b")
      mlflow.log_metric("loss", 2.0)
      mlflow.end_run("KILLED")
    """)
    self.assertEqual(len(runs), 2)
    for run_dir in runs.values():
      self.assertTrue(self.metrics(run_dir)['is_failed'], run_dir)

  def test_artifacts(self):
    _, runs = self.python("""
      import os, tempfile, mlflow
      with mlflow.start_run(run_name="a") as run:
          folder = tempfile.mkdtemp()
          with open(os.path.join(folder, "pred.csv"), "w") as f:
              f.write("x")
          os.makedirs(os.path.join(folder, "sub"))
          with open(os.path.join(folder, "sub", "y.txt"), "w") as f:
              f.write("y")
          mlflow.log_artifact(os.path.join(folder, "pred.csv"))
          mlflow.log_artifacts(folder, "outputs")
          mlflow.log_dict({"a": 1}, "config/cfg.json")
          mlflow.log_text("not ours", "metrics.json")
          # read back, like code that loads what it logged
          assert mlflow.artifacts.load_dict(f"runs:/{run.info.run_id}/config/cfg.json") == {"a": 1}
          assert sorted(f.path for f in mlflow.MlflowClient().list_artifacts(run.info.run_id)) == ["config", "mlflow", "outputs", "pred.csv"]
    """)
    run_dir = self.only(runs)
    for path, content in (('pred.csv', 'x'), ('outputs/pred.csv', 'x'), ('outputs/sub/y.txt', 'y'), ('config/cfg.json', '{\n  "a": 1\n}'), ('mlflow/metrics.json', 'not ours')):
      self.assertEqual((run_dir / path).read_text(), content, path)
    # QA-Board's own file stays
    self.assertIn('is_failed', self.metrics(run_dir))

  def test_nested_runs(self):
    result, runs = self.python("""
      import mlflow
      with mlflow.start_run(run_name="sweep") as parent:
          for lr in (0.1, 0.01):
              with mlflow.start_run(nested=True):
                  mlflow.log_param("lr", lr)
                  mlflow.log_metric("loss", lr)
          for _ in range(2):
              with mlflow.start_run(nested=True):
                  mlflow.log_metric("loss", 3)
          mlflow.log_metric("best", 0.01)
    """)
    self.assertEqual(len(runs), 5)
    infos = [self.run_json(d) for d in runs.values()]
    children = [i for i in infos if 'mlflow/parent_run_id' in i['logged']['params']]
    self.assertEqual(len(children), 4)
    self.assertEqual(sorted(json.dumps(i['configurations']) for i in children if i['configurations']), ['[{"lr": 0.01}]', '[{"lr": 0.1}]'])
    # the same identity: named after MLflow's name, else they'd be the same run
    self.assertEqual(len({(i['input_path'], json.dumps(i['configurations'])) for i in infos}), 5)
    self.assertEqual(len(set(runs.values())), 5)

  def test_async_logging(self):
    _, runs = self.python("""
      import mlflow
      with mlflow.start_run(run_name="a"):
          mlflow.log_param("lr", 0.1, synchronous=False)
          for step in range(3):
              mlflow.log_metric("loss", step, step=step, synchronous=False)
          mlflow.flush_async_logging()
    """)
    run_dir = self.only(runs)
    self.assertEqual(self.series(run_dir, 'loss'), [(0, 0), (1, 1), (2, 2)])

  def test_other_ranks_make_no_run(self):
    result, runs = self.python("""
      import mlflow
      with mlflow.start_run(run_name="a"):
          mlflow.log_metric("loss", 1.0)
    """, RANK='1')
    self.assertEqual(list(runs.values()), [None])
    self.assertIn("rank 1", result.stderr)

  def test_resume_in_the_same_process(self):
    _, runs = self.python("""
      import mlflow
      with mlflow.start_run(run_name="a") as run:
          mlflow.log_metric("loss", 1.0, step=1)
      with mlflow.start_run(run_id=run.info.run_id):
          mlflow.log_metric("loss", 0.5, step=2)
    """)
    self.assertEqual(self.series(self.only(runs), 'loss'), [(1, 1.0), (2, 0.5)])

  def test_what_qaboard_lacks_is_said_and_listed(self):
    result, runs = self.python("""
      import mlflow
      from mlflow.exceptions import MlflowException
      with mlflow.start_run(run_name="a") as run:
          mlflow.log_metric("loss", 1.0)
          mlflow.set_experiment_tag("owner", "vision")
          try:
              mlflow.register_model(f"runs:/{run.info.run_id}/model", "detector")
              raise AssertionError("registered")
          except MlflowException as e:
              assert "no model registry" in str(e), e
          try:
              mlflow.MlflowClient().get_run("0123456789abcdef0123456789abcdef")
              raise AssertionError("found")
          except MlflowException as e:
              assert "other processes see the runs in QA-Board" in str(e), e
    """)
    self.only(runs)
    report = result.stderr[result.stderr.index("what MLflow code did that QA-Board didn't keep"):]
    for feature in ("experiment tags", "the model registry"):
      self.assertIn(feature, report)

  @unittest.skipIf(not has_sklearn_autolog, "mlflow.log_table needs pandas")
  def test_tables_are_files(self):
    result, runs = self.python("""
      import mlflow
      with mlflow.start_run(run_name="a"):
          mlflow.log_table({"a": [1, 2]}, "table.json")
    """)
    self.assertTrue((self.only(runs) / 'table.json').exists())
    self.assertIn("mlflow.log_table", result.stderr)

  @unittest.skipIf(mlflow is not None and not hasattr(mlflow, 'trace'), "MLflow 2.14+")
  def test_tracing_never_breaks_the_code(self):
    _, runs = self.python("""
      import mlflow
      @mlflow.trace
      def predict(x):
          return x + 1
      with mlflow.start_run(run_name="a"):
          assert predict(1) == 2
          mlflow.log_metric("loss", 1.0)
    """)
    self.only(runs)

  @unittest.skipIf(not has_sklearn_autolog, "mlflow.sklearn needs pandas")
  def test_autolog(self):
    _, runs = self.python("""
      import mlflow, numpy as np
      from sklearn.linear_model import LogisticRegression
      mlflow.sklearn.autolog()
      X = np.random.RandomState(0).rand(50, 3)
      with mlflow.start_run(run_name="logistic"):
          LogisticRegression(C=0.5).fit(X, (X[:, 0] > .5).astype(int))
    """)
    run_dir = self.only(runs)
    configs = self.run_json(run_dir)['configurations'][0]
    self.assertEqual((configs['C'], configs['max_iter']), (0.5, 100))
    self.assertIn('training_score', self.metrics(run_dir))
    self.assertTrue((run_dir / 'models').is_dir())


class TestMirror(MlflowTestCase):
  def test_mlflow_gets_everything_and_qaboard_too(self):
    mlruns = Path(self.tmp.name) / 'mlruns'
    _, runs = self.python(f"""
      import mlflow
      mlflow.set_experiment("mirrored")
      with mlflow.start_run(run_name="m1") as run:
          mlflow.log_param("lr", 0.1)
          mlflow.log_metric("loss", 0.4, step=1)
          mlflow.log_metric("loss", 0.3, step=2, synchronous=False)
          mlflow.log_text("hi", "a/b.txt")
      # MLflow's store is the source of truth: in another client, without QA-Board
      client = mlflow.MlflowClient(tracking_uri="file://{mlruns}")
      stored = client.get_run(run.info.run_id)
      assert stored.data.params == {{"lr": "0.1"}}, stored.data.params
      assert [m.value for m in client.get_metric_history(run.info.run_id, "loss")] == [0.4, 0.3]
      assert stored.info.status == "FINISHED"
      assert mlflow.artifacts.load_text(f"runs:/{{run.info.run_id}}/a/b.txt") == "hi"
      print("ID=" + run.info.run_id)
    """, uri=f'qaboard+file://{mlruns}')
    run_dir = self.only(runs)
    run_id = next(iter(runs))
    self.assertEqual(next(mlruns.glob(f'*/{run_id}/artifacts/a/b.txt')).read_text(), 'hi')
    info = self.run_json(run_dir)
    self.assertEqual((info['batch'], info['input_path'], info['configurations']), ('mirrored', 'm1', [{'lr': 0.1}]))
    self.assertEqual(self.series(run_dir, 'loss'), [(1, 0.4), (2, 0.3)])
    self.assertEqual((run_dir / 'a/b.txt').read_text(), 'hi')

  def test_qaboard_failing_never_breaks_mlflow(self):
    mlruns = Path(self.tmp.name) / 'mlruns'
    # no project here: QA-Board can't start runs
    elsewhere = Path(self.tmp.name) / 'elsewhere'
    elsewhere.mkdir()
    (self.project / 'qaboard.yaml').rename(elsewhere / 'qaboard.yaml')
    result, runs = self.python(f"""
      import mlflow
      with mlflow.start_run(run_name="m1") as run:
          mlflow.log_metric("loss", 0.4)
      assert mlflow.MlflowClient(tracking_uri="file://{mlruns}").get_run(run.info.run_id).data.metrics == {{"loss": 0.4}}
    """, uri=f'qaboard+file://{mlruns}')
    self.assertEqual(runs, {})
    self.assertIn("couldn't log the run to QA-Board", result.stderr)


@unittest.skipIf(mlflow is None, "needs MLflow: uv sync --extra mlflow")
class TestClient(MlflowTestCase):
  def test_client(self):
    """MlflowClient, without the fluent API. In its own process, like the other tests: qaboard.config reads the
    project and where its runs go when it is first imported, which another test of this process may have done."""
    _, runs = self.python("""
      import mlflow
      client = mlflow.MlflowClient(tracking_uri='qaboard:')
      experiment_id = client.create_experiment('in-process')
      run = client.create_run(experiment_id, run_name='client')
      client.log_batch(run.info.run_id, params=[mlflow.entities.Param('depth', '4')])
      client.log_metric(run.info.run_id, 'loss', 0.25, step=3)
      client.set_terminated(run.info.run_id)
      assert client.get_run(run.info.run_id).info.status == 'FINISHED'
    """)
    run_dir = self.only(runs)
    self.assertTrue(run_dir.is_relative_to(self.project), run_dir)
    run = self.run_json(run_dir)
    self.assertEqual((run['batch'], run['input_path'], run['configurations']), ('in-process', 'client', [{'depth': 4}]), run)
    self.assertEqual(self.metrics(run_dir)['loss'], 0.25)
    self.assertEqual(self.series(run_dir, 'loss'), [(3, 0.25)])

if __name__ == '__main__':
  unittest.main()
