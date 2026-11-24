#!/usr/bin/env python
"""
CLI tool to runs various tasks related to QA.
"""
import os
import re
import sys
import json
import time
import uuid
import datetime
import traceback
from shlex import quote
from pathlib import Path

import click

from .lazy import lazy_function, install_rich_traceback_lazily
install_rich_traceback_lazily()
from . import completion
from .completion import complete_batches, complete_platforms, complete_input_types, complete_configurations, complete_inputs
from .completion import complete_runners, complete_actions_on_existing, complete_actions_on_pending
if completion.is_completing():
  # completion prints only the candidates, not what reading qaboard.yaml says
  import io
  import contextlib
  with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    from . import config as _config # noqa: F401

from .run import RunContext

from .conventions import make_batch_dir, make_batch_conf_dir, RUN_DIR_VARIABLE
from .conventions import serialize_config, deserialize_config, get_settings
from .utils import PathType, entrypoint_module, load_tuning_search
from .utils import save_outputs_manifest, total_storage
from .utils import redirect_std_streams, clean_output_dir, interrupted_by_sigterm, ignored_signals
from . import attempts
from .utils import getenvs
from .compat import url_to_dir
from .payloads import serialize_paths
# qaboard.api imports requests: `qa --help` and shell completion don't need it (tests/test_startup.py)
print_url = lazy_function('.api', 'print_url')
get_outputs = lazy_function('.api', 'get_outputs')
notify_qa_database = lazy_function('.api', 'notify_qa_database')
exit_if_results_refused = lazy_function('.api', 'exit_if_results_refused')
print_auth_error = lazy_function('.api', 'print_auth_error')
from .iterators import iter_inputs, iter_parameters, load_runs_file, iter_runs, rerun_job_options, local_job_options
from .batch_logs import saves_logs, batch_log

from .config import config_has_error, ignore_config_errors, report_missing_storage, storage_needed_by, default_share, missing_storage
from .config import project, project_root, subproject, config
from .config import default_batches_files, get_default_database, default_batch_label, default_platform
from .config import get_default_configuration, default_input_type
from .config import commit_id, outputs_commit, artifacts_commit, root_qatools, artifacts_commit_root
from .config import user, is_ci, on_windows, available_metrics, uploads_files, repo_root, COMMANDS_WITHOUT_PROJECT
from .metrics import split_metrics, resolve_definitions, write_definitions_file, with_default_direction
from . import analytics
from . import __version__
from . import ui



def log_config(command: str | None) -> None:
  """What qa resolved before it started (qaboard/config.py does it on import), for `qa -v`"""
  import logging
  logger = logging.getLogger('qaboard.config')
  if not logger.isEnabledFor(logging.INFO):
    return
  from .config import qatools_config_paths, storage_found
  # not qaboard.api: importing it loads requests, and may exchange a CI token
  from .credentials import default_server
  qaboard_url, qaboard_url_source = default_server()
  logger.info("qa %s: qaboard.yaml %s, project %s%s, commit %s, user %s%s", command,
              ', '.join(str(p) for p in qatools_config_paths) or 'not found', project or '-', f" ({subproject})" if subproject and str(subproject) != '.' else '',
              commit_id or '-', user, ', in CI' if is_ci else '')
  logger.info("server %s (from %s), %s", qaboard_url, qaboard_url_source or 'default',
              'storage: none, runs send their files' if uploads_files else 'storage: shared' if storage_found else 'storage: not found')
  logger.debug("outputs in %s, artifacts in %s", outputs_commit, artifacts_commit)


@click.group(cls=ui.Group)
@click.pass_context
@click.version_option(__version__, '--version', message='qa, version %(version)s', help="Print qa's version (qa version --json for more).")
@click.option('--platform', default=default_platform, shell_complete=complete_platforms, help="The platform the runs are for, e.g. linux or windows. Default: this computer's.")
@click.option('--configuration', '--config', '-c', 'configurations', multiple=True, shell_complete=complete_configurations, help="A configuration given to run() (context.configs). Repeat it for several.")
@click.option('--label', '-l', default=default_batch_label, help="A name for these results, e.g. a tuning experiment: QA-Board shows them as their own batch.")
@click.option('--tuning', multiple=True, help="Parameters given to run() (context.params), as JSON, e.g. '{\"threshold\": 0.5}'.")
@click.option('--tuning-filepath', type=PathType(), multiple=True, help="A JSON file of parameters, like --tuning.")
@click.option('--dryrun', is_flag=True, help="Only show what would be done.")
# results are always shared (config.default_share): --share is accepted, for scripts that still give it
@click.option('--share', 'share_flag', is_flag=True, hidden=True)
@click.option('--database', type=PathType(), help="Where the inputs are. Default: inputs.database in qaboard.yaml.")
@click.option('--type', 'input_type', default=default_input_type, shell_complete=complete_input_types, help="The type of the inputs (inputs.types in qaboard.yaml).")
@click.option('--offline', is_flag=True, help="Never contact QA-Board: results stay in output/.")
# Not read from $QA_VERBOSE by Click (auto_envvar_prefix): older scripts set it to anything; qa reads it itself
# (ui.verbose, log_setup). -v: diagnostic logs (qaboard/log_setup.py), what is sent to QA-Board, errors' tracebacks.
@click.option('--verbose', '-v', count=True, allow_from_autoenv=False, help="Say more: -v what qa does, what it sends to QA-Board and errors' tracebacks (like QA_VERBOSE=1), -vv debug logs (each request...), -vvv other libraries' logs too. Or $QA_LOG_LEVEL.")
@click.option('--log-file', type=click.Path(dir_okay=False), help="Also write debug logs to this file. Or $QA_LOG_FILE.")
def qa(ctx, platform, configurations, label, tuning, tuning_filepath, dryrun, share_flag, database, input_type, offline, verbose, log_file):
  """
  Run your code on inputs, and see the results in QA-Board.

  \b
  Examples:
    qa run --input images/a.jpg       # one run
    qa batch my-batch                 # the inputs of a batch, from batches.yaml
    qa --offline batch my-batch       # results stay in output/, not sent to QA-Board
    qa runs <commit page url>         # where a commit's results are
    qa doctor                         # check your setup

  Docs: https://samsung.github.io/qaboard/docs/
  """
  from .log_setup import setup as setup_logs
  setup_logs(verbose, log_file)
  log_config(ctx.invoked_subcommand)
  # Click passes `ctx.obj` to downstream commands, we can use it as a scratchpad
  # http://click.pocoo.org/6/complex/
  if not ctx.obj:
    ctx.obj = {}
  if verbose:
    # also for the runs `qa batch` starts
    os.environ['QA_VERBOSE'] = '1'
  # until we know if the command keeps colors in its logs (below): NO_COLOR, FORCE_COLOR, else colors on terminals
  ctx.color = ui.click_color()
  # Results always show in QA-Board (config.default_share): only --offline keeps them here, or when qa can't share them
  share = False
  if ctx.invoked_subcommand not in ('auth', 'runs', *COMMANDS_WITHOUT_PROJECT):
    share, kept_here_because = default_share(offline)
    # said once, not again by the runs `qa batch` starts. A missing storage has its own warning (report_missing_storage)
    shows_help = '--help' in sys.argv or '-h' in sys.argv
    if kept_here_because and not missing_storage and ctx.invoked_subcommand in ('run', 'batch', 'optimize') and 'QA_BATCH' not in os.environ and not dryrun and not shows_help:
      ui.warning(f"Results stay in output/, not shown in QA-Board ({kept_here_because}).", hint="`qa --offline` hides this.")
  # One usage event per command, sent when it ends (qaboard/analytics.py), never from CI
  analytics.start(ctx.invoked_subcommand, share=share, tuning=bool(tuning or tuning_filepath), dryrun=dryrun, offline=offline)
  # Signing in is global, per server: it doesn't need a project
  if ctx.invoked_subcommand in ('auth', 'runs'):
    return
  # `qa upload` works outside a project too: it reads --label, --configuration and --platform itself
  # `qa fetch-artifacts` and `qa send-batch-log` only talk to the server, e.g. in a pod before it has the commit's qaboard.yaml
  if ctx.invoked_subcommand in COMMANDS_WITHOUT_PROJECT:
    return
  # Local runs save their results in output/: only some commands need the storage
  needed_by = storage_needed_by(ctx.invoked_subcommand, share, is_ci)
  if ctx.invoked_subcommand in ('batch', 'optimize'):
    # they check it once they know if they run locally: with --commit, QA-Board starts the batch (see check_storage)
    ctx.obj['storage_needed_by'] = needed_by
    storage_is_missing = False
  else:
    storage_is_missing = report_missing_storage(needed_by)
  # We want all paths to be relative to top-most qaboard.yaml
  # it should be located at the root of the git repository
  if config_has_error and not ignore_config_errors:
    if not root_qatools:
      # no qaboard.yaml: config.py said it
      sys.exit(1)
    ui.fail("Fix the error(s) above in qaboard.yaml", hint="`qa doctor` checks qaboard.yaml and says how to fix it.")
  if storage_is_missing:
    sys.exit(1)
  will_show_help = '-h' in sys.argv or '--help' in sys.argv

  noop_command = 'init' in sys.argv
  if root_qatools and root_qatools != Path().resolve() and not will_show_help and not noop_command:
    ctx.obj['previous_cwd'] = os.getcwd()
    click.echo(click.style("Working	directory changed to: ", fg='blue') + click.style(str(root_qatools), fg='blue', bold=True), err=True)
    os.chdir(root_qatools)

  # We want open permissions on outputs and artifacts
  # it makes collaboration among multiple users / automated tools so much easier...
  os.umask(0)

  ctx.obj['project'] = project
  ctx.obj['project_root'] = project_root
  ctx.obj['subproject'] = subproject
  ctx.obj['user'] = user
  ctx.obj['dryrun'] = dryrun
  ctx.obj['share'] = share
  ctx.obj['offline'] = offline

  ctx.obj['outputs_commit'] = outputs_commit
  ctx.obj['artifacts_commit'] = artifacts_commit
  ctx.obj['ci_commit_dir'] = artifacts_commit # backward compat for some HW_ALG tests...
  ctx.obj['commit_ci_dir'] = artifacts_commit # backward compat for some HW_ALG tests...
  # Note: to support multiple databases per project,
  # either use / as database, or somehow we need to hash the db in the output path. 
  ctx.obj['raw_batch_label'] = label
  ctx.obj['batch_label'] = label if (not share or is_ci) else f"@{user}| {label}"
  ctx.obj['platform'] = platform

  ctx.obj['input_type'] = input_type
  # `qa doctor` says when the input type is unknown
  known_type = input_type == 'default' or input_type in ((config.get('inputs') or {}).get('types') or {})
  ctx.obj['inputs_settings'] = get_settings(input_type if known_type or ctx.invoked_subcommand != 'doctor' else 'default', config)
  ctx.obj['database'] = database if database else get_default_database(ctx.obj['inputs_settings'])
  # configuration singular is for backward compatibility to a time where there was a single str config
  ctx.obj['configuration'] = ':'.join(configurations) if configurations else get_default_configuration(ctx.obj['inputs_settings'])
  # we should refactor the str configuration away completely, and do a much simpler parsing, like
  #   deserialize_config = lambda configurations: return [maybe_json_loads(c) for c in configurations]
  ctx.obj['configurations'] = deserialize_config(ctx.obj['configuration'])

  # When the tuning contains a field named "_configs", it will be added to the context.configs
  # and not exposed as par of the regular .params mapping used for tuning. Otherwise there is no
  # way to do tuning when we want to tune "str" values
  #   --tuning '"hello"' --tuning '{"key": "value"}' --tuning '["world"]'
  #   => {'_configs': ['hello', 'world'], 'key': 'value'}
  # If the user would want [base,tuning] vs [base], he can try the tuning search
  #   _config: [["base", "tuning"], "base"]
  ctx.obj['extra_parameters'] = {}
  def process_tuning(params_str, origin):
    try:
      params = json.loads(params_str)
    except ValueError as e:
      ui.fail(f"{origin} is not valid JSON: {e}", hint="""Give a JSON object, e.g. --tuning '{"threshold": 0.5}'""")
    if isinstance(params, str):
      if "_configs" not in ctx.obj['extra_parameters']:
        ctx.obj['extra_parameters']["_configs"] = []
      ctx.obj['extra_parameters']["_configs"].append(params)
    elif isinstance(params, list):
      if "_configs" not in ctx.obj['extra_parameters']:
        ctx.obj['extra_parameters']["_configs"] = []
      ctx.obj['extra_parameters']["_configs"].extend(params)
    else:
      from .utils import merge
      merge(params, ctx.obj['extra_parameters'])

  for tp in tuning_filepath:
    process_tuning(tp.read_text(), f"--tuning-filepath {tp}")
  for t in tuning:
    process_tuning(t, f"--tuning {t!r}")

  # batch runs will override this since batches may have different configurations
  ctx.obj['batch_conf_dir'] = make_batch_conf_dir(outputs_commit, ctx.obj['batch_label'], platform, ctx.obj['configurations'], ctx.obj['extra_parameters'], share)
  ctx.obj['batch_dir'] = make_batch_dir(outputs_commit, ctx.obj['batch_label'], platform, ctx.obj['configurations'], ctx.obj['extra_parameters'], share)

  os.environ.update({
    "QA_LABEL": ctx.obj['raw_batch_label'],
  })

  # For convenience, we allow users to change environment variables using {ENV: {VAR: value}}
  # in configurations or tuning parameters
  environment_variables = {}
  for c in ctx.obj['configurations']:
    if not isinstance(c, dict): continue
    if 'ENV' in c: environment_variables.update(c['ENV'])
  if 'ENV' in ctx.obj['extra_parameters']:
    environment_variables.update(ctx.obj['extra_parameters']['ENV'])
  os.environ.update(environment_variables)

  # colors in log files colors will be interpreted in the UIs
  ctx.obj['color'] = is_ci or share
  # `qa run` saves what it prints in the run's log, that QA-Board shows with its colors: they stay, even piped.
  # Elsewhere, colors only on terminals (and never with NO_COLOR): ui.click_color
  ctx.color = ui.click_color(keeps_log_colors=bool(ctx.obj['color']) and ctx.invoked_subcommand in ('run', 'postprocess'))


def saves_attempts(qa_context, custom_output=None) -> bool:
  """
  Whether a run that is done again is saved in a new directory (qaboard/attempts.py): results saved in the storage
  (CI, --share), unless the project opts out (outputs.reruns: in-place). Local runs, in the working directory's
  output/, and runs with their own --output are done again in place.
  """
  if uploads_files:
    # their files are in this computer's output/ folder, done again in place; the server replaces what it has
    return False
  return bool(is_ci or qa_context.get('share')) and not custom_output and attempts.reruns_mode(config) != attempts.IN_PLACE


@qa.command()
@click.option('-i', '--input', 'input_path', type=PathType(), shell_complete=complete_inputs, help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path.')
@click.argument('variable')
@click.pass_context
def get(ctx, input_path, output_path, variable):
  """Prints the value of the requested variable. Mostly useful for debug."""
  # backward compatibility
  if variable == "branch_ci_dir":
    variable = "artifacts_branch_root"
  if variable == "commit_ci_dir":
    variable = "outputs_commit"
  # Not locals().update(): since python 3.13 (PEP 667) it doesn't change the function's variables
  variables = {**globals(), **locals(), **ctx.obj}
  try:
    run_context = RunContext.from_click_run_context(ctx, config)
    variables.update(run_context.asdict())
  except Exception:
    pass

  if variable in variables:
    print(variables[variable])
  else:
    ui.fail(f"Unknown variable: {variable}", hint="e.g. `qa get commit_id`, `qa get outputs_commit`, `qa get --input <input> output_dir`.")




@qa.command(context_settings=dict(
    ignore_unknown_options=True,
    allow_interspersed_args=False,
))
@click.pass_context
@click.option('-i', '--input', 'input_path', required=True, type=PathType(), shell_complete=complete_inputs, help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path.')
@click.option('--keep-previous', is_flag=True, help="Don't clean previous outputs before the run.")
@click.option('--no-postprocess', is_flag=True, help="Don't do the postprocessing.")
@click.option('--save-manifests-in-database', is_flag=True, help="Save the input and outputs manifests in the database.")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def run(ctx, input_path, output_path, keep_previous, no_postprocess, forwarded_args, save_manifests_in_database):
    """
    Run your code on one input, and save its outputs and metrics.

    \b
    Examples:
      qa run --input images/a.jpg
      qa run -i images/a.jpg --threshold 0.5    # what follows the input is given to run() (context.forwarded_args)
      qa -c fast --tuning '{"threshold": 0.5}' run -i images/a.jpg
      qa --offline run -i images/a.jpg          # results stay in output/

    It calls the run() function of the entrypoint in qaboard.yaml (project.entrypoint). Exits with 1 if the run failed.
    """
    ctx.params["forwarded_args"] = [
      *ctx.params["forwarded_args"],
      *ctx.obj.get("forwarded_args", []),
    ]
    run_context = RunContext.from_click_run_context(ctx, config)
    keep_previous = keep_previous or 'QABOARD_RUN_KEEP' in os.environ

    # Results saved in the storage are not replaced in place: a run that is done again gets its own directory,
    # the one `qa batch` reserved if it started us, and the previous attempt's files are removed
    new_attempt = saves_attempts(ctx.obj, custom_output=output_path) and not keep_previous
    if new_attempt:
      run_context.output_dir = attempts.reserve_or_keep(run_context.output_dir)
      ctx.obj["output_directory"] = run_context.output_dir

    if run_context.output_dir.exists():
    # Usually we want to remove any files already present in the output directory.
    # It avoids issues with remaining state... This said,
    # In some cases users want to debug long, multi-stepped runs, for which they have their own caching
      if not keep_previous:
        # TODO: check in the database the status of the run?
        # Keeps the log files runners redirected our output to (e.g. log.lsf.txt with LSF job arrays)
        clean_output_dir(run_context.output_dir)
    run_context.output_dir.mkdir(parents=True, exist_ok=True)
    if new_attempt:
      # the previous attempt's log is kept here, as log.attempt<N>.txt
      attempts.remove_previous(run_context.output_dir)

    with (run_context.output_dir / 'run.json').open('w') as f:
      json.dump({
        # run_context.database is always made absolute, we keep it relative if given so
        "database": str(ctx.obj["database"]),
        "input_path": str(run_context.rel_input_path),
        "input_type": run_context.type,
        "configurations": run_context.configurations,
        "extra_parameters": run_context.extra_parameters,
        "platform": run_context.platform,
      }, f, sort_keys=True, indent=2, separators=(',', ': '))

    # Without this, we can only log runs from `qa batch`, on linux, via LSF
    # this redirect is not 100% perfect, we don't get stdout from C calls
    # if not 'LSB_JOBID' in os.environ: # When using LSF, we usally already have incremental logs
    with redirect_std_streams(run_context.output_dir / 'log.txt', color=ctx.obj['color']):
      # Help reproduce qa runs with something copy-pastable in the logs
      if is_ci:
        click.secho(' '.join(['qa', *map(quote, sys.argv[1:])]), fg='cyan', bold=True)
      click.echo(click.style("Outputs: ", fg='cyan') + click.style(str(run_context.output_dir), fg='cyan', bold=True), err=True)
      print_url(ctx)

      # Interrupted while it starts, e.g. while the server is slow to answer, the run fails like during run()
      with interrupted_by_sigterm():
        try:
          # what the run uses of its machine, sent with heartbeats and its end, plotted from system.series.json
          start_system_metrics(run_context)
          start_local_changes(run_context)
          qa_run_data = None
          if not ctx.obj['offline']:
              # heartbeat: we say every few minutes that the run still runs, else the server fails it (qaboard/heartbeat.py)
              qa_run_data = notify_qa_database(**ctx.obj, is_pending=True, is_running=True, keep_previous=keep_previous, heartbeat=True,
                                               data={**attempts.kept_logs_data(run_context.output_dir), **local_changes_data()})
              if qa_run_data:
                run_context.id = qa_run_data["id"]
                run_reporter(run_context).start(run_context.id)
              # in CI, results QA-Board refuses are lost: don't compute them
              exit_if_results_refused()
          save_local_changes(run_context, qa_run_data, offline=ctx.obj['offline'])
        except KeyboardInterrupt:
          mark_aborted(run_context)
          raise

      os.environ[RUN_DIR_VARIABLE] = str(run_context.output_dir)
      # LSF sends SIGINT then SIGTERM when users bkill the job or it uses too much memory, before a SIGKILL:
      # we say the run failed, or QA-Board would show it as running
      with interrupted_by_sigterm():
        try:
          start = time.time()
          cwd = os.getcwd() 

          try:
            runtime_metrics = entrypoint_module(config).run(run_context)
          except Exception as e:
            exc_type, exc_value, exc_traceback = sys.exc_info()
            # the traceback of the project's code: it says where to fix it
            ui.error(f"Your `run` function raised an exception: {e!r}")
            try:
              exc_type, exc_value, exc_traceback = sys.exc_info()
              ui.echo(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red')
            except Exception as e: # debug strange stale file errors, ideally remove this...
              ui.error(str(e))
            runtime_metrics = {'is_failed': True}
          except SystemExit as e:
            # run() exited instead of returning: the run ends here, and we still save what it did
            if e.code not in (None, 0):
              ui.error(f"Your `run` function exited with {e.code}")
            runtime_metrics = {'is_failed': e.code not in (None, 0)}

          if not runtime_metrics:
            runtime_metrics = {"is_failed": False}

          if not isinstance(runtime_metrics, dict):
            ui.error(f"Your `run` function did not return a dict, but {runtime_metrics!r}", hint="Return the run's metrics, e.g. {\"is_failed\": False, \"loss\": 0.1}, or None.")
            runtime_metrics = {'is_failed': True}

          runtime_metrics['compute_time'] = time.time() - start
          # we measure run(): postprocess() comes after, and system.series.json is final when the outputs' manifest is made
          stop_system_metrics()

          # avoid issues if code in run() changes cwd
          if os.getcwd() != cwd:
            os.chdir(cwd)

          metrics = postprocess_(runtime_metrics, run_context, skip=no_postprocess or runtime_metrics.get('is_failed', False), save_manifests_in_database=save_manifests_in_database, print_summary=True)
          exit_if_results_refused()
          if metrics['is_failed']:
            sys.exit(1)
          # in CI, results the server doesn't have are lost
          if (files_not_sent() or run_end_not_sent()) and is_ci:
            if run_end_not_sent():
              ui.error("QA-Board doesn't know how the run ended: it shows it as running, then failed.")
            sys.exit(1)
        except KeyboardInterrupt:
          mark_aborted(run_context)
          raise


# What the run uses of its machine (qaboard/system_metrics.py). One run per process.
_system_metrics = None


def start_system_metrics(run_context):
  """Samples what the run uses of its machine, unless the project or $QA_SYSTEM_METRICS turned it off"""
  global _system_metrics
  from . import system_metrics
  if _system_metrics is None and system_metrics.enabled(config):
    try:
      _system_metrics = system_metrics.SystemMetrics(run_context.output_dir, interval=system_metrics.interval()).start()
    except Exception as e:  # e.g. no thread left: the run matters more
      ui.warning(f"Can't measure what the run uses of its machine: {e!r}")
  return _system_metrics


def stop_system_metrics():
  """The last sample: the summary stays the same after"""
  if _system_metrics is not None:
    _system_metrics.stop()


def resources_report() -> dict:
  """What the server keeps as data.resources: with each heartbeat, and with the run's end"""
  return {"resources": _system_metrics.summary()} if _system_metrics is not None else {}


# What the run changed in its repository, compared with its commit (qaboard/local_changes.py). One run per process.
_local_changes = None


def start_local_changes(run_context):
  """What the run's code differs from its commit by: per run, or what `qa batch` captured when it started"""
  global _local_changes
  from . import local_changes
  from .config import project_dir, is_in_git_repo
  if _local_changes is None:
    project_output = project_dir / 'output' if project_dir else None
    _local_changes = local_changes.ForRun(
      (config.get('outputs') or {}).get('local_changes'),
      repo_root=repo_root if is_in_git_repo else None,
      is_ci=is_ci,
      commit=commit_id,
      ignore=local_changes.inside(repo_root, [project_output, run_context.output_dir]),
    )
    for problem in _local_changes.problems:
      ui.warning(problem)
  return _local_changes


def save_local_changes(run_context, answer=None, offline=False):
  """
  Saves the patches in the run's folder, as far as the server allows (its answer when the run started). The runs
  of a batch say it only when the code changed since the batch said it.
  """
  from . import local_changes
  if _local_changes is None or _local_changes.capture is None:
    return
  state = _local_changes.save(run_context.output_dir, (answer or {}).get('local_changes_level'), unanswered=not offline and answer is None)
  if 'QA_BATCH' in os.environ and not _local_changes.changed_since_batch:
    return
  patch = run_context.output_dir / local_changes.PATCH_FILE
  try:
    saved_in = os.path.relpath(patch) if patch.exists() else None
  except ValueError:  # another drive, on Windows
    saved_in = str(patch)
  # a run in the storage: its absolute path, not ../../../mnt/...
  if saved_in and saved_in.startswith('..'):
    saved_in = str(patch)
  line = local_changes.describe(state, saved_in=saved_in)
  if line:
    click.secho(f"Local changes: {line}", fg='cyan', err=True)


def share_local_changes():
  """
  Captures the local changes once for the runs of a batch (they read $QA_LOCAL_CHANGES_STATE), unless a batch that
  started this one did. Returns what to restore with restore_local_changes.
  """
  from . import local_changes
  from .config import project_dir, is_in_git_repo
  previous = os.environ.get(local_changes.ENV_STATE)
  if previous is not None or not is_in_git_repo:
    return previous
  settings, _ = local_changes.settings((config.get('outputs') or {}).get('local_changes'), is_ci=is_ci)
  if settings.level == 'off':
    return None
  project_output = project_dir / 'output' if project_dir else None
  captured = local_changes.capture(repo_root, settings, ignore=local_changes.inside(repo_root, [project_output]))
  if captured is None:
    return None
  if captured.state.get('head') and captured.state['head'] != commit_id:
    return None
  path = local_changes.share(captured)
  if path is not None:
    os.environ[local_changes.ENV_STATE] = str(path)
  line = local_changes.describe(captured.state, batch=True)
  if line:
    click.secho(f"Local changes: {line}", fg='cyan', err=True)
  return None


def restore_local_changes(previous):
  from . import local_changes
  if previous is None:
    os.environ.pop(local_changes.ENV_STATE, None)
  else:
    os.environ[local_changes.ENV_STATE] = previous


def local_changes_data() -> dict:
  """What the server keeps as data.local_changes"""
  return _local_changes.data() if _local_changes is not None else {}


# What `qa run` tells the server besides its results (qaboard/reporting.py): every few minutes that the run still
# runs, and without a storage shared with it, the run's files: its log as it goes, everything when it ends. One run per process.
_reporter = None


def sends_files(qa_context) -> bool:
  """Whether the run's files are sent to the server: shared runs, when there is no storage shared with it"""
  return bool(uploads_files and (is_ci or qa_context.get('share')) and not qa_context.get('offline') and not qa_context.get('dryrun'))


def run_reporter(run_context):
  """The run's reporter, created the first time"""
  global _reporter
  if _reporter is None:
    from .api import qaboard_url
    from .reporting import RunReporter
    log = run_context.output_dir / 'log.txt'
    _reporter = RunReporter(qaboard_url, run_context.output_dir, uploads=sends_files(run_context.obj), live=(config.get('outputs') or {}).get('live'),
                            # with what the run printed last, e.g. that it failed
                            before_log=lambda: wait_for_the_log(log), extra=resources_report)
  return _reporter


def files_not_sent() -> bool:
  """Whether the server doesn't have all the run's files, after finish_upload"""
  return _reporter is not None and _reporter.files_sent is False


# set by notify_run_ended when the server should have heard how the run ended, and didn't
_run_end_lost = False


def run_end_not_sent() -> bool:
  """Whether the server never got the run's end, after notify_run_ended (refusals: exit_if_results_refused)"""
  from .api import results_refused
  return _run_end_lost and not results_refused


def wait_for_the_log(log: Path, timeout: float = 1.0, quiet: float = 0.1):
  """A thread copies what the run prints to its log (qaboard/fd_tee.py): what was just printed may not be there yet"""
  for stream in (sys.stdout, sys.stderr):
    try:
      stream.flush()
    except (AttributeError, OSError, ValueError):
      pass
  deadline, size = time.monotonic() + timeout, None
  while time.monotonic() < deadline:
    current = log.stat().st_size if log.exists() else 0
    if current == size:
      return
    size = current
    time.sleep(quiet)


def finish_upload(run_context):
  """Sends the run's files before telling the server that it ended: finished runs' files don't change"""
  if not sends_files(run_context.obj):
    return
  reporter = run_reporter(run_context)
  if reporter.finished:
    return

  def create():
    # the server didn't answer when the run started: it has to know the run, as running, to take its files
    started = notify_qa_database(**run_context.obj, is_pending=True, is_running=True, keep_previous=True, heartbeat=True)
    if started:
      run_context.id = started["id"]
      return started["id"]
    return None

  if reporter.finish(create=create):
    click.secho(f"Sent {reporter.uploader.sent_files} files to QA-Board ({reporter.uploader.sent_bytes / 1e6:.1f} MB)", fg='cyan', err=True)
  elif reporter.uploader is None:
    ui.error(f"QA-Board doesn't have the files of the run: it didn't take the run. They are in {run_context.output_dir}")
    return
  else:
    ui.error("\n".join(["QA-Board doesn't have all the files of the run:", *(f"- {problem}" for problem in reporter.problems())]))
  # what we just printed, in the log the web app shows
  reporter.send_log()


def notify_run_ended(run_context, **kwargs):
  """
  Tells the server that the run ended (after `finish_upload`), then stops reporting. If it refused that, it still
  has why, in the log
  """
  global _run_end_lost
  if _reporter is not None and _reporter.files_missing:
    # the run's page can say so (the server keeps `data`)
    kwargs['data'] = {**(kwargs.get('data') or {}), 'files_missing': _reporter.files_missing}
  if _system_metrics is not None:
    kwargs['data'] = {**(kwargs.get('data') or {}), **resources_report()}
  if local_changes_data():
    kwargs['data'] = {**(kwargs.get('data') or {}), **local_changes_data()}
  answer = notify_qa_database(**run_context.obj, **kwargs, is_pending=False, is_running=False)
  obj = run_context.obj
  # runs in a shared storage keep their files: like files not sent, only uploads fail CI for it
  _run_end_lost = answer is None and sends_files(obj)
  if _reporter is not None:
    _reporter.ended(known=answer is not None)
  return answer


def mark_aborted(run_context):
  """Saves that the run failed after it was interrupted, in metrics.json and in QA-Board."""
  with ignored_signals():
    ui.error('The run was aborted: marked as failed.')
    metrics_path = run_context.output_dir / 'metrics.json'
    metrics = {}
    try:
      if metrics_path.exists():
        with metrics_path.open() as f:
          metrics = json.load(f)
    except (OSError, ValueError):
      pass
    metrics['is_failed'] = True
    try:
      with metrics_path.open('w') as f:
        json.dump(metrics, f, sort_keys=True, indent=2, separators=(',', ': '))
    except OSError as e:
      ui.error(f'Could not write {metrics_path}: {e}')
    # e.g. LSF stops jobs that use too much memory, with SIGINT/SIGTERM, and SIGKILL a few seconds later: the server
    # hears first, with what the run used until its last sample
    if not run_context.obj.get('offline') and not run_context.obj.get('dryrun'):
      finish_upload(run_context)
      notify_run_ended(run_context, metrics=metrics, is_failed=True)
    stop_system_metrics()


def postprocess_(runtime_metrics, run_context, skip=False, save_manifests_in_database=False, print_summary=False):
  """
  Computes computes various success metrics and outputs.
  `print_summary`: print the metrics, and whether the run failed, before the results are sent: runs that send their
  files to the server send their log with them, and a finished run's files don't change.
  """
  from .utils import file_info
  from .compat import windows_to_linux_path

  # whether the project's `postprocess` gave the metrics
  postprocessed = False
  try:
    if not skip:
      try:
        entrypoint_postprocess = entrypoint_module(config).postprocess
      except Exception:
        metrics = runtime_metrics
      else:
        metrics = entrypoint_postprocess(runtime_metrics, run_context)
        postprocessed = True
    else:
      metrics = runtime_metrics
  except Exception:
    exc_type, exc_value, exc_traceback = sys.exc_info()
    # TODO: in case of import error because postprocess was not defined, just ignore it...?
    # TODO: we should provide a default postprocess function, that reads metrics.json and returns {**previous, **runtime_metrics}
    exc_type, exc_value, exc_traceback = sys.exc_info()
    ui.error(f"Your `postprocess` function raised an exception: {exc_value!r}")
    ui.echo(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red')
    metrics = {**runtime_metrics, 'is_failed': True}

  if 'is_failed' not in metrics:
    # run() may leave it out: it didn't fail
    if postprocessed:
      ui.warning("The result of the `postprocess` function misses a key `is_failed` (bool): the run is taken as successful.")
    metrics['is_failed'] = False

  if (run_context.output_dir / 'metrics.json').exists():
    with (run_context.output_dir / 'metrics.json').open('r') as f:
      previous_metrics = json.load(f)
      metrics = {
        **previous_metrics,
        **metrics,
      }
  # The run's metrics are final: save their values, and how to show them, e.g. Metric(12.3, suffix=" ms") or
  # define_metric, only for the metrics the run returned. See qaboard/metrics.py
  metrics, inline_definitions = split_metrics(metrics)
  with (run_context.output_dir / 'metrics.json').open('w') as f:
      json.dump(metrics, f, sort_keys=True, indent=2, separators=(',', ': '))
  metrics_definitions = {}
  try:
    definitions = resolve_definitions(metrics, inline_definitions, run_context.output_dir)
    # qa measures it: say how to show it, unless the project did
    if 'compute_time' in metrics and 'compute_time' not in definitions and 'compute_time' not in (available_metrics or {}):
      definitions['compute_time'] = {'label': 'Run time', 'short_label': 'Run time', 'suffix': ' s', 'smaller_is_better': True}
    write_definitions_file(run_context.output_dir, definitions)
    metrics_definitions = with_default_direction(definitions, available_metrics)
  except Exception as e:
    ui.warning(f'Could not save the definitions of the metrics: {e}')

  # To help identify if input files change, we compute and save some metadata.
  manifest_inputs = run_context.obj.get('manifest-inputs', [run_context.input_path])
  input_files = {}
  def manifest_path_str(path):
    return windows_to_linux_path(path).as_posix()
  def update_manifest(path):
    path_str = manifest_path_str(path)
    input_files[path_str] = file_info(path, config=config)
  for manifest_input in manifest_inputs:
    manifest_input = Path(manifest_input)
    if manifest_input.is_dir():
      for idx, path in enumerate(manifest_input.rglob('*')):
        if idx >= 200:
          break
        if not path.is_file():
          continue
        update_manifest(path)
    elif manifest_input.is_file():
      update_manifest(manifest_input)
  try:
    with (run_context.output_dir / 'manifest.inputs.json').open('w') as f:
      json.dump(input_files, f, sort_keys=True, indent=2)
  except Exception as e:
    ui.warning(f'Could not write the input manifest: {e}')

  output_data = {}
  try:
    outputs_manifest = save_outputs_manifest(run_context.output_dir, config=config)
    output_data['storage'] = total_storage(outputs_manifest)
  except Exception as e:
    outputs_manifest = {}
    ui.warning(f'Could not write the output manifest: {e}')
  if 'params' in metrics:
    output_data['params'] = metrics['params']
    del metrics['params']
  # the earlier attempts whose logs are next to the run's (qaboard/attempts.py)
  output_data.update(attempts.kept_logs_data(run_context.output_dir))


  if save_manifests_in_database:
    if run_context.input_path.is_file():
      ui.warning(f'--save-manifests-in-database only works for inputs that are folders, not {run_context.input_path}.')
    else:
      from .utils import copy
      copy(run_context.output_dir / 'manifest.inputs.json', run_context.input_path / 'manifest.inputs.json')
      copy(run_context.output_dir / 'manifest.outputs.json', run_context.input_path / 'manifest.outputs.json')

  if print_summary:
    # the metrics, on stdout as before: some scripts read them
    if metrics['is_failed']:
      ui.error('The run has failed.')
      click.secho(str(metrics), fg='red', bold=True)
    else:
      click.secho(str(metrics), fg='green')

  global _run_end_lost
  _run_end_lost = False
  if not run_context.obj.get('offline') and not run_context.obj.get('dryrun'):
    finish_upload(run_context)
    notify_run_ended(run_context, metrics=metrics, metrics_definitions=metrics_definitions, data=output_data)


  ###### SIRC-specific ########################################################
  # Track output images in IDB, only if the (internal) idb_client package is installed
  try:
    import idb_client  # noqa: F401
    has_idb = True
  except ImportError:
    has_idb = False
  try:
    if has_idb and input_files:
      from .idb import update_idb
      update_idb(run_context, input_files, outputs_manifest, manifest_path_str)
  except Exception as e:
    from sentry_sdk import capture_exception
    capture_exception(e)
    ui.warning(f"idb raised {e}")
    from .site_config import site_config
    backlog_dir = site_config('QABOARD_IDB_BACKLOG_DIR')
    if backlog_dir:
      import random
      hex_string = ''.join(random.choices('0123456789abcdef', k=8))
      task_path = Path(backlog_dir) / f"{hex_string}.pickle"
      try:
        json.dump(
          {
            "id": run_context.id,
            "input_path": str(run_context.input_path),
            "output_dir": str(run_context.output_dir),
            "batch_label": run_context.obj['batch_label'],
            "project": str(project.name),
            "commit_id": commit_id,
            "input_files": input_files,
            "outputs_manifest": outputs_manifest,
          },
          task_path.open("w")
        )
      except Exception as e_backlog:
        ui.warning(f"Could not save the idb task in the backlog: {e_backlog}")
      ### Then to tackle the backlog...
      # for task in backlog_dir.glob("*.pickle"):
      #   args = pickle.load(task.open())
      #   from qaboard.idb import idb_update
      #   idb_update(*args)
      #   task.unlink() # delete the file

  if os.name == "nt" and not run_context.obj.get('dryrun') and (run_context.obj.get('share') or is_ci):
    from qaboard.compat import fix_linux_permissions
    fix_linux_permissions(run_context.output_dir)

  return metrics



@qa.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('-i', '--input', 'input_path', required=True, type=PathType(), shell_complete=complete_inputs, help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path.')
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def postprocess(ctx, input_path, output_path, forwarded_args):
  """Run only the post-processing, assuming results already exist."""
  ctx.params["forwarded_args"] = [
    *ctx.params["forwarded_args"],
    *ctx.obj.get("forwarded_args", []),
  ]
  run_context = RunContext.from_click_run_context(ctx, config)
  with redirect_std_streams(run_context.output_dir / 'log.txt', color=ctx.obj['color']):
    click.echo(click.style("Outputs: ", fg='cyan') + click.style(str(run_context.output_dir), fg='cyan', bold=True), err=True)
    print_url(ctx)
    metrics = postprocess_({}, run_context)
    if metrics['is_failed']:
      ui.error('The run has failed.')
      click.secho(str(metrics), fg='red')
    else:
      click.secho(str(metrics), fg='green')      



@qa.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('-i', '--input', 'input_path', required=True, type=PathType(), shell_complete=complete_inputs, help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path.')
def sync(ctx, input_path, output_path):
  """Updates the database metrics using metrics.json"""
  run_context = RunContext.from_click_run_context(ctx, config)
  if (run_context.output_dir / 'metrics.json').exists():
    with (run_context.output_dir / 'metrics.json').open('r') as f:
      metrics = json.load(f)
    # the run saved its definitions in metrics_definitions.json, define_metric() calls run when the entrypoint is imported
    entrypoint_module(config)
    metrics_definitions = with_default_direction(resolve_definitions(metrics, {}, run_context.output_dir), available_metrics)
    notify_qa_database(**ctx.obj, metrics=metrics, metrics_definitions=metrics_definitions, is_pending=False, is_running=False)
    click.secho(str(metrics), fg='green')      



@qa.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('--output-id', 'output_id', help='Custom output directory path.')
def wait(ctx, output_id):
  from .api import get_output
  first = True
  while True:
    output = get_output(output_id)
    if not output["is_pending"]:
      break
    if first:
      ui.echo("...waiting for previously started pending run. To run directly, use qa batch --action-on-pending=run")
      first = False
    else:
      ui.echo("...waiting")
    time.sleep(5)
  sys.exit(0 if not output["is_failed"] else 1)


# `runners:` or `runners.lsf:` left empty in qaboard.yaml are None
runners_config = config.get('runners') or {}
lsf_config = (config['lsf'] if 'lsf' in config else runners_config.get('lsf')) or {}

if 'default' in runners_config:
  default_runner = runners_config['default']
else:
  task_runners = [r for r in runners_config if r not in ['default', 'local']]
  default_runner = task_runners[0] if task_runners else 'local'
if 'lsf' in config:
  default_runner = 'lsf'
if default_runner ==  'lsf' and os.name=='nt':
  default_runner = 'local'
local_config = runners_config.get('local') or {}

default_lsf_queue = lsf_config.get('queue')
default_lsf_max_threads = lsf_config.get('max_threads', 0)
default_lsf_max_memory = lsf_config.get('max_memory', lsf_config.get('memory', 0))
default_lsf_resources = lsf_config.get('resources', None)
default_lsf_priority = lsf_config.get('priority')
default_lsf_options = lsf_config.get('options')
default_lsf_concurrency = lsf_config.get('concurrency', 0)
dask_config = (config.get('runners') or {}).get('dask') or {}
default_dask_concurrency = dask_config.get('concurrency')

def batch_json_output(command):
  """
  `qa batch --json` and `--list-batches`, around the command: it runs as usual with --save-runs, printing on stderr,
  then we print its runs and how it went (documented in website/docs/using-the-qa-cli.mdx).
  """
  import functools
  @functools.wraps(command)
  def wrapper(ctx, *args, as_json=False, list_batches=False, **kwargs):
    from .json_output import stdout_to_stderr, print_json
    if list_batches:
      names = completion.batch_names(kwargs.get('batches_files') or [])
      if as_json:
        print_json({"batches": names})
      else:
        for name in names:
          click.echo(name['name'])
      return
    listing = any(kwargs.get(flag) for flag in ('list_contexts', 'list_output_dirs', 'list_inputs'))
    if not as_json or listing:
      return command(ctx, *args, **kwargs)
    if kwargs.get('on_commit') is not None:
      # QA-Board starts it: on_server.start_on_server prints the JSON, the only thing it prints on stdout
      ctx.meta['qaboard.json'] = True
      try:
        return command(ctx, *args, **kwargs)
      finally:
        ctx.meta.pop('qaboard.json', None)
    import tempfile
    exit_code = 0
    with tempfile.TemporaryDirectory() as folder:
      runs_path = Path(folder) / 'runs.json'
      with stdout_to_stderr():
        try:
          command(ctx, *args, **{**kwargs, 'save_runs': runs_path})
        except SystemExit as e:
          exit_code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
      saved = runs_path.exists()
      runs = json.loads(runs_path.read_text(encoding='utf-8')) if saved else []
    if kwargs.get('save_runs') and saved:
      write_runs(kwargs['save_runs'], runs, ctx)
    shared = bool(ctx.obj.get('share')) and not ctx.obj.get('offline')
    from .api import results_url
    print_json({
      "ok": exit_code == 0,
      "exit_code": exit_code,
      # as saved: `@<user>| <label>` outside CI; `label` is what `qa --label` was given
      "batch_label": ctx.obj.get('batch_label'),
      "label": ctx.obj.get('raw_batch_label'),
      "commit": commit_id,
      "platform": ctx.obj.get('platform'),
      "shared": shared,
      "url": results_url(ctx.obj) if (shared or is_ci) and not ctx.obj.get('dryrun') else None,
      "waited": not kwargs.get('no_wait'),
      "dryrun": bool(ctx.obj.get('dryrun')),
      "counts": {"runs": len(runs), "skipped": sum(1 for run in runs if run.get('skipped'))},
      "runs": runs,
    })
    if exit_code:
      sys.exit(exit_code)
  return wrapper


def check_storage(ctx):
  """For `qa batch` and `qa optimize`, when they run locally: exits if the storage they need is missing (see the `qa` group)."""
  if report_missing_storage(ctx.obj.pop('storage_needed_by', None)):
    sys.exit(1)


def print_batch_summary(jobs):
  """How the runs of `qa batch` went, on stderr: one line, or a table of the failed runs on terminals."""
  failed = getattr(jobs, 'failed_jobs', None)
  if failed is None or not len(jobs):
    return
  total = len(jobs)
  plural = lambda n: f"{n} run{'s' if n != 1 else ''}"
  if not failed:
    ui.success(f"{plural(total)} passed")
    return
  ui.error(f"{len(failed)} of {plural(total)} failed")
  # those that didn't say already where their log is
  failed = [job for job in failed if job not in getattr(jobs, 'explained_jobs', [])]
  if not failed:
    return
  if ui.rich_output(sys.stderr):
    ui.print_table(['input', 'configurations', 'log'], [
      [str(job.run_context.rel_input_path), serialize_config(job.run_context.configurations) or '-', str(job.run_context.output_dir / 'log.txt')]
      for job in failed[:20]
    ], stream=sys.stderr)
  else:
    for job in failed[:20]:
      click.echo(f"  {job.run_context.rel_input_path}  {serialize_config(job.run_context.configurations)}  {job.run_context.output_dir / 'log.txt'}", err=True)
  if len(failed) > 20:
    click.echo(f"  ... and {len(failed) - 20} more", err=True)


def split_batch_names(batch_names) -> tuple[list[str], list[str] | None]:
  """`qa batch`'s arguments: (the batch names, the arguments to forward to the code, None if there is no separator)"""
  for i, arg in enumerate(batch_names):
    if arg == "--": # explicit separator → everything after is forwarded args
      return list(batch_names[:i]), list(batch_names[i + 1:])
    # Implicit separator → everything from here is forwarded args
    # We do this for backward compat mostly... not sure batch names should start with "-"!
    elif arg.startswith("-"):
      return list(batch_names[:i]), list(batch_names[i:])
  return list(batch_names), None


def env_number(parse, value, default):
  """A number from the environment. `qa doctor` reports invalid ones instead of failing to start."""
  from .config import is_doctor_command
  try:
    return parse(value)
  except (TypeError, ValueError):
    if not is_doctor_command:
      raise
    return default

# An int like --local-concurrency's: a string would differ from it, and count as given on the command line
default_local_concurrency = env_number(int, os.environ['QA_BATCH_CONCURRENCY'], None) if os.environ.get('QA_BATCH_CONCURRENCY') else local_config.get('concurrency')
default_local_timeout = env_number(float, os.environ.get('QA_BATCH_TIMEOUT', local_config.get('timeout', 0)), 0)


def listed_runs(listed) -> list[dict]:
  """The runs of `qa batch --list` and --save-runs: the jobs, where their run was saved (QA-Board knows it once
  they ran: their `qa run` may have used another directory than we reserved), and the runs we skipped."""
  from .runners import Job
  runs = []
  for item in listed:
    if not isinstance(item, Job):
      runs.append(item)
      continue
    run = {**serialize_paths(item.run_context.asdict()), "skipped": False}
    qaboard_output = item.qaboard_output or {}
    if run.get('id') is None and qaboard_output.get('id') is not None:
      run['id'] = qaboard_output['id']
    local_dir = item.run_context.output_dir
    output_dir_url = qaboard_output.get('output_dir_url')
    if output_dir_url:
      run['output_dir'] = serialize_paths(url_to_dir(output_dir_url))
      # runs without a shared storage are saved here, then send their files: the server keeps them elsewhere
      if local_dir and Path(run['output_dir']) != Path(local_dir):
        run['local_output_dir'] = serialize_paths(local_dir)
    # once the run is done: what it returned
    metrics_file = Path(local_dir) / 'metrics.json' if local_dir else None
    if metrics_file and metrics_file.is_file():
      try:
        metrics = json.loads(metrics_file.read_text(encoding='utf-8'))
        if isinstance(metrics, dict):
          run['is_failed'] = bool(metrics.get('is_failed'))
          run['metrics'] = metrics
      except (OSError, ValueError):
        pass
    runs.append(run)
  return runs


def write_runs(path: Path, listed, ctx) -> None:
  """--save-runs: relative to where `qa` was started"""
  if not path.is_absolute():
    path = Path(ctx.obj.get('previous_cwd') or os.getcwd()) / path
  path.parent.mkdir(parents=True, exist_ok=True)
  temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
  temporary.write_text(json.dumps(listed_runs(listed), indent=2), encoding='utf-8')
  os.replace(temporary, path)


default_action_on_existing = config.get('outputs', {}).get('action_on_existing', "run")
default_action_on_pending = config.get('outputs', {}).get('action_on_pending', "wait")
@qa.command(context_settings=dict(
    ignore_unknown_options=True,
    allow_interspersed_args=True,
))
@click.option('--commit', 'on_commit', help="Have QA-Board start the batch on this pushed commit (id, branch, tag), as from its web app, from the commit's artifacts. Batches come from the commit's inputs.batches, then your shared and private batches in QA-Board, then the --batches-file you send (read last, they win). Needs --label. Prints the batch's page and returns.")
@click.option('--batch', '-b', 'batches', multiple=True, shell_complete=complete_batches, help="We run over all inputs+configs+database in those batches")
@click.option('--batches-file', 'batches_files', type=PathType(),  default=default_batches_files, multiple=True, help="YAML files listing batches of inputs+configs+database.")
@click.option('--runs-file', type=PathType(), default=None, help='Instead of batches, a JSON file listing the runs to do, e.g. to redo runs: {"runs": [{"input_path", "database", "type", "platform", "configurations", "extra_parameters", "job_options"}]}. Runs are done with the runner and job options they list, unless you give a --runner.')
@click.option('--tuning-search', 'tuning_search_dict', help='string containing JSON describing the tuning parameters to explore')
@click.option('--tuning-search-file', type=PathType(), default=None, help='tuning file describing the tuning parameters to explore')
@click.option('--no-wait', is_flag=True, help="If true, returns as soon as the jobs are sent, otherwise waits for completion.")
@click.option('--list', 'list_contexts', is_flag=True, help="Print as JSON details about each run we would do, with --action-on-existing: where the runs we would start would be saved, where those we would skip are (\"skipped\": true).")
@click.option('--list-output-dirs', is_flag=True, help="Only print where the results of each run are saved now (their latest attempt).")
@click.option('--save-runs', type=PathType(), default=None, help="Once the runs are started (and done, without --no-wait), write to this JSON file the details of each, as --list prints them: where they were saved, and whether they were skipped. For scripts that read the results next.")
@click.option('--list-inputs', is_flag=True, help="Print to stdout a JSON with a list of the inputs we would call qa run on.")
@click.option('--runner', default=default_runner, shell_complete=complete_runners, help="Run runs locally or using a task queue like Celery, LSF...")
@click.option('--local-concurrency', default=default_local_concurrency, type=int, help="How many runs run at the same time (joblib's n_jobs): 1=one at a time (if not set), 2=2 at a time, -1=one per CPU, -2=all CPUs but one")
@click.option('--local-timeout', default=default_local_timeout, type=int, help="Timeout for local runs")
@click.option('--lsf-max-threads', default=default_lsf_max_threads, type=int, help="restrict number of lsf threads to use. 0=no restriction")
@click.option('--lsf-max-memory', default=default_lsf_max_memory, help="restrict memory (MB) to use. 0=no restriction")
@click.option('--lsf-queue', default=default_lsf_queue, help="LSF queue (-q)")
@click.option('--lsf-resources', default=default_lsf_resources, help="LSF resources restrictions (-R)")
@click.option('--lsf-priority', default=default_lsf_priority, type=int, help="LSF priority (-sp)")
@click.option('--lsf-options', default=default_lsf_options, help="Other LSF options (as 1 string, like '-W 24:00') that bsub can understand. Will be added after all other CLI flags.")
@click.option('--lsf-concurrency', default=default_lsf_concurrency, type=int, help="Max number of LSF jobs from this batch running at the same time. 0=unlimited")
@click.option('--dask-concurrency', default=default_dask_concurrency, type=int, help="Max number of runs from this batch running at the same time on dask workers.")
@click.option('--action-on-existing', default=default_action_on_existing, shell_complete=complete_actions_on_existing, help="When there are already finished successful runs, whether to do run / postprocess (only) / sync (re-read metrics from output dir) / skip / assert-exists")
@click.option('--action-on-pending', default=default_action_on_pending, shell_complete=complete_actions_on_pending, help="When there are already pending runs, whether to do wait (then run) / sync (use those runs' results) / skip (don't run) / run (run as usual, can cause races)")
@click.option('--prefix-outputs-path', type=PathType(), default=None, help='Custom prefix for the outputs; they will be at $prefix/$output_path')
@click.option('--list-batches', is_flag=True, help="Print the batches and aliases of the batches files, one per line (with --json: {\"batches\": [{\"name\", \"kind\": batch|alias, \"file\"}]}).")
@click.option('--json', 'as_json', is_flag=True, help="Print a summary as JSON on stdout once the batch is done (or started, with --no-wait): its runs as --list describes them, the exit code, the batch's page... What the runs print goes to stderr. --list already prints JSON.")
@click.argument('batch_names', nargs=-1, type=click.UNPROCESSED, shell_complete=complete_batches)
@click.pass_context
@batch_json_output
@saves_logs
def batch(ctx, on_commit, batches, batches_files, runs_file, tuning_search_dict, tuning_search_file, no_wait, list_contexts, list_output_dirs, save_runs, list_inputs, runner, local_concurrency, local_timeout, lsf_max_threads, lsf_max_memory, lsf_queue, lsf_resources, lsf_priority, lsf_options, lsf_concurrency, dask_concurrency, action_on_existing, action_on_pending, prefix_outputs_path, batch_names):
  """
  Run your code on the inputs of batches, with a runner (local, LSF, Celery, Kubernetes...).

  \b
  Examples:
    qa batch my-batch                     # a batch of batches.yaml (inputs.batches in qaboard.yaml)
    qa batch my-batch other-batch
    qa batch my-batch --list              # the runs it would do, as JSON
    qa batch my-batch --runner lsf --no-wait
    qa --label tuning --tuning '{"threshold": 0.5}' batch my-batch
    qa batch --commit main --label nightly my-batch   # QA-Board starts it, on a pushed commit

  Exits with 1 if a run failed. Batches: https://samsung.github.io/qaboard/docs/batches-running-on-multiple-inputs
  """
  from .runners import runners
  if on_commit is not None:
    if save_runs:
      raise click.UsageError("--save-runs can't be used with --commit: QA-Board starts the batch, the runs aren't known here.")
    from .on_server import start_on_server
    names, forwarded = split_batch_names(batch_names)
    given_action = ctx.get_parameter_source('action_on_existing') != click.core.ParameterSource.DEFAULT
    return start_on_server(ctx, on_commit, [*names, *batches], batches_files,
                           tuning_search=(tuning_search_dict, tuning_search_file),
                           action_on_existing=action_on_existing if given_action else None,
                           forwarded_args=forwarded if forwarded is not None else ctx.obj.get("forwarded_args", []))
  check_storage(ctx)
  if not batches_files and not runs_file:
    ui.warning("No batches are defined: qa batch doesn't know your inputs.",
               hint=["Add to qaboard.yaml:\ninputs:\n  batches: batches.yaml",
                     "How to write batches.yaml: https://samsung.github.io/qaboard/docs/batches-running-on-multiple-inputs"])
    return

  filtered_batch_names, forwarded = split_batch_names(batch_names)
  forwarded_args = forwarded if forwarded is not None else ctx.obj.get("forwarded_args", [])
  batches = list(filtered_batch_names) + list(batches)

  if runs_file and batches:
    raise click.UsageError("Use either batches or --runs-file, not both.")
  if not batches and not runs_file:
    ui.fail("Give the batch to run.", hint=f"`qa batch BATCH`, or several: `qa batch BATCH_1 BATCH_2`. Batches are defined in {', '.join(str(f) for f in batches_files)}.")
  # Those runs are saved in the commit's folder in the storage, even without --share
  if prefix_outputs_path and not prefix_outputs_path.is_absolute():
    if report_missing_storage('`qa batch --prefix-outputs-path` saves results there'):
      sys.exit(1)

  runs = load_runs_file(runs_file) if runs_file else None
  # How the runs were started. Some options are for the whole batch, e.g. the concurrency
  runs_job_options = next((run['job_options'] for run in runs or [] if run.get('job_options')), {})
  # Unless asked otherwise, runs are done again with the runner they were started with
  keeps_runs_runner = runs is not None and runner == default_runner
  if keeps_runs_runner and runs_job_options.get('type'):
    runner = runs_job_options['type']

  analytics.note(runner=runner, n_batches=len(batches) if batches else None)
  print_url(ctx)
  from .api import ResultsUnreadable
  from .runners import Job, JobGroup
  # if the commit does not exist or there are network errors it will return empty data
  try:
    existing_outputs = get_outputs(ctx.obj, ignore_errors=True)
  except ResultsUnreadable as e:
    # e.g. the server requires signing in: we can't tell which runs exist or are pending
    existing_outputs = {}
    print_auth_error(e.response, "QA-Board refused to read the batch's runs")
    if action_on_existing != 'run':
      ui.fail(f"--action-on-existing={action_on_existing} needs the batch's runs, else all the runs would be done again.")
    ui.warning("qa batch can't see which runs are pending: it may start them again.")
  log = batch_log(ctx)
  command_id = os.environ.get('QA_BATCH_COMMAND_ID', log['command_id'] if log else str(uuid.uuid4())) # unique IDs for triggered runs makes it easier to wait/cancel them 
  from .notify import is_nested, inherit_root_command, notify_channel, print_notification
  nested, started_by_qaboard = is_nested(), 'QA_BATCH_COMMAND_ID' in os.environ
  # The runs of `qa batch` commands started by this one (e.g. pipeline steps) count as its runs:
  # QA-Board knows the batch ended when none of them are pending.
  root_command_id = os.environ.get('QA_BATCH_ROOT_COMMAND_ID') or command_id
  inherit_root_command(ctx, root_command_id)
  if 'QA_BATCH_COMMAND_ID' in os.environ:
    # some projects have run() trigger further "qa batch" commands, notably in "pipelines"
    # so if we keep it defined we'll end up with deadlocks as those batch wait for the current batch to end...
    del os.environ['QA_BATCH_COMMAND_ID']

  previous_qa_batch = os.environ.get('QA_BATCH') # set when this batch was started by another
  previous_batches_files = os.environ.get('QA_BATCHES_FILES')
  def restore_batch_environment():
    for name, previous in (('QA_BATCH', previous_qa_batch), ('QA_BATCHES_FILES', previous_batches_files)):
      if previous is None:
        os.environ.pop(name, None)
      else:
        os.environ[name] = previous
  # also on the early returns (--list...), sys.exit and errors: commands run after this one in the same process
  # (tests, `qa` called from Python) aren't taken for runs of a batch
  ctx.call_on_close(restore_batch_environment)
  os.environ['QA_BATCH']= 'true' # triggered runs will be less verbose than with just `qa run`
  os.environ['QA_BATCHES_FILES'] = json.dumps([str(b) for b in batches_files])
  dryrun = ctx.obj['dryrun'] or list_output_dirs or list_inputs or list_contexts
  # The runs record the local changes as they were when the batch started: we capture them once
  previous_local_changes = share_local_changes() if not dryrun else None
  if dryrun:
    analytics.note(dryrun=True)
  should_notify_qa_database = (is_ci or ctx.obj['share']) and not (dryrun or ctx.obj['offline'])
  # An email when the runs end, unless QA_NOTIFY=none
  notify = notify_channel(is_ci, nested, started_by_qaboard) if not dryrun else None
  if notify and not should_notify_qa_database and os.environ.get('QA_NOTIFY'):
    ui.warning("QA_NOTIFY: QA-Board can only email you about runs it knows: these stay here (--offline, or no server).")
  notification = None
  if should_notify_qa_database:
    command_data = {
      "command_created_at_datetime":  datetime.datetime.utcnow().isoformat(),
      "argv": sys.argv,
      "runner": runner,
      **ctx.obj,
    }
    if log:
      command_data['log'] = log['path'] # relative to the batch directory
    if tuning_search_dict or tuning_search_file:
      command_data['tuning_search'], _ = load_tuning_search(tuning_search_dict, tuning_search_file)
    if runs is None:
      # The batches as they are now, filtered to what runs: to see and run them again after the files change
      from .batch_snapshot import command_snapshot
      from .conventions import location_from_spec
      snapshot = command_snapshot(
        batches,
        [(str(f), location_from_spec(f, {"project": project, "subproject": subproject})) for f in batches_files],
        allow_duplicate_batches=bool((config.get('inputs') or {}).get('allow_duplicate_batches')),
        argv=sys.argv,
        when=command_data["command_created_at_datetime"] + 'Z',
      )
      if snapshot:
        command_data['batches_snapshot'] = snapshot
    if runner == 'dask':
      # so that the backend can stop the batch
      scheduler_address = runs_job_options.get('scheduler_address', dask_config.get('scheduler_address'))
      if scheduler_address:
        command_data['scheduler_address'] = scheduler_address
      dask_cluster = runs_job_options.get('cluster', dask_config.get('cluster')) or {}
      command_data['cluster_type'] = dask_cluster.get('type', 'lsf')
      if command_data['cluster_type'] == 'kubernetes':
        from .runners.dask_runner import kubernetes_namespace
        kubernetes_config = runs_job_options.get('kubernetes', (config.get('runners') or {}).get('kubernetes')) or {}
        command_data['kubernetes'] = {
          # Resolved: the server doesn't have our kubeconfig's default namespace
          "namespace": kubernetes_namespace(dask_cluster.get('namespace') or kubernetes_config.get('namespace'), kubernetes_config.get('context')),
          "context": kubernetes_config.get('context'),
        }
    if runner == 'kubernetes':
      # so that the backend can stop the batch: it deletes its Jobs there
      from .runners.kubernetes import batch_target
      command_data.update(batch_target({**((config.get('runners') or {}).get('kubernetes') or {}), **runs_job_options}))
    job_url = getenvs(('BUILD_URL', 'CI_JOB_URL', 'CIRCLE_BUILD_URL', 'TRAVIS_BUILD_WEB_URL')) # jenkins, gitlabCI, circleCI, travisCI
    if job_url:
      command_data['job_url'] = job_url
    if notify:
      command_data['notify'] = {"channel": notify, "batches": list(batches)}
    if not os.environ.get('QA_BATCH_COMMAND_HIDE_LOGS'):
      response = notify_qa_database(object_type='batch', command={command_id: command_data}, **ctx.obj)
      notification = response.get('notification') if isinstance(response, dict) else None
      # in CI, results QA-Board refuses are lost: don't compute them
      exit_if_results_refused()


  tuning_search, filetype = load_tuning_search(tuning_search_dict, tuning_search_file)
  if tuning_search_dict or tuning_search_file:
    analytics.note(tuning=True)
  
  # Separate base configuration from CLI overrides
  base_runner_options = {
    "command_id": command_id,
    "type": default_runner,
  }
  cli_runner_overrides = {
    "type": runner,  # CLI --runner flag should have highest priority
  }
  
  # Collect CLI overrides (only non-None values that were explicitly provided)
  def given(name, value, default):
    """Whether an option was given, on the command line or as QA_BATCH_<OPTION>, even with its default value."""
    from click.core import ParameterSource
    return ctx.get_parameter_source(name) not in (ParameterSource.DEFAULT, ParameterSource.DEFAULT_MAP)
  # Each runner should add what it cares about...
  # TODO: Having --runner-X prefixes makes it all a mess, but still the help text is useful
  # TODO: It would be nice to generate the CLI help depending on the runner that's chosen, then we could use
  if runner == 'lsf':
    if given('lsf_queue', lsf_queue, default_lsf_queue):
      cli_runner_overrides["queue"] = lsf_queue
    else:
      base_runner_options["queue"] = lsf_queue
    if given('lsf_priority', lsf_priority, default_lsf_priority):
      cli_runner_overrides['priority'] = lsf_priority
    else:
      base_runner_options['priority'] = lsf_priority
    if given('lsf_max_threads', lsf_max_threads, default_lsf_max_threads):
      cli_runner_overrides["max_threads"] = lsf_max_threads
    else:
      base_runner_options["max_threads"] = lsf_max_threads
    if given('lsf_max_memory', lsf_max_memory, default_lsf_max_memory):
      cli_runner_overrides["max_memory"] = lsf_max_memory
    else:
      base_runner_options["max_memory"] = lsf_max_memory
    if given('lsf_resources', lsf_resources, default_lsf_resources):
      cli_runner_overrides['resources'] = lsf_resources
    else:
      base_runner_options['resources'] = lsf_resources
    if given('lsf_options', lsf_options, default_lsf_options):
      cli_runner_overrides['options'] = lsf_options
    else:
      base_runner_options['options'] = lsf_options
    if given('lsf_concurrency', lsf_concurrency, default_lsf_concurrency):
      cli_runner_overrides['concurrency'] = lsf_concurrency
    else:
      base_runner_options['concurrency'] = lsf_concurrency
    if 'concurrency_strategy' in lsf_config:
      base_runner_options['concurrency_strategy'] = lsf_config['concurrency_strategy']
    # Job arrays keep some bookkeeping there
    base_runner_options['batch_dir'] = str(ctx.obj['batch_dir'])

    # These are always set for LSF
    cli_runner_overrides.update({
      "project": lsf_config.get('project', str(project) if project else "qaboard"),
      "user": ctx.obj['user'],
    })
    
  if runner == "local":
    if given('local_concurrency', local_concurrency, default_local_concurrency):
      cli_runner_overrides["concurrency"] = local_concurrency
    else:
      base_runner_options['concurrency'] = local_concurrency
    if given('local_timeout', local_timeout, default_local_timeout):
      cli_runner_overrides["timeout"] = local_timeout
    else:
      base_runner_options['timeout'] = local_timeout

  if runner == 'dask':
    # scheduler_address, cluster (its type and kwargs for its class, e.g. dask_jobqueue.LSFCluster)...
    base_runner_options.update(dask_config)
    # By default dask workers are LSF jobs, sent with the same queue/project... as the LSF runner
    base_runner_options['lsf'] = {
      "project": lsf_config.get('project', str(project) if project else "qaboard"),
      **{k: v for k, v in lsf_config.items() if k in ('queue', 'project', 'resources', 'max_memory', 'options')},
    }
    # On Kubernetes, the workers' pods (and the --no-wait driver) are like the kubernetes runner's
    if (dask_config.get('cluster') or {}).get('type') == 'kubernetes':
      from .runners.dask_runner import kubernetes_defaults
      # The project labels the DaskCluster and driver Job: the server stops the batch by command id and project
      base_runner_options['kubernetes'] = {**kubernetes_defaults(config), **({"project": project.as_posix()} if project else {}), "commit": commit_id}
    # We save logs there
    base_runner_options['batch_dir'] = str(ctx.obj['batch_dir'])
    if given('dask_concurrency', dask_concurrency, default_dask_concurrency):
      cli_runner_overrides["concurrency"] = dask_concurrency

  if runner == 'kubernetes':
    # namespace, image, mounts, run_as... (see qaboard/runners/kubernetes.py)
    base_runner_options.update((config.get('runners') or {}).get('kubernetes') or {})
    base_runner_options['batch_dir'] = str(ctx.obj['batch_dir'])
    # Labels on the Jobs, e.g. for quotas and dashboards per user or project
    cli_runner_overrides.update({
      "user": ctx.obj['user'],
      "project": project.as_posix() if project else None,
      # {commit} in the image, and where the repository is: `workdir` in images with the code
      "commit": commit_id,
      "repo_root": str(repo_root),
    })

  if runner == 'local' or runner == 'celery':
    cli_runner_overrides["cwd"] = ctx.obj['previous_cwd'] if 'previous_cwd' in ctx.obj else os.getcwd()

  # For backward compatibility, combine for JobGroup
  default_runner_options = {**base_runner_options, **cli_runner_overrides}

  if runs is None:
    jobs = JobGroup(job_options=default_runner_options)
    inputs_iter = iter_inputs(batches, batches_files, ctx.obj['database'], ctx.obj['configurations'], ctx.obj['platform'], base_runner_options, config, ctx.obj['inputs_settings'], cli_runner_overrides=cli_runner_overrides)
  else:
    # The runs keep the job options they were started with, except those we were explicitly given
    explicit_runner_overrides = {k: v for k, v in cli_runner_overrides.items() if k not in (*local_job_options, 'type', 'project')}
    if not keeps_runs_runner:
      explicit_runner_overrides['type'] = runner
    inputs_iter = iter_runs(runs, default_input_type, ctx.obj['platform'], default_runner_options, explicit_runner_overrides)
    # They start together, with the options of the first run, e.g. its concurrency
    jobs = JobGroup(job_options=rerun_job_options(runs_job_options, default_runner_options, explicit_runner_overrides), split_by_job_options=False)

  total_runs = 0
  # What --list and --save-runs print, in order: the jobs we start, and the runs we skip (as --list prints them)
  listed: list = []
  for run_context in inputs_iter:
    input_configuration_str = serialize_config(run_context.configurations)
    extra_parameters, input_forwarded_args = ctx.obj['extra_parameters'], forwarded_args
    if runs is not None:
      # Each run from --runs-file has its own tuning parameters and forwarded arguments
      extra_parameters = {**ctx.obj['extra_parameters'], **run_context.extra_parameters}
      input_forwarded_args = [*forwarded_args, *extra_parameters.pop('forwarded_args', [])]
    for tuning_params, tuning_str, tuning_hash in iter_parameters(tuning_search, filetype=filetype, extra_parameters=extra_parameters):
      if not prefix_outputs_path:
          batch_conf_dir = make_batch_conf_dir(
            outputs_commit,
            ctx.obj["batch_label"],
            run_context.platform,
            run_context.configurations,
            tuning_params,
            ctx.obj['share']
          )
          # print("batch_conf_dir", batch_conf_dir)
      else:
          # FIXME: not 100% correct if there is tuning.. but who uses this flag anyway?
          #        worse case batch and outputs will be in slightly different folders... 
          batch_conf_dir = outputs_commit / prefix_outputs_path
          if tuning_params:
              batch_conf_dir = batch_conf_dir / tuning_hash
      from qaboard.conventions import output_dirs_for_input_part
      # print("batch_conf_dir", batch_conf_dir)
      run_context.output_dir = batch_conf_dir / output_dirs_for_input_part(run_context.rel_input_path, run_context.database, config)
      if not prefix_outputs_path:
        # a run that was done again is in its latest attempt's directory
        run_context.output_dir = attempts.latest_dir(run_context.output_dir)
      if input_forwarded_args:
        run_forwarded_args = [a for a in input_forwarded_args if not a in ("--keep-previous", "--no-postprocess", "--save-manifests-in-database")]
        if run_forwarded_args:
          run_context.extra_parameters = {"forwarded_args": run_forwarded_args, **tuning_params}
        else:
          run_context.extra_parameters = tuning_params
      else:
        run_context.extra_parameters = tuning_params

      if list_inputs:
        print(run_context.input_path)
        break

      # In the past we could assume a given run had a unique output dir,
      # so we could identify platform+input+config+tuning tuples describing runs by their output dir
      # But now the directory can depend on the username...
      # In most cases we don't care: worse case re-running will lead to some orphan output dirs on disk and wasted compute
      # But when trying to get results from older `qa batch`, we care...
      # We could remove the feature flag, maybe when it's used a bit more and we check there is no noticeable runtime cost..
      # runs that send their files to the server aren't in the folder it says: we match what they ran on
      if not 'QA_BATCH_COMPLEX_MATCHING' in os.environ and not uploads_files:
        matching_existing_outputs = [o for o in existing_outputs.values() if url_to_dir(o['output_dir_url']) == run_context.output_dir]
        matching_existing_output = matching_existing_outputs[0] if matching_existing_outputs else None
      else:
        from .api import matching_output
        matching_existing_output = matching_output(run_context, list(existing_outputs.values()))
      if action_on_existing=='assert-exists':
        if not matching_existing_output:
          ui.fail(f"--action-on-existing=assert-exists: QA-Board has no run of {run_context.rel_input_path} {run_context.configurations or ''} in this batch.",
                  hint="Run the batch first, or use another --action-on-existing (run, skip...).")
        run_context.output_dir = RunContext.from_api_output(matching_existing_output).output_dir

      if list_output_dirs:
        print(run_context.output_dir)
        break

      is_pending = matching_existing_output['is_pending'] if matching_existing_output else False
      is_failed = matching_existing_output['is_failed'] if matching_existing_output else run_context.is_failed()
      ran_before = True if matching_existing_output else run_context.ran()
      should_run = not is_pending and (action_on_existing=='run' or is_failed or not ran_before)
      # With assert-exists, like skip, we don't do anything with the runs that succeeded
      if (not should_run and action_on_existing in ('skip', 'assert-exists') and not is_pending) or (is_pending and action_on_pending == 'skip'):
        listed.append({**serialize_paths(run_context.asdict()), "skipped": True})
        continue

      if not input_forwarded_args:
        forwarded_args_cli = None
      else:
        if not on_windows:
          forwarded_args_cli = ' '.join(quote(a) for a in input_forwarded_args)
        else:
          from .compat import escaped_for_cli
          forwarded_args_cli = ' '.join(escaped_for_cli(a) for a in input_forwarded_args)

      if input_configuration_str == get_default_configuration(ctx.obj['inputs_settings']):
        configuration_cli = None
      else:
        # We can't use --config, or "-c A -c B" until we ensure all clients updated a version supporting it
        if not on_windows:
          configuration = quote(input_configuration_str) # support single-quotes
          configuration_cli =  f"--configuration {configuration}"
        else:
          from .compat import escaped_for_cli
          configuration_cli =  f'--configuration {escaped_for_cli(input_configuration_str)}'

      if not tuning_params:
        tuning_cli = None
      else:
        if not on_windows:
          tuning_str = quote(tuning_str)
          tuning_cli =  f"--tuning {tuning_str}"
        else:
          from .compat import escaped_for_cli
          tuning_cli =  f'--tuning {escaped_for_cli(tuning_str)}'


      # The runs we start get a directory of their own when they were done before (qaboard/attempts.py). We reserve
      # it, to tell QA-Board and the runners where the run will be: the job's `qa run` then reserves the same one.
      # Not for pending runs: we may only wait for them, and if they have to run, their `qa run` reserves it.
      starts_run = should_run or action_on_existing in ('skip', 'assert-exists')
      keeps_previous = 'QABOARD_RUN_KEEP' in os.environ or '--keep-previous' in (input_forwarded_args or [])
      if starts_run and not is_pending and not keeps_previous and saves_attempts(ctx.obj, custom_output=prefix_outputs_path):
        # dry runs (--list...) say where the run would be, without reserving it
        first_dir = attempts.split(run_context.output_dir)[0]
        run_context.output_dir = attempts.next_dir(first_dir) if dryrun else attempts.reserve_or_keep(run_context.output_dir)

      platform_cli =None
      Runner = runners[run_context.job_options['type']]
      if getattr(Runner, "platform", default_platform) != default_platform:
        run_context.platform = getattr(Runner, "platform")
      if run_context.platform != default_platform:
        platform_cli = f'--platform "{run_context.platform}"'
      # We could serialize properly the run_context/runner_options, and e.g. call "qa --pickled-cli" and use the CLI command below just for logs... 
      args = [
          f"qa",
          # runs share like their batch: those of a batch that can't share stay local too (config.default_share)
          '--offline' if ctx.obj['offline'] or not ctx.obj['share'] else None,
          f'--label "{ctx.obj["raw_batch_label"]}"' if ctx.obj["raw_batch_label"] != default_batch_label else None,
          platform_cli,
          f'--type "{run_context.type}"' if run_context.type != default_input_type else None,
          f'--database "{run_context.database.as_posix()}"' if run_context.database != get_default_database(ctx.obj['inputs_settings']) else None,
          configuration_cli,
          tuning_cli,
          # there is no `qa skip` or `qa assert-exists`: here those runs are pending (see --action-on-pending)
          'run' if should_run or action_on_existing in ('skip', 'assert-exists') else action_on_existing,
          f'--input "{run_context.rel_input_path}"',
          f'--output "{run_context.output_dir}"' if prefix_outputs_path else None,
          # we can't use "--" here directly since we want to allow "qa batch mybatch --some-flag-for-qa-run-like --save-manifests-in-database"
          # we would need to be a little bit accurate in how we handle this...
          forwarded_args_cli if forwarded_args_cli else None,
      ]
      command = ' '.join([arg for arg in args if arg is not None])
      if "QA_BATCH_QUIET" not in os.environ:
        click.secho(command, fg='cyan', err=True)
        click.secho(f"   {run_context.output_dir if run_context.output_dir.is_absolute else run_context.output_dir.relative_to(subproject)}", fg='blue', err=True)
      if 'QA_TESTING' in os.environ:
        # we want to make sure we test the current code
        command = re.sub('^qa', 'python -m qaboard', command) 
      if str(subproject) != '.':
        command = f"cd {subproject} && {command}"

      run_context.command = command
      run_context.job_options['command_id'] = command_id
      job = Job(run_context)

      if should_notify_qa_database and not is_pending:
        total_runs += 1
        if total_runs > 1_000 and not os.environ.get("QA_BATCH_ALLOW_MANY_RUNS"):
          raise ValueError("Sorry you are sending too many runs at once. Consider using --offline or get an approval.")
          sys.exit(1)
        # TODO: accumulate and send all at once to avoid 100s of requests?
        db_output = notify_qa_database(**{
          **ctx.obj,
          **run_context.obj, # for now we don't want to worry about backward compatibility, and input_path being abs vs relative...
          "is_pending": True,
          "data": {
            "job_options": run_context.job_options,
            "root_command_id": root_command_id,
          }
        })
        if db_output: # Note: the ID is already in the matching job above
          job.id = db_output["id"]
      if is_pending:
        wait_command = f"qa wait --output-id {matching_existing_output['id']}"
        # we find the run's results by its id: if it has to run again, it will be in another directory
        job.id = matching_existing_output['id']
        if action_on_pending=="sync":
          job.run_context.command = wait_command
        elif action_on_pending=="wait":
          job.run_context.command = f"{wait_command} || {job.run_context.command}"
          if action_on_existing in ("skip", "assert-exists"):
            job.run_context.command = wait_command
        else:
          assert action_on_pending=="run"
      jobs.append(job)
      listed.append(job)

  if list_contexts:
    print(json.dumps(listed_runs(listed), indent=2))
    if save_runs:
      write_runs(save_runs, listed, ctx)
    return

  if not dryrun:
    exit_if_results_refused()
    if total_runs:
      print_notification(notification)
    is_failed = jobs.start(
      blocking=not no_wait,
      qa_context=ctx.obj,
    )
    if not no_wait:
      print_batch_summary(jobs)
    if save_runs:
      write_runs(save_runs, listed, ctx)

    # A commit status on GitLab/GitHub links to the results
    from .git_hosts import git_host, update_ci_status
    host = git_host() if jobs and is_ci and 'QABOARD_TUNING' not in os.environ else None
    if host and host.token:
      name = f"QA {subproject.name}" if subproject else 'QA'
      from .api import qaboard_url
      target_url = f"{qaboard_url}/{config['project']['name']}/commit/{commit_id}"
      label = ctx.obj["batch_label"]
      if label != "default":
        name += f" | {label}"
        target_url += f"?batch={label}"
      update_ci_status(
        state='failed' if is_failed else 'success',
        name=name,
        target_url=target_url,
        description=f"{len(jobs)} results",
      )

    exit_if_results_refused()
    restore_local_changes(previous_local_changes)
    # restore verbosity: print_url is quiet in runs started by `qa batch`, but this one ends (unless it's nested)
    restore_batch_environment()
    if is_failed and not no_wait:
      if should_notify_qa_database:
        print_url(ctx, status="failure")
      sys.exit(1)
    elif should_notify_qa_database:
      print_url(ctx)


@qa.command()
@click.option('--file', '-f', 'files', multiple=True, help="Save specific files instead of artifacts indicated by yaml file. Supports python-glob-style wildcards - if calling from a shell wrap with single quotes.")
@click.option('--exclude', 'excluded_groups', multiple=True, help="Exclude specific artifact groups")
# Do we use this? yes in the API, but let's deprecate and remove for other uses...
@click.option('--out', '-o', 'artifacts_path', default='', help="Path to save artifacts in case of specified files")
@click.argument('groups', nargs=-1, type=click.UNPROCESSED, default=None)
@click.pass_context
def save_artifacts(ctx, files, excluded_groups, artifacts_path, groups):
  """
  Saves what runs QA-Board starts itself (tuning, runs done again) need: qaboard.yaml, the batch files, and the
  `artifacts` of qaboard.yaml, e.g. binaries. In the commit's folder of the storage, or, without a storage shared with
  the server (`storage: upload`), on the server.
  """
  import filecmp
  from .config import is_in_git_repo, qatools_config_paths
  from .utils import copy, file_info

  # Without a storage shared with the server, they are sent to it, unless --out says where (the server restoring them)
  sends = uploads_files and not artifacts_path
  click.secho("Sending the artifacts to QA-Board" if sends else f"Saving artifacts in: {artifacts_commit if not artifacts_path else artifacts_path}", bold=True, underline=True)

  artifacts = {}

  if files:
    artifacts = {f"__{f}": {"glob": f} for f in files}
  else:
    if 'artifacts' not in config:
      config['artifacts'] = {}
    # We support both qaboard.yaml and qaboard.yaml for backward compatibility with SIRC's projects
    # Default artifacts
    config['artifacts']['__qaboard.yaml'] = {"glob": ['qaboard.yaml', 'qatools.yaml']}
    config['artifacts']['__qatools'] = {"glob": ['qatools/*', 'qa/*']}
    # Handle sub-projects
    # Without its qaboard.yaml, runs started from a subproject's artifacts would use the parent project's config
    config['artifacts']['__sub-qaboard.yaml'] = {"glob": [str(p.relative_to(root_qatools).parent / name) for p in qatools_config_paths for name in ('qaboard.yaml', 'qatools.yaml')]}
    config['artifacts']['__metrics.yaml'] = {"glob": config.get('outputs', {}).get('metrics')}
    config['artifacts']['__batches.yaml'] = {"glob": [str(p) for p in default_batches_files]}
    config['artifacts']['__envrc'] = {"glob": ['.envrc', '*/.envrc']} # we don't use ** since it's so slow...
    if groups:
      if excluded_groups:
        groups = [g for g in groups if g not in excluded_groups]
      artifacts = {g: config['artifacts'][g] for g in groups if g in config['artifacts'].keys()}
    else:
      artifacts = config['artifacts']
  if 'QA_VERBOSE_VERBOSE' in os.environ: print(artifacts)
  if not is_in_git_repo:
      ui.fail(f"{Path().resolve()} is not in a git repository (maybe in an artifacts folder): qa save-artifacts saves the artifacts of git commits.",
              hint="Run it in your project's git repository, after the build.")

  if sends:
    send_artifacts(ctx, {name: artifact_globs(artifact_config) for name, artifact_config in artifacts.items()})
    return

  for artifact_name, artifact_config in artifacts.items():
    click.secho(f'Saving artifacts: {artifact_name}', bold=True)
    # without a storage, the commit's folder is --out's
    manifests_dir = (artifacts_commit_root / artifacts_path / subproject) if uploads_files else artifacts_commit
    manifest_path = manifests_dir / 'manifests' / f'{artifact_name}.json'
    try:
      manifest_path.parent.mkdir(parents=True, exist_ok=True)
    except Exception as e:
      from .site_config import site_config
      ui.fail(f"Could not create {manifest_path.parent}, to save the artifacts: {e}",
              hint=["The disk may be full, or your quota reached.", site_config('QABOARD_STORAGE_HELP')])
    if manifest_path.exists():
      with manifest_path.open() as f:
        try:
          manifest = json.load(f)
        except Exception: 
          manifest = {}
    else:
      manifest = {} 

    nb_files = 0
    for path in artifact_paths(artifact_globs(artifact_config)):
        if artifacts_path:
          destination = artifacts_commit_root / artifacts_path / path
        else:
          destination = artifacts_commit_root / path
        if 'QA_VERBOSE_VERBOSE' in os.environ:
          print(destination)
        if destination.exists() and filecmp.cmp(str(path), str(destination), shallow=True):
          # when working on subprojects, the artifact might be copied already,
          # but manifests are saved per-subproject
          if path.as_posix() not in manifest:
            manifest[path.as_posix()] = file_info(path, config=config)
          continue
        if 'QA_VERBOSE' in os.environ or ctx.obj['dryrun']:
          click.secho(str(path), dim=True)
        if not ctx.obj['dryrun']:
          copy(path, destination)
          manifest[path.as_posix()] = file_info(path, config=config)
        nb_files += 1

    if not ctx.obj['dryrun']:
      with manifest_path.open('w') as f:
        json.dump(manifest, f)
    if nb_files > 0:
      click.secho(f"{nb_files} files copied")

  if os.name == "nt" and not ctx.obj['dryrun']:
    from qaboard.compat import fix_linux_permissions
    fix_linux_permissions(artifacts_commit)

  # if the commit was deleted, this notification will mark it as good again 
  notify_qa_database(object_type='commit', **ctx.obj)
  exit_if_results_refused()


def artifact_globs(artifact_config) -> list[str]:
  """The patterns of an artifact group of qaboard.yaml, e.g. {glob: "build/*.so"}"""
  globs = artifact_config.get('globs', artifact_config.get('glob', [])) if isinstance(artifact_config, dict) else []
  return [g for g in (globs if isinstance(globs, list) else [globs]) if g]


def artifact_paths(globs: list[str]) -> list[Path]:
  """The files that match the patterns, relative to the current folder: the repository's root, as `qa` sees it"""
  from .compat import cased_path
  paths: dict[Path, None] = {}  # in order, once
  for g in globs:
    for path in Path('.').glob(g):
      path = cased_path(path)
      if path.is_file():
        paths[path] = None
  return list(paths)


def send_artifacts(ctx, groups):
  """`qa save-artifacts` without a storage shared with the server: sends the commit's artifacts to it (qaboard/commit_artifacts.py)"""
  from .api import qaboard_url
  from .commit_artifacts import listing, send, ArtifactsError, ServerTooOld
  files = {name: (subproject / 'manifests' / f'{name}.json', [p.as_posix() for p in artifact_paths(globs)]) for name, globs in groups.items()}
  # the groups of qaboard.yaml (qa's own start with __): one that matches nothing is likely saved before the build
  for name, (_, paths) in files.items():
    if not paths and not name.startswith('__'):
      ui.warning(f"The artifacts `{name}` match no files ({', '.join(groups[name])}).", hint="Run `qa save-artifacts` after the build.")
  if ctx.obj['dryrun']:
    for path in sorted({path for _, paths in files.values() for path in paths}):
      click.secho(path, dim=True)
    return
  if not commit_id or not re.fullmatch(r'[0-9a-f]{40}', str(commit_id)):
    ui.fail(f"QA-Board keeps artifacts for git commits, not for {commit_id}.", hint="Run `qa save-artifacts` in a git repository.")
  try:
    known = listing(qaboard_url, project.as_posix(), str(commit_id))
  except ServerTooOld as e:
    # so that CI jobs keep working with the servers that didn't take artifacts
    ui.warning(f"{e} The artifacts were not sent: runs can't be started from QA-Board.")
    return
  except ArtifactsError as e:
    ui.fail(f"{e} The artifacts were not sent.")
  # The server keeps artifacts for commits it knows: we send the commit first, also outside CI
  if notify_qa_database(object_type='commit', **{**ctx.obj, 'share': True}) is None:
    exit_if_results_refused()
    ui.fail("QA-Board didn't save the commit (see above): the artifacts were not sent.")
  try:
    sent = send(qaboard_url, project.as_posix(), str(commit_id), files, known)
  except ArtifactsError as e:
    ui.fail(str(e))
  plural = lambda n: f"{n} file{'s' if n != 1 else ''}"
  already = f", {plural(sent['skipped'])} already there" if sent['skipped'] else ""
  click.secho(f"Sent {plural(sent['sent'])} ({sent['bytes'] / 1024**2:.1f} MB){already}. Runs started from QA-Board use them: "
              f"{qaboard_url}/{project.as_posix()}/commit/{commit_id}", fg='green')
  # if the commit's artifacts were deleted, this marks them as good again
  notify_qa_database(object_type='commit', **{**ctx.obj, 'share': True})
  exit_if_results_refused()


from .commit_artifacts import fetch_artifacts
qa.add_command(fetch_artifacts)
from .batch_log import send_batch_log
qa.add_command(send_batch_log)


from .bit_accuracy import check_bit_accuracy, check_bit_accuracy_manifest
qa.add_command(check_bit_accuracy)
qa.add_command(check_bit_accuracy_manifest)


from .optimize import optimize
qa.add_command(optimize)


from .gate import gate
qa.add_command(gate)


from .auth import auth
qa.add_command(auth)
from .upload_command import upload
qa.add_command(upload)
from .restore import restore
qa.add_command(restore)


@qa.command(name='runs')
@click.argument('url', required=False)
@click.option('--project', help="The project, when not giving a URL, e.g. group/repo")
@click.option('--commit', help="A commit id, branch or tag. Default: the latest commit with results, or what the URL says.")
@click.option('--batch', help="The batch of runs. Default: what the URL says, or 'default'.")
@click.option('--filter', 'filter_', help="Keep the runs matching a filter, like the web app's filter box.")
@click.option('--side', type=click.Choice(['new', 'reference']), default='new', show_default=True, help="Which runs of the URL: the compared ones (new), or those of the reference bar (?reference=&batch_ref=).")
@click.option('--server', help="The QA-Board server, when the URL doesn't say (e.g. served under a path prefix).")
@click.option('--json', 'as_json', is_flag=True, help="Print the runs as JSON: input, configs, params, metrics, output_dir...")
@click.option('--include-deleted', is_flag=True, help="Also list runs whose files were deleted.")
@click.option('--include-hidden', is_flag=True, help="Also list runs the web app doesn't show with the batch, like qa optimize's iterations.")
def runs_command(url, project, commit, batch, filter_, side, server, as_json, include_deleted, include_hidden):
  """
  Lists the runs a web app page shows, from its URL: their folders, one per line, or everything with --json.

      qa runs "https://qaboard/my/project/commit/abc123?batch=ci&filter=night"

  It doesn't run anything, and works outside a project (give `runs` first: `qa runs ...`).
  From Python: `qaboard.runs(url)`.
  """
  from .results import runs, ResultsError
  if not url and not project:
    raise click.UsageError("Give the address of a commit's page in the web app, or --project (and --commit, --batch).")
  try:
    found = runs(url, project=project, commit=commit, batch=batch, filter=filter_, side=side, server=server,
                 include_deleted=include_deleted, include_hidden=include_hidden)
  except (ResultsError, ValueError) as e:
    from .credentials import fix_for
    refused = e.body if isinstance(getattr(e, 'body', None), dict) and e.body.get('reason') else None  # type: ignore[union-attr]
    unreachable = isinstance(e, ResultsError) and e.status is None
    ui.fail(str(e), hint=fix_for(refused, ci=is_ci) if refused else "Check the URL, or --server and QABOARD_URL. `qa doctor` checks the connection." if unreachable else None)
  if as_json:
    print(json.dumps([r.to_dict() for r in found], indent=2))
  else:
    if not found:
      ui.warning(f"No run matches ({found.side.project}, commit {found.commit or found.side.commit or found.side.branch}, batch {found.side.batch!r}, filter {found.side.filter!r}).")
    if found and ui.rich_output(sys.stdout):
      # on terminals, a table. Piped, the folders, one per line, for scripts
      ui.print_table(['input', 'configurations', 'status', 'folder'], [
        [run.input, serialize_config(list(run.configs)) or '-', 'running' if run.is_running else 'pending' if run.is_pending else 'failed' if run.is_failed else 'ok',
         str(run.output_dir) if run.output_dir else '(no folder)']
        for run in found
      ], styles=['red' if run.is_failed and not run.is_pending else None for run in found])
      return
    for run in found:
      if run.output_dir:
        print(run.output_dir)
      else:
        ui.warning(f"No folder for {run}")


@qa.command()
@click.pass_context
def init(ctx):
  """
  Start a project: write a sample qaboard.yaml, an entrypoint and batches.

  \b
  Examples:
    qa init
    qa --dryrun init      # show what it would write
  """
  from .init import qa_init
  qa_init(ctx)


@qa.command()
@click.option('--runner', default=default_runner, show_default=True, shell_complete=complete_runners, help="The runner to check: local, lsf, celery, dask, windows... By default, the one `qa batch` uses.")
@click.option('--test-job', is_flag=True, help="Also start a small job with the runner, to check that it runs, where, as who, and what it can access. It can take a few minutes, e.g. waiting for a slot.")
@click.option('--json', 'as_json', is_flag=True, help="Print the checks as JSON on stdout (ok, exit_code, errors, warnings, next_step, checks: section, name, status, message, fix); the report goes to stderr.")
@click.pass_context
def doctor(ctx, runner, test_job, as_json):
  """
  Check that you can run batches, and say how to fix what's wrong.

  \b
  It checks, and says what to do about each problem:
  - qa and qaboard.yaml: version, configuration, entrypoint, batches, git
  - the QA-Board server: reachable, signed in, your role in the project
  - the storage: the results' folder is writable and the server sees it, the inputs are there
  - the runner: e.g. for LSF that bsub works and the queue exists, for Celery that workers answer

  \b
  It checks what runs whose results show in QA-Board need, like `qa batch`.
  With `qa --offline doctor`, only what local runs need. Exits with 1 if something must be fixed.

  \b
  Examples:
    qa doctor
    qa doctor --runner lsf --test-job
  """
  from .doctor import run_doctor, Report
  if not as_json:
    sys.exit(run_doctor(ctx.obj, runner=runner, test_job=test_job))
  from .json_output import stdout_to_stderr, print_json
  def echo(message=''):
    click.echo(message, err=True)
  report = Report(echo=echo)
  with stdout_to_stderr():
    exit_code = run_doctor(ctx.obj, runner=runner, test_job=test_job, echo=echo, report=report)
  print_json({"runner": runner, "offline": bool(ctx.obj.get('offline')), **report.as_json()})
  sys.exit(exit_code)



@qa.group(name='completion')
def completion_command():
  """
  Shell completion: complete qa's commands, options, batch names, --input paths, --platform...

  \b
  Completion reads qaboard.yaml and the batches files, never QA-Board: it works offline.
  It needs the shell to find `qa` (in your PATH).

  \b
  Examples:
    qa completion install          # for your shell ($SHELL), then open a new shell
    qa completion install zsh
    qa completion bash > ~/.qa-completion.bash   # the script, to load it yourself
  """


def shell_argument(command):
  return click.argument('shell', required=False, type=click.Choice(completion.SHELLS))(command)


@completion_command.command(name='install')
@shell_argument
@click.option('--json', 'as_json', is_flag=True, help="Print what was installed as JSON: shell, script, startup_file, startup_file_changed.")
def completion_install(shell, as_json):
  """
  Install completion for your shell (bash, zsh, fish, powershell). Default: $SHELL's.

  \b
  It writes the script in qa's configuration folder (fish: ~/.config/fish/completions/qa.fish),
  and loads it from ~/.bashrc, ~/.zshrc or your PowerShell $PROFILE, once. Doing it again updates the script.
  """
  shell = shell or completion.detect_shell()
  if not shell:
    raise click.UsageError(f"Could not tell your shell from $SHELL: give it, one of {', '.join(completion.SHELLS)}")
  installed = completion.install(shell)
  if as_json:
    click.echo(json.dumps(installed, indent=2))
    return
  click.secho(f"Installed completion for {shell}: {installed['script']}", fg='green', err=True)
  if installed['startup_file_changed']:
    click.echo(f"Loaded from {installed['startup_file']}. Open a new shell to use it.", err=True)
  elif installed['startup_file']:
    click.echo(f"{installed['startup_file']} already loads it. Open a new shell to use the update.", err=True)
  else:
    click.echo("Open a new shell to use it.", err=True)


def _script_command(shell):
  def print_script():
    click.echo(completion.source(shell))
  print_script.__name__ = f"completion_{shell}"
  return completion_command.command(name=shell, help=f"Print the {shell} completion script, to load it yourself.")(print_script)

for _shell in completion.SHELLS:
  _script_command(_shell)


@qa.command(name='version')
@click.option('--json', 'as_json', is_flag=True, help="Print as JSON: qaboard, python, click, platform, executable, package.")
def version_command(as_json):
  """Print qa's version (also: qa --version)."""
  from . import __version__
  if not as_json:
    click.echo(f"qa, version {__version__}")
    return
  import platform
  from importlib.metadata import version
  click.echo(json.dumps({
    "qaboard": __version__,
    "python": platform.python_version(),
    "click": version('click'),
    "platform": sys.platform,
    "executable": sys.executable,
    "package": str(Path(__file__).resolve().parent),
  }, indent=2))


# We want to allow both
# 1. Late "--list" args like "qa batch my-batch --list", which requires allow_interspersed_args=True
# 2. "--" to specifcy args to be forwarded in "qa batch", which would require allow_interspersed_args=False
# So the only good way to solve it is to handle -- before click even runs...
def split_dashdash():
  if '--' in sys.argv:
      idx = sys.argv.index('--')
      pre = sys.argv[:idx]
      post = sys.argv[idx + 1:]
      sys.argv = pre  # Click will see only "before"
      return post
  return []

def init_sentry():
  """
  In CI, report errors to the Sentry project set by the site (QABOARD_SENTRY_DSN), if any.
  The CA bundle that signed the Sentry server's certificate can be set with SENTRY_CA_CERTS or QABOARD_SENTRY_VERIFY
  (a path, "system", or "false" to not check it), see qaboard/sentry_utils.py.
  """
  from .site_config import site_config
  dsn = site_config("QABOARD_SENTRY_DSN")
  if not os.environ.get("CI") or not dsn:
    return
  import sentry_sdk
  from . import __version__
  from .sentry_utils import sentry_options
  ca_setting = site_config("SENTRY_CA_CERTS") or site_config("QABOARD_SENTRY_VERIFY")
  sentry_sdk.init(**sentry_options(
    dsn,
    release=f"qaboard@{__version__}",
    environment="ci",
    traces_rate=1.0,
    # `qa` runs are short
    profile_session_rate=0,
    ca_setting=ca_setting,
  ))


def main():
  if completion.is_completing():
    # fast, quiet and offline: no update check, no Sentry, no usage event (the `qa` group's callback doesn't run)
    completion.register_shells()
    qa(obj={"forwarded_args": []}, auto_envvar_prefix='QA', complete_var=completion.COMPLETE_VAR)
    return
  # not on `import qaboard`: scripts using the package shouldn't wait for PyPI
  from .check_for_updates import check_for_updates
  check_for_updates()
  init_sentry()
  from .compat import ensure_cli_backward_compatibility
  ensure_cli_backward_compatibility()
  forwarded_args = split_dashdash()
  # click exits with SystemExit: we read the exit code for the usage event, then exit the same way
  exit_code = 0
  try:
    qa(
      obj={"forwarded_args": forwarded_args},
      auto_envvar_prefix='QA',
    )
  except SystemExit as e:
    exit_code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    raise
  except BaseException as e:
    exit_code = 1
    # a server we can't reach is not a bug of qa: what went wrong, without the traceback (with --verbose)
    if isinstance(e, Exception) and ui.is_connection_error(e) and not ui.verbose():
      from .api import qaboard_url
      ui.error(f"Could not reach QA-Board at {qaboard_url}: {ui.request_problem(e)}.",
               hint="Check that the server is up and that QABOARD_URL is right, or use `qa --offline`. `qa --verbose` shows the traceback.")
      raise SystemExit(1)
    raise
  finally:
    analytics.finish(exit_code)

if __name__ == '__main__':
  main()
