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
from typing import Any

import click

from .conventions import ci_project


def trends_url(run: Any, metrics: dict[str, Any] | None) -> str | None:
  """The branch's Trends page in the web app, when the run was sent and its metrics say how they group (tests, benchmarks)"""
  from urllib.parse import quote
  grouped = any(getattr(metric, 'definition', {}).get('group') for metric in (metrics or {}).values())
  branch = run._setup.commit_data.get('commit_branch') if hasattr(run, '_setup') else None
  server = getattr(run, 'server', None)
  if not (grouped and getattr(run, 'sent', False) and server and run.project and branch):
    return None
  return f"{server}/{quote(run.project)}/trends/{quote(branch)}"


def expand(paths: tuple[str, ...]) -> list[Path]:
  """The files and folders to upload: those given, and those matching the patterns the shell didn't expand"""
  found: list[Path] = []
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


def files_in(folder: Path, skipped: Path) -> list[Path]:
  """The files of a folder, without hidden folders (.git, .venv...) nor `skipped`: where runs are saved on this computer"""
  from .upload import is_outside_link, warn_outside_links
  found: list[Path] = []
  for root, dirs, names in os.walk(folder):
    dirs[:] = sorted(d for d in dirs if not d.startswith('.') and (Path(root) / d).resolve() != skipped)
    found.extend(Path(root) / name for name in sorted(names))
  # links to files elsewhere, e.g. ~/.ssh, aren't sent: links inside the folder are
  outside = [file for file in found if is_outside_link(file, folder)]
  if outside:
    warn_outside_links([file.relative_to(folder).as_posix() for file in outside])
  return [file for file in found if file.is_file() and file not in outside]


def files_of(paths: list[Path], rename: str | None = None, skipped: Path | None = None) -> dict[str, Path]:
  """
  {path in the run's folder: file}. A file keeps its name, a folder its name and what is in it.
  - rename: another name for the only file, or folder, given.
  - skipped: a folder left out of the folders given: this computer's copy of the runs, which is inside "." in a project.
  """
  if rename is not None and len(paths) != 1:
    raise click.UsageError("--as names one file or folder: give only one, or use --each.")
  if rename is not None and (Path(rename).is_absolute() or '..' in Path(rename).parts or not Path(rename).name):
    raise click.UsageError(f"--as {rename}: give a name in the run's folder, like junit.xml or reports/junit.xml")
  files: dict[str, Path] = {}
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


def read_metrics(files: dict[str, Path]) -> dict[str, Any]:
  """The metrics of the test reports and benchmark files among `files`, recognized by their names like the web app does"""
  from .junit import is_junit, read_junit, junit_metrics
  from .benchmarks import is_benchmarks, benchmark_metrics
  metrics: dict[str, Any] = {}
  cases: list[dict[str, Any]] = []
  has_reports = False
  benchmark_files = [name for name in files if is_benchmarks(name)]
  for name, file in files.items():
    try:
      if is_junit(name):
        # several reports are one suite in pieces (Maven and Gradle write a file per class): their tests add up
        cases.extend(read_junit(file))
        has_reports = True
      elif name in benchmark_files:
        # several benchmark files: their file's name tells apart benchmarks with the same name, and their charts
        stem = Path(name).name.split('.')[0]
        several = len(benchmark_files) > 1
        metrics.update(benchmark_metrics(file, prefix=f"{stem}_" if several else '', group=f"Benchmarks/{stem}" if several else 'Benchmarks'))
    except Exception as e:
      from .ui import warning
      warning(f"No metrics read from {file}: {e}")
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


def given_metrics(pairs: tuple[str, ...], metrics_file: str | None) -> dict[str, Any]:
  """The metrics of --metrics FILE (a JSON object), then of -m key=value: numbers, true/false, else texts"""
  metrics: dict[str, Any] = {}
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


def default_input(paths: list[Path]) -> str:
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
  from .active_run import plan_run, start_run, RunArgumentError
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
  # what identifies the runs and where they go: the same for --dryrun's plan_run() and start_run()
  arguments: dict[str, Any] = dict(
    configs=configurations, label=group.get('label'), batch=batch_name, project=project, commit=commit,
    platform=group.get('platform'), share=True,
    # a project that keeps its storage: from where it isn't mounted (a GitHub runner...), over HTTP
    _upload_without_storage=True,
  )
  if dryrun:
    # what start_run() would do: the project, the commit, the batch, where the files go
    try:
      plans = [plan_run(name, **arguments) for name, _, _ in runs]
    except RunArgumentError as e:
      raise click.UsageError(e.cli)
    plan = plans[0]
    for note in plan.notes:
      click.echo(f"qaboard: {note}", err=True)
    label = plan.raw_batch
    if plan.batch != plan.raw_batch:
      label = f"{plan.raw_batch} (your own, \"{plan.batch}\": outside the CI)"
    if plan.batch_name:
      label += f", {plan.batch_name} on the runs' cards"
    is_commit = len(plan.commit) == 40 and all(c in '0123456789abcdef' for c in plan.commit)
    click.echo(f"project: {plan.project}")
    click.echo(f"commit: {plan.commit if is_commit else 'none (not in a git repository): give --commit <sha>'}")
    click.echo(f"batch: {label}")
    if not plan.uploads_files:
      click.echo("files: saved in the storage shared with the server")
    elif plan.server_source is None:
      click.echo("files: sent to the QA-Board server (set QABOARD_URL to say which)")
    else:
      from .credentials import resolve_token
      try:
        token_source = resolve_token(plan.server)[1]
      except Exception:
        token_source = None
      click.echo(f"files: sent to {plan.server}")
      click.echo(f"token: {f'from {token_source}' if token_source else 'none: run `qa auth login`, or set QABOARD_TOKEN'}")
    for (name, files, run_metrics), run_plan in zip(runs, plans):
      click.echo(f"{name}: {len(files)} files, {sum(file.stat().st_size for file in files.values())} bytes, metrics: {json.dumps({k: float(v) if isinstance(v, float) else v for k, v in run_metrics.items()})}")
      click.echo(f"  folder: {run_plan.output_dir}{' (its latest attempt: a new one goes next to it)' if run_plan.new_attempt else ''}")
      for file_name in files:
        click.echo(f"  {file_name}")
    return

  for name, files, run_metrics in runs:
    try:
      run = start_run(name, **arguments, capture_output=False)
    except RunArgumentError as e:
      # in the words of qa upload's options rather than start_run()'s arguments
      raise click.UsageError(e.cli)
    except (ValueError, TypeError) as e:
      from .ui import fail
      fail(str(e))
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
      from .ui import fail
      fail(str(e))
    if failed:
      run.fail("qa upload --failed: what made these files failed.")
    else:
      run.finish()
      trends = trends_url(run, run_metrics)
      if trends:
        # where the test reports and benchmarks of the branch's commits show, one after the other
        click.echo(f"qaboard: trends of the branch: {trends}", err=True)
    if not run.sent:
      # the same would happen to the next runs
      missing = "all the files of the run" if run.id is not None else "the run"
      from .ui import fail
      fail(f"QA-Board doesn't have {missing} {name}: see above.")
