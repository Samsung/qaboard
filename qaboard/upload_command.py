"""
`qa upload`: saves files as a run, without a `run()` function to write. For what other tools already produced: test
reports, benchmark files, profiles, coverage, logs.

    pytest --junitxml=junit.xml --benchmark-json=pytest.benchmarks.json
    qa upload junit.xml pytest.benchmarks.json

It is `qaboard.start_run()` from the shell (qaboard/active_run.py): the run has the same identity as any run (project,
commit, batch, input, configurations), so the web app compares it with the reference's. The files are saved in the
storage shared with the server, or sent to it without one (qaboard/upload.py). Test reports and benchmark files
give the run its metrics (qaboard/junit.py, qaboard/benchmarks.py), read like the web app's viewers read them.
"""
import glob
import json
import os
import shlex
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import click


def expand(paths: Tuple[str, ...]) -> List[Path]:
  """The files and folders to upload: those given, and those matching the patterns the shell didn't expand"""
  found: List[Path] = []
  for path in paths:
    if Path(path).exists():
      found.append(Path(path))
      continue
    matches = sorted(glob.glob(path, recursive=True)) if glob.has_magic(path) else []
    if not matches:
      raise click.UsageError(f"{path}: no such file or folder")
    found.extend(Path(match) for match in matches)
  return found


def files_of(paths: List[Path], rename: Optional[str] = None) -> Dict[str, Path]:
  """
  {path in the run's folder: file}. A file keeps its name, a folder its name and what is in it.
  `rename`: another name for the only file, or folder, given.
  """
  if rename is not None and len(paths) != 1:
    raise click.UsageError("--as names one file or folder: give only one, or use --each.")
  files: Dict[str, Path] = {}
  def add(name: str, file: Path) -> None:
    if name in files and files[name].resolve() != file.resolve():
      raise click.UsageError(f"{files[name]} and {file} would both be saved as {name} in the run: upload their folder instead, or one run each with --each.")
    files[name] = file
  for path in paths:
    name = rename if rename is not None else path.resolve().name
    if path.is_dir():
      for file in sorted(p for p in path.rglob('*') if p.is_file()):
        add((Path(name) / file.relative_to(path)).as_posix(), file)
    else:
      add(Path(name).as_posix(), path)
  if not files:
    raise click.UsageError(f"Nothing to upload: {', '.join(str(p) for p in paths)} {'has' if len(paths) == 1 else 'have'} no files.")
  return files


def read_metrics(files: Dict[str, Path]) -> Dict[str, Any]:
  """The metrics of the test reports and benchmark files among `files`, recognized by their names like the web app does"""
  from .junit import is_junit, read_junit, junit_metrics
  from .benchmarks import is_benchmarks, benchmark_metrics
  metrics: Dict[str, Any] = {}
  cases: List[Dict[str, Any]] = []
  has_reports = False
  benchmark_files = [name for name in files if is_benchmarks(name)]
  for name, file in files.items():
    try:
      if is_junit(name):
        # several reports are one suite in pieces (Maven and Gradle write a file per class): their tests add up
        cases.extend(read_junit(file))
        has_reports = True
      elif name in benchmark_files:
        # several benchmark files: their file's name tells apart benchmarks with the same name
        prefix = f"{Path(name).name.split('.')[0]}_" if len(benchmark_files) > 1 else ''
        metrics.update(benchmark_metrics(file, prefix=prefix))
    except Exception as e:
      click.secho(f"WARNING: no metrics read from {file}: {e}", fg='yellow', err=True)
  if has_reports:
    metrics.update(junit_metrics(cases))
  return metrics


def given_metrics(pairs: Tuple[str, ...], metrics_file: Optional[str]) -> Dict[str, Any]:
  """The metrics of --metrics FILE (a JSON object), then of -m key=value: numbers, true/false, else texts"""
  metrics: Dict[str, Any] = {}
  if metrics_file:
    try:
      content = json.loads(Path(metrics_file).read_text())
    except (OSError, ValueError) as e:
      raise click.UsageError(f"--metrics {metrics_file}: {e}")
    if not isinstance(content, dict):
      raise click.UsageError(f"--metrics {metrics_file}: expected a JSON object, like {{\"accuracy\": 0.93}}")
    metrics.update(content)
  for pair in pairs:
    key, separator, value = pair.partition('=')
    if not separator or not key.strip():
      raise click.UsageError(f"-m {pair}: give metrics as name=value, like -m accuracy=0.93")
    try:
      metrics[key.strip()] = json.loads(value)
    except ValueError:
      metrics[key.strip()] = value
  return metrics


def default_input(paths: List[Path]) -> str:
  """The run's name when --input doesn't give it: the only path's name without its extension, else the CI job's"""
  if len(paths) == 1:
    return paths[0].resolve().stem or paths[0].resolve().name
  job = os.environ.get('GITHUB_JOB') or os.environ.get('CI_JOB_NAME')
  if job:
    return job
  raise click.UsageError("Name the run with --input, e.g. --input unit-tests: with several paths, outside a CI job, qa can't name it for you. Or use --each for a run per path.")


@click.command(name='upload')
@click.argument('paths', nargs=-1, required=True)
@click.option('-i', '--input', 'input_name', help="The run's name: what it tested. Default: the path's name without its extension, or the CI job's name with several paths.")
@click.option('--each', is_flag=True, help="One run per path, named after it, instead of one run with everything.")
@click.option('--as', 'rename', metavar='NAME', help="Save the only file (or folder) given under this name in the run, e.g. --as junit.xml so that the test viewer opens it.")
@click.option('--batch', 'batch_name', help="The group of tests the run belongs to, shown on its card. The batch in the web app is `qa --label`'s.")
@click.option('-m', '--metric', 'metric_pairs', multiple=True, metavar='NAME=VALUE', help="A metric of the run. Repeat it for more.")
@click.option('--metrics', 'metrics_file', type=click.Path(exists=True, dir_okay=False), help="A JSON file with metrics of the run, like {\"accuracy\": 0.93}.")
@click.option('--no-read', is_flag=True, help="Don't read metrics from the test reports and benchmark files.")
@click.option('--failed', is_flag=True, help="The run failed: what made these files couldn't finish.")
@click.option('--project', help="The project, like group/repo. Default: the qaboard.yaml's, or in CI the repository's.")
@click.option('--commit', help="The commit the files are about. Default: the git HEAD, or the CI's commit.")
@click.pass_context
def upload(ctx, paths, input_name, each, rename, batch_name, metric_pairs, metrics_file, no_read, failed, project, commit):
  """
  Saves files as a run in QA-Board, without a run() function: test reports, benchmark files, profiles, any file.

  \b
      qa upload junit.xml
      qa --label nightly upload --input unit-tests junit.xml pytest.benchmarks.json coverage/
      qa upload --each 'build/test-results/*.xml'
      qa -c O3 upload --input codec cpu.folded -m throughput_mbps=812.5

  A file keeps its name in the run, a folder its name and content. The web app opens files with the viewer their
  name picks, next to the reference run's: junit.xml and *.junit.xml are test reports, *.benchmarks.json benchmark
  files, *.folded flame graphs... Test reports and benchmark files also give the run its metrics.

  The run is identified like those of `qa run`: the project, the commit, the batch (`qa --label`), its input (--input)
  and configurations (`qa --configuration`). Uploading the same again replaces it.
  It needs a QA-Board server (QABOARD_URL) that accepts files, or a storage shared with it (`storage` in qaboard.yaml).
  """
  from .active_run import start_run
  from .credentials import default_server
  if default_server()[1] is None:
    raise click.UsageError("Which QA-Board server? Set QABOARD_URL, e.g. QABOARD_URL=https://qaboard.example.com")
  group = ctx.parent.params if ctx.parent is not None else {}
  if each and (input_name or rename):
    raise click.UsageError("--each names each run after its path: it can't be used with --input or --as.")
  found = expand(paths)
  metrics = given_metrics(metric_pairs, metrics_file)
  # a JSON configuration is a mapping of parameters, like `qa -c '{"lr": 0.1}'`
  configurations = []
  for configuration in group.get('configurations') or ():
    try:
      parsed = json.loads(configuration)
    except ValueError:
      parsed = configuration
    configurations.append(parsed if isinstance(parsed, dict) else configuration)

  ok = True
  for run_paths in ([[path] for path in found] if each else [found]):
    files = files_of(run_paths, rename)
    run_metrics = {**({} if no_read else read_metrics(files)), **metrics}
    try:
      run = start_run(
        input_name or default_input(run_paths), configs=configurations, label=group.get('label'), batch=batch_name,
        project=project, commit=commit, platform=group.get('platform'), share=True, capture_output=False,
      )
    except (ValueError, TypeError) as e:
      click.secho(f"ERROR: {e}", fg='red', bold=True, err=True)
      sys.exit(1)
    log = [f"qa {' '.join(shlex.quote(arg) for arg in sys.argv[1:])}", *(f"{name}  ({file.stat().st_size} bytes)" for name, file in files.items())]
    try:
      for name, file in files.items():
        run.log_artifact(name, file)
      run.log_artifact('log.txt', ('\n'.join(log) + '\n').encode())
      if run_metrics:
        run.log_metrics(run_metrics)
    except Exception as e:
      run.fail(e)
      click.secho(f"ERROR: {e}", fg='red', bold=True, err=True)
      sys.exit(1)
    if failed:
      run.fail("qa upload --failed: what made these files failed.")
    else:
      run.finish()
    ok = ok and bool(run.sent)
  if not ok:
    click.secho("ERROR: QA-Board doesn't have everything: see above.", fg='red', bold=True, err=True)
    sys.exit(1)
