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
from importlib import import_module
import json
import os
import shlex
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import click

from .conventions import ci_project


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


# What every run's folder has, written by QA-Board: uploaded files can't take their names
RESERVED_FILES = ('run.json', 'metrics.json', 'metrics_definitions.json', 'manifest.outputs.json', 'manifest.inputs.json', 'series.json', 'series.jsonl')


def files_in(folder: Path, skipped: Path) -> List[Path]:
  """The files of a folder, without hidden folders (.git, .venv...) nor `skipped`: where runs are saved on this computer"""
  found: List[Path] = []
  for root, dirs, names in os.walk(folder):
    dirs[:] = sorted(d for d in dirs if not d.startswith('.') and (Path(root) / d).resolve() != skipped)
    found.extend(Path(root) / name for name in sorted(names))
  return [file for file in found if file.is_file()]


def files_of(paths: List[Path], rename: Optional[str] = None, skipped: Optional[Path] = None) -> Dict[str, Path]:
  """
  {path in the run's folder: file}. A file keeps its name, a folder its name and what is in it.
  - rename: another name for the only file, or folder, given.
  - skipped: a folder left out of the folders given: this computer's copy of the runs, which is inside "." in a project.
  """
  if rename is not None and len(paths) != 1:
    raise click.UsageError("--as names one file or folder: give only one, or use --each.")
  if rename is not None and (Path(rename).is_absolute() or '..' in Path(rename).parts or not Path(rename).name):
    raise click.UsageError(f"--as {rename}: give a name in the run's folder, like junit.xml or reports/junit.xml")
  files: Dict[str, Path] = {}
  def add(name: str, file: Path) -> None:
    if name in files and files[name].resolve() != file.resolve():
      raise click.UsageError(f"{files[name]} and {file} would both be saved as {name} in the run: upload their folder instead, or one run each with --each.")
    if name in RESERVED_FILES:
      hint = " Give its metrics with --metrics metrics.json." if name == 'metrics.json' else ''
      raise click.UsageError(f"{file}: every run has a {name} that QA-Board writes. Save yours under another name, with --as or in a folder.{hint}")
    files[name] = file
  for path in paths:
    name = rename if rename is not None else path.resolve().name
    if path.is_dir():
      for file in files_in(path, skipped or Path(os.devnull)):
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
  for name, file in files.items():
    # a test report under another name is only a file: say how to make it more
    if name.lower().endswith('.xml') and not is_junit(name) and file.stat().st_size < 50e6:
      try:
        read_junit(file)
      except Exception:
        continue
      click.secho(f"NOTE: {file} looks like a test report, but isn't named like one (junit.xml, *.junit.xml, *-junit.xml, TEST-*.xml): it is saved as any file. "
                  "For the test viewer and the tests' metrics, save it with --as junit.xml.", fg='yellow', err=True)
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
  """
  The run's name when --input doesn't give it. In a CI job: the job's name, then the only path's name without its
  extension, so that two jobs that upload a junit.xml, and one job that uploads two files in turn, make different
  runs. Elsewhere: the only path's name.
  """
  job = os.environ.get('GITHUB_JOB') or os.environ.get('CI_JOB_NAME')
  name = (paths[0].resolve().stem or paths[0].resolve().name) if len(paths) == 1 else None
  if job:
    if os.environ.get('GITHUB_JOB'):
      # GitLab's job names include the matrix's values, GitHub's don't
      click.secho(f"NOTE: the run is named after the job, {job}: in a matrix, give each job's runs their own name, e.g. --input {job}-${{{{ matrix.os }}}}", dim=True, err=True)
    return f"{job}/{name}" if name else job
  if name:
    return name
  raise click.UsageError("Name the run with --input, e.g. --input unit-tests: with several paths, outside a CI job, qa can't name it for you. Or use --each for a run per path.")


@click.command(name='upload')
@click.argument('paths', nargs=-1, required=True)
@click.option('-i', '--input', 'input_name', help="The run's name: what it tested. Default: the path's name without its extension; in a CI job, the job's name first (unit-tests/junit), or alone with several paths.")
@click.option('--each', is_flag=True, help="One run per path, named after it, instead of one run with everything.")
@click.option('--as', 'rename', metavar='NAME', help="Save the only file (or folder) given under this name in the run, e.g. --as junit.xml so that the test viewer opens it.")
@click.option('--batch', 'batch_name', help="A group name shown on the run's card, e.g. unit-tests, like `qa batch <batch>`. Not the web app's batch: that is `qa --label <label> upload`.")
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

  Files need a token: `qa auth login` on your machine, QABOARD_TOKEN or the CI's ID token in CI.
  It needs a QA-Board server (QABOARD_URL) that accepts files, or a storage shared with it (`storage` in qaboard.yaml).
  `qa --dryrun upload` says what it would send, without a server.
  """
  from .active_run import start_run, _Setup, _batch_label
  from .credentials import default_server
  # (not `from . import config`: the package has the project's configuration under that name)
  config = import_module('qaboard.config')
  # the options of the `qa` group (qa.py): --label, --configuration and --platform mean what they mean for `qa run`
  group = ctx.parent.params if ctx.parent is not None else {}
  if group.get('offline'):
    raise click.UsageError("`qa upload` sends the run to QA-Board: it can't be --offline. `qa --dryrun upload` says what it would send.")
  if each and (input_name or rename):
    raise click.UsageError("--each names each run after its path: it can't be used with --input or --as.")
  dryrun = bool(group.get('dryrun'))
  server, server_source = default_server()
  if server_source is None and not dryrun:
    raise click.UsageError("Which QA-Board server? Set QABOARD_URL, e.g. QABOARD_URL=https://qaboard.example.com")
  if config.project is None and not project and not ci_project():
    raise click.UsageError("Which project? Give --project group/repo, or run `qa upload` in a project (a folder with a qaboard.yaml).")
  found = expand(paths)
  # shared runs are copied in the project's output/ folder before they are sent (or in the storage): not to upload again
  local_runs = ((config.project_dir or Path.cwd()) / 'output').resolve()
  metrics = given_metrics(metric_pairs, metrics_file)
  # a JSON configuration is a mapping of parameters, like `qa -c '{"lr": 0.1}'`
  configurations = []
  for configuration in group.get('configurations') or ():
    try:
      parsed = json.loads(configuration)
    except ValueError:
      parsed = configuration
    configurations.append(parsed if isinstance(parsed, dict) else configuration)

  # everything is checked before anything is sent
  runs = []
  for run_paths in ([[path] for path in found] if each else [found]):
    files = files_of(run_paths, rename, skipped=local_runs)
    runs.append((input_name or default_input(run_paths), files, {**({} if no_read else read_metrics(files)), **metrics}))
  if len({name for name, _, _ in runs}) != len(runs):
    raise click.UsageError("--each names each run after its path, without its extension: some of these paths would be the same run. Upload them one by one, with --input.")
  if dryrun:
    # what start_run() would say: the project, the commit, the batch, where the files go
    try:
      setup = _Setup(project, commit, upload_without_storage=True)
    except (ValueError, TypeError) as e:
      raise click.UsageError(str(getattr(e, 'cli', e)))
    label = _batch_label(group.get('label') or batch_name or 'default', True, setup)
    destination = f"sent to {server}" if server_source is not None else "sent to the server, once QABOARD_URL says which"
    click.echo(f"project: {setup.project}\ncommit: {setup.commit}\nbatch: {label}{f' ({batch_name} on the cards)' if group.get('label') and batch_name and batch_name != group.get('label') else ''}")
    click.echo(f"files: {destination if setup.uploads_files else 'saved in the storage shared with the server'}")
    for name, files, run_metrics in runs:
      click.echo(f"{name}: {len(files)} files, {sum(file.stat().st_size for file in files.values())} bytes, metrics: {json.dumps({k: float(v) if isinstance(v, float) else v for k, v in run_metrics.items()})}")
      for file_name in files:
        click.echo(f"  {file_name}")
    return

  for name, files, run_metrics in runs:
    try:
      run = start_run(
        name, configs=configurations, label=group.get('label'), batch=batch_name,
        project=project, commit=commit, platform=group.get('platform'), share=True, capture_output=False,
        # a project that keeps its storage: from where it isn't mounted (a GitHub runner...), over HTTP
        _upload_without_storage=True,
      )
    except (ValueError, TypeError) as e:
      # in the words of qa upload's options rather than start_run()'s arguments
      raise click.UsageError(str(getattr(e, 'cli', e)))
    try:
      for file_name, file in files.items():
        run.log_artifact(file_name, file)
      if 'log.txt' not in files:
        # what the web app's Logs view shows: how the run was made
        log = [f"qa {' '.join(shlex.quote(arg) for arg in sys.argv[1:])}", *(f"{file_name}  ({file.stat().st_size} bytes)" for file_name, file in files.items())]
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
    if not run.sent:
      # the same would happen to the next runs
      missing = "all the files of the run" if run.id is not None else "the run"
      click.secho(f"ERROR: QA-Board doesn't have {missing} {name}: see above.", fg='red', bold=True, err=True)
      sys.exit(1)
