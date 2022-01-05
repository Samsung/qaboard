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
import yaml
import datetime
import traceback
from pathlib import Path

import click
from rich.traceback import install
install(show_locals=False, suppress=[click])

from .run import RunContext
from .runners import Job, JobGroup

from .conventions import make_batch_dir, make_batch_conf_dir
from .conventions import serialize_config, deserialize_config, get_settings
from .utils import PathType, entrypoint_module, load_tuning_search
from .utils import save_outputs_manifest, total_storage
from .utils import redirect_std_streams
from .utils import getenvs
from .api import url_to_dir, print_url
from .api import get_outputs, notify_qa_database, serialize_paths
from .iterators import iter_inputs, iter_parameters

from .config import config_has_error, ignore_config_errors
from .config import project, project_root, subproject, config
from .config import default_batches_files, get_default_database, default_batch_label, default_platform
from .config import get_default_configuration, default_input_type
from .config import commit_id, outputs_commit, artifacts_commit, root_qatools, artifacts_commit_root
from .config import user, is_ci, on_windows



@click.group()
@click.pass_context
@click.option('--platform', default=default_platform)
@click.option('--configuration', '--config', '-c', 'configurations', multiple=True, help="Will be passed to the run function")
@click.option('--label', '-l', default=default_batch_label, help="Gives tuning experiments a name.")
@click.option('--tuning', default=None, help="Extra parameters for tuning (JSON)")
@click.option('--tuning-filepath', type=PathType(), default=None, help="File with extra parameters for tuning")
@click.option('--dryrun', is_flag=True, help="Only show the commands that would be executed")
@click.option('--share', is_flag=True, help="Show outputs in QA-Board, doesn't just save them locally.")
@click.option('--database', type=PathType(), help="Input database location")
@click.option('--type', 'input_type', default=default_input_type, help="How we define inputs")
@click.option('--offline', is_flag=True, help="Do not notify QA-Board about run statuses.")
def qa(ctx, platform, configurations, label, tuning, tuning_filepath, dryrun, share, database, input_type, offline):
  """Entrypoint to running your algo, launching batchs..."""
  # We want all paths to be relative to top-most qaboard.yaml
  # it should be located at the root of the git repository
  if config_has_error and not ignore_config_errors:
    click.secho('Please fix the error(s) above in qaboard.yaml', fg='red', err=True, bold=True)
    exit(1)

  # Click passes `ctx.obj` to downstream commands, we can use it as a scratchpad
  # http://click.pocoo.org/6/complex/
  ctx.obj = {}

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
  # Note: to support multiple databases per project,
  # either use / as database, or somehow we need to hash the db in the output path. 
  ctx.obj['raw_batch_label'] = label
  ctx.obj['batch_label'] = label if (not share or is_ci) else f"@{user}| {label}"
  ctx.obj['platform'] = platform

  ctx.obj['input_type'] = input_type
  ctx.obj['inputs_settings'] = get_settings(input_type, config)
  ctx.obj['database'] = database if database else get_default_database(ctx.obj['inputs_settings'])
  # configuration singular is for backward compatibility to a time where there was a single str config
  ctx.obj['configuration'] = ':'.join(configurations) if configurations else get_default_configuration(ctx.obj['inputs_settings'])
  # we should refactor the str configuration away completely, and do a much simpler parsing, like
  #   deserialize_config = lambda configurations: return [maybe_json_loads(c) for c in configurations]
  ctx.obj['configurations'] = deserialize_config(ctx.obj['configuration'])
  ctx.obj['extra_parameters'] = {}
  if tuning:
    ctx.obj['extra_parameters'] = json.loads(tuning)
  elif tuning_filepath:
    ctx.obj['tuning_filepath'] = tuning_filepath
    with tuning_filepath.open('r') as f:
      if tuning_filepath.suffix == '.yaml':
        ctx.obj['extra_parameters'] = yaml.load(f, Loader=yaml.SafeLoader)
      elif tuning_filepath.suffix == '.cde':
        from cde import Config
        ctx.obj['extra_parameters'] = Config.loads(f.read()).asdict()
      else:
        ctx.obj['extra_parameters'] = json.load(f)
  # batch runs will override this since batches may have different configurations
  ctx.obj['batch_conf_dir'] = make_batch_conf_dir(outputs_commit, ctx.obj['batch_label'], platform, ctx.obj['configurations'], ctx.obj['extra_parameters'], share)
  ctx.obj['batch_dir'] = make_batch_dir(outputs_commit, ctx.obj['batch_label'], platform, ctx.obj['configurations'], ctx.obj['extra_parameters'], share)

  # For convenience, we allow users to change environment variables using {ENV: {VAR: value}}
  # in configurations or tuning parameters
  environment_variables = {}
  for c in ctx.obj['configurations']:
    if not isinstance(c, dict): continue
    if 'ENV' in c: environment_variables.update(c['ENV'])
  if 'ENV' in ctx.obj['extra_parameters']:
    environment_variables.update(ctx.obj['extra_parameters']['ENV'])
  os.environ.update(environment_variables)

  # we manage stripping ansi color codes ourselfs since we redirect std streams
  # to both the original stream and a log file
  ctx.color = True
  # colors in log files colors will be interpreted in the UIs
  ctx.obj['color'] = is_ci or share


@qa.command()
@click.option('-i', '--input', 'input_path', type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path.')
@click.argument('variable')
@click.pass_context
def get(ctx, input_path, output_path, variable):
  """Prints the value of the requested variable. Mostly useful for debug."""
  from .config import outputs_commit, commit_branch, commit_message, artifacts_branch, artifacts_branch_root
  # backward compatibility
  if variable == "branch_ci_dir":
    variable = "artifacts_branch_root"
  if variable == "commit_ci_dir":
    variable = "outputs_commit"
  locals().update(globals())
  locals().update(ctx.obj)
  try:
    run_context = RunContext.from_click_run_context(ctx, config)
    locals().update(run_context.asdict())
  except:
    pass

  if variable in locals():
    print(locals().get(variable))
  else:
    click.secho(f"Could not find {variable}", err=True, fg='red')
    exit(1)




@qa.command(context_settings=dict(
    ignore_unknown_options=True,
    allow_interspersed_args=False,
))
@click.pass_context
@click.option('-i', '--input', 'input_path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path.')
@click.option('--keep-previous', is_flag=True, help="Don't clean previous outputs before the run.")
@click.option('--no-postprocess', is_flag=True, help="Don't do the postprocessing.")
@click.option('--save-manifests-in-database', is_flag=True, help="Save the input and outputs manifests in the database.")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def run(ctx, input_path, output_path, keep_previous, no_postprocess, forwarded_args, save_manifests_in_database):
    """
    Runs over a given input/recording/test and computes various success metrics and outputs.
    """
    run_context = RunContext.from_click_run_context(ctx, config)

    if run_context.output_dir.exists():
      # Usually we want to remove any files already present in the output directory.
      # It avoids issues with remaining state... This said,
      # In some cases users want to debug long, multi-stepped runs, for which they have their own caching
      if not (keep_previous or 'QABOARD_RUN_KEEP' in os.environ):
        # TODO: check in the database the status of the run?
        import shutil
        shutil.rmtree(run_context.output_dir, ignore_errors=True)
    run_context.output_dir.mkdir(parents=True, exist_ok=True)

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
        from shlex import quote
        click.secho(' '.join(['qa', *map(quote, sys.argv[1:])]), fg='cyan', bold=True)
      click.echo(click.style("Outputs: ", fg='cyan') + click.style(str(run_context.output_dir), fg='cyan', bold=True), err=True)
      print_url(ctx)

      if not ctx.obj['offline']:
          notify_qa_database(**ctx.obj, is_pending=True, is_running=True)

      start = time.time()
      cwd = os.getcwd() 

      try:
        runtime_metrics = entrypoint_module(config).run(run_context)
      except Exception as e:
        exc_type, exc_value, exc_traceback = sys.exc_info()
        click.secho(f'[ERROR] Your `run` function raised an exception: {e}', fg='red', bold=True)
        try:
          exc_type, exc_value, exc_traceback = sys.exc_info()
          click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red')
        except Exception as e: # debug strange stale file errors, ideally remove this...
          print(f"ERROR: {e}")
        runtime_metrics = {'is_failed': True}

      if not runtime_metrics:
        runtime_metrics = {"is_failed": False}

      if not isinstance(runtime_metrics, dict):
        click.secho(f'[ERROR] Your `run` function did not return a dict, but {runtime_metrics}', fg='red', bold=True)
        runtime_metrics = {'is_failed': True}

      runtime_metrics['compute_time'] = time.time() - start

      # avoid issues if code in run() changes cwd
      if os.getcwd() != cwd:
        os.chdir(cwd)

      metrics = postprocess_(runtime_metrics, run_context, skip=no_postprocess or runtime_metrics['is_failed'], save_manifests_in_database=save_manifests_in_database)
      if not metrics:
        metrics = runtime_metrics

      if metrics['is_failed']:
        click.secho('[ERROR] The run has failed.', fg='red', err=True)
        click.secho(str(metrics), fg='red', bold=True)
        exit(1)
      else:
        click.secho(str(metrics), fg='green')


def postprocess_(runtime_metrics, run_context, skip=False, save_manifests_in_database=False):
  """Computes computes various success metrics and outputs."""
  from .utils import file_info
  from .compat import windows_to_linux_path

  try:
    if not skip:
      try:
        entrypoint_postprocess = entrypoint_module(config).postprocess
      except:
        metrics = runtime_metrics
      else: 
        metrics = entrypoint_postprocess(runtime_metrics, run_context)
    else:
      metrics = runtime_metrics 
  except:
    exc_type, exc_value, exc_traceback = sys.exc_info()
    # TODO: in case of import error because postprocess was not defined, just ignore it...?
    # TODO: we should provide a default postprocess function, that reads metrics.json and returns {**previous, **runtime_metrics}
    exc_type, exc_value, exc_traceback = sys.exc_info()
    click.secho(f'[ERROR] Your `postprocess` function raised an exception:', fg='red', bold=True)
    click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red')
    metrics = {**runtime_metrics, 'is_failed': True}

  if 'is_failed' not in metrics:
    click.secho("[Warning] The result of the `postprocess` function misses a key `is_failed` (bool)", fg='yellow')
    metrics['is_failed'] = False

  if (run_context.output_dir / 'metrics.json').exists():
    with (run_context.output_dir / 'metrics.json').open('r') as f:
      previous_metrics = json.load(f)
      metrics = {
        **previous_metrics,
        **metrics,
      }
  with (run_context.output_dir / 'metrics.json').open('w') as f:
      json.dump(metrics, f, sort_keys=True, indent=2, separators=(',', ': '))
  # To help identify if input files change, we compute and save some metadata.
  manifest_inputs = run_context.obj.get('manifest-inputs', [run_context.input_path])
  input_files = {}
  for manifest_input in manifest_inputs:
    manifest_input = Path(manifest_input)
    if manifest_input.is_dir():
      for idx, path in enumerate(manifest_input.rglob('*')):
        if idx >= 200:
          break
        if not path.is_file():
          continue
        input_files[windows_to_linux_path(path).as_posix()] = file_info(path, config=config)
    elif manifest_input.is_file():
      input_files.update({windows_to_linux_path(manifest_input).as_posix(): file_info(manifest_input, config=config)})
    try:
      with (run_context.output_dir / 'manifest.inputs.json').open('w') as f:
        json.dump(input_files, f, sort_keys=True, indent=2)
    except Exception as e:
      click.secho(f'WARNING: When writing the input manifest:', fg="yellow", bold=True, err=True)
      click.secho(str(e), fg="yellow", err=True)

  outputs_manifest = save_outputs_manifest(run_context.output_dir, config=config)
  output_data = {
    'storage': total_storage(outputs_manifest),
  }
  if 'params' in metrics:
    output_data['params'] = metrics['params']
    del metrics['params']


  if save_manifests_in_database:
    if run_context.input_path.is_file():
      click.secho('WARNING: saving the manifests in the database is only implemented for inputs that are *folders*.', fg='yellow', err=True)
    else:
      from .utils import copy
      copy(run_context.output_dir / 'manifest.inputs.json', run_context.input_path / 'manifest.inputs.json')
      copy(run_context.output_dir / 'manifest.outputs.json', run_context.input_path / 'manifest.outputs.json')

  if not run_context.obj.get('offline') and not run_context.obj.get('dryrun'):
    notify_qa_database(**run_context.obj, metrics=metrics, data=output_data, is_pending=False, is_running=False)

  if os.name == "nt" and not run_context.obj.get('dryrun') and (run_context.obj.get('share') or is_ci):
    from qaboard.compat import fix_linux_permissions
    fix_linux_permissions(run_context.output_dir)

  return metrics



@qa.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('-i', '--input', 'input_path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path.')
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def postprocess(ctx, input_path, output_path, forwarded_args):
  """Run only the post-processing, assuming results already exist."""
  run_context = RunContext.from_click_run_context(ctx, config)
  with redirect_std_streams(run_context.output_dir / 'log.txt', color=ctx.obj['color']):
    click.echo(click.style("Outputs: ", fg='cyan') + click.style(str(run_context.output_dir), fg='cyan', bold=True), err=True)
    print_url(ctx)
    metrics = postprocess_({}, run_context)
    if metrics['is_failed']:
      click.secho('[ERROR] The run has failed.', fg='red', err=True, bold=True)
      click.secho(str(metrics), fg='red')
    else:
      click.secho(str(metrics), fg='green')      



@qa.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('-i', '--input', 'input_path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path.')
def sync(ctx, input_path, output_path):
  """Updates the database metrics using metrics.json"""
  run_context = RunContext.from_click_run_context(ctx, config)
  if (run_context.output_dir / 'metrics.json').exists():
    with (run_context.output_dir / 'metrics.json').open('r') as f:
      metrics = json.load(f)
    notify_qa_database(**ctx.obj, metrics=metrics, is_pending=False, is_running=False)
    click.secho(str(metrics), fg='green')      


@qa.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('--output-id', 'output_id', help='Custom output directory path.')
def wait(ctx, output_id):
  from .api import get_output 
  while True:
    output = get_output(output_id)
    click.secho("...waiting")      
    if output["is_pending"]:
        time.sleep(5)
        continue
    break
    exit(0 if not output["is_failed"] else 1)


runners_config = config.get('runners', {})
if 'default' in runners_config:
  default_runner = runners_config['default']
else:
  task_runners = [r for r in runners_config if r not in ['default', 'local']]
  default_runner = task_runners[0] if task_runners else 'local'
lsf_config = config['lsf'] if 'lsf' in config else config.get('runners', {}).get('lsf', {}) 
if 'lsf' in config:
  default_runner = 'lsf'
if default_runner ==  'lsf' and os.name=='nt':
  default_runner = 'local'
local_config = config.get('runners', {}).get('local', {})
@qa.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.option('--batch', '-b', 'batches', multiple=True, help="We run over all inputs+configs+database in those batches")
@click.option('--batches-file', 'batches_files', type=PathType(),  default=default_batches_files, multiple=True, help="YAML files listing batches of inputs+configs+database.")
@click.option('--tuning-search', 'tuning_search_dict', help='string containing JSON describing the tuning parameters to explore')
@click.option('--tuning-search-file', type=PathType(), default=None, help='tuning file describing the tuning parameters to explore')
@click.option('--no-wait', is_flag=True, help="If true, returns as soon as the jobs are sent, otherwise waits for completion.")
@click.option('--list', 'list_contexts', is_flag=True, help="Print as JSON details about each run we would do.")
@click.option('--list-output-dirs', is_flag=True, help="Only print the prefixes for the results of each batch we run on.")
@click.option('--list-inputs', is_flag=True, help="Print to stdout a JSON with a list of the inputs we would call qa run on.")
@click.option('--runner', default=default_runner, help="Run runs locally or using a task queue like Celery, LSF...")
@click.option('--local-concurrency', default=os.environ.get('QA_BATCH_CONCURRENCY', local_config.get('concurrency')), type=int, help="joblib's n_jobs: 0=unlimited, 2=2 at a time, -1=#cpu-1")
@click.option('--lsf-threads', default=lsf_config.get('threads', 0), type=int, help="restrict number of lsf threads to use. 0=no restriction")
@click.option('--lsf-max-memory', default=lsf_config.get('max_memory', lsf_config.get('memory', 0)), help="restrict memory (MB) to use. 0=no restriction")
@click.option('--lsf-queue', default=lsf_config.get('queue'), help="LSF queue (-q)")
@click.option('--lsf-fast-queue', default=lsf_config.get('fast_queue', lsf_config.get('queue')), help="Fast LSF queue, for interactive jobs")
@click.option('--lsf-resources', default=lsf_config.get('resources', None), help="LSF resources restrictions (-R)")
@click.option('--lsf-priority', default=lsf_config.get('priority', 0), type=int, help="LSF priority (-sp)")
@click.option('--action-on-existing', default=config.get('outputs', {}).get('action_on_existing', "run"), help="When there are already finished successful runs, whether to do run / postprocess (only) / sync (re-read metrics from output dir) / skip / assert-exists")
@click.option('--action-on-pending', default=config.get('outputs', {}).get('action_on_pending', "wait"), help="When there are already pending runs, whether to do wait (then run) / sync (use those runs' results) / skip (don't run) / run (run as usual, can cause races)")
@click.option('--prefix-outputs-path', type=PathType(), default=None, help='Custom prefix for the outputs; they will be at $prefix/$output_path')
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
@click.pass_context
def batch(ctx, batches, batches_files, tuning_search_dict, tuning_search_file, no_wait, list_contexts, list_output_dirs, list_inputs, runner, local_concurrency, lsf_threads, lsf_max_memory, lsf_queue, lsf_fast_queue, lsf_resources, lsf_priority, action_on_existing, action_on_pending, prefix_outputs_path, forwarded_args):
  """Run on all the inputs/tests/recordings in a given batch using the LSF cluster."""
  if not batches_files:
    click.secho(f'WARNING: Could not find how to identify input tests.', fg='red', err=True, bold=True)
    click.secho(f'Consider adding to qaboard.yaml somelike like:\n```\ninputs:\n  batches: batches.yaml\n```', fg='red', err=True)
    click.secho(f'Where batches.yaml is formatted like in http://qa-docs/docs/batches-running-on-multiple-inputs', fg='red', err=True)
    return

  if not batches:
    if not len(forwarded_args):
        click.secho(f'ERROR: you must provide a batch', fg='red', err=True, bold=True)
        click.secho(f'Use either `qa batch BATCH`, or `qa batch --batch BATCH_2 --batch BATCH_2`', fg='red', err=True)
        exit(1)
    single_batch, *forwarded_args = forwarded_args
    batches = [single_batch]

  print_url(ctx)
  existing_outputs = get_outputs(ctx.obj)
  command_id = os.environ.get('QA_BATCH_COMMAND_ID', str(uuid.uuid4())) # unique IDs for triggered runs makes it easier to wait/cancel them 

  os.environ['QA_BATCH']= 'true' # triggered runs will be less verbose than with just `qa run` 
  os.environ['QA_BATCHES_FILES'] = json.dumps([str(b) for b in batches_files])
  dryrun = ctx.obj['dryrun'] or list_output_dirs or list_inputs or list_contexts
  should_notify_qa_database = (is_ci or ctx.obj['share']) and not (dryrun or ctx.obj['offline'])
  if should_notify_qa_database:
    command_data = {
      "command_created_at_datetime":  datetime.datetime.utcnow().isoformat(),
      "argv": sys.argv,
      "runner": runner,
      **ctx.obj,
    }
    job_url = getenvs(('BUILD_URL', 'CI_JOB_URL', 'CIRCLE_BUILD_URL', 'TRAVIS_BUILD_WEB_URL')) # jenkins, gitlabCI, circleCI, travisCI
    if job_url:
      command_data['job_url'] = job_url
    if not os.environ.get('QA_BATCH_COMMAND_HIDE_LOGS'):
      notify_qa_database(object_type='batch', command={command_id: command_data}, **ctx.obj)


  tuning_search, filetype = load_tuning_search(tuning_search_dict, tuning_search_file)
  default_runner_options = {
    "type": runner,
    "command_id": command_id,
  }
  # Each runner should add what it cares about...
  # TODO: Having --runner-X prefixes makes it all a mess, but still the help text is useful
  # TODO: It would be nice to generate the CLI help depending on the runner that's chosen, then we could use
  if runner == 'lsf':
    default_runner_options.update({
      "project": lsf_config.get('project', str(project) if project else "qaboard"),
      "max_threads": lsf_threads,
      "max_memory": lsf_max_memory,
      'resources': lsf_resources,
      "queue": lsf_queue,
      "fast_queue": lsf_fast_queue,
      "user": ctx.obj['user'],
    })
  if runner == "local":
    default_runner_options["concurrency"] = local_concurrency
  if runner == 'local' or runner == 'celery':
    default_runner_options["cwd"] = ctx.obj['previous_cwd'] if 'previous_cwd' in ctx.obj else os.getcwd()

  jobs = JobGroup(job_options=default_runner_options)

  inputs_iter = iter_inputs(batches, batches_files, ctx.obj['database'], ctx.obj['configurations'], ctx.obj['platform'], default_runner_options, config, ctx.obj['inputs_settings'])
  for run_context in inputs_iter:
    input_configuration_str = serialize_config(run_context.configurations)
    for tuning_params, tuning_str, tuning_hash in iter_parameters(tuning_search, filetype=filetype, extra_parameters=ctx.obj['extra_parameters']):
      if not prefix_outputs_path:
          batch_conf_dir = make_batch_conf_dir(
            outputs_commit,
            ctx.obj["batch_label"],
            run_context.platform,
            run_context.configurations,
            tuning_params,
            ctx.obj['share']
          )
      else:
          # FIXME: not 100% correct if there is tuning.. but who uses this flag anyway?
          #        worse case batch and outputs will be in slightly different folders... 
          batch_conf_dir = outputs_commit / prefix_outputs_path
          if tuning_params:
              batch_conf_dir = batch_conf_dir / tuning_hash
      from qaboard.conventions import slugify_hash, output_dirs_for_input_part
      run_context.output_dir = batch_conf_dir / output_dirs_for_input_part(run_context.rel_input_path, run_context.database, config)
      if forwarded_args:
        run_forwarded_args = [a for a in forwarded_args if not a in ("--keep-previous", "--no-postprocess", "--save-manifests-in-database")]
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
      if not 'QA_BATCH_COMPLEX_MATCHING' in os.environ:
        matching_existing_outputs = [o for o in existing_outputs.values() if url_to_dir(o['output_dir_url']) == run_context.output_dir]
        matching_existing_output = matching_existing_outputs[0] if matching_existing_outputs else None
      else:
        from .api import matching_output
        matching_existing_output = matching_output(run_context, list(existing_outputs.values()))
      if action_on_existing=='assert-exists':
        if not matching_existing_output:
          click.secho("ERROR: At least 1 run cannot be found in QA-Board's past runs'", err=True, fg="red")
          click.secho(f"       {run_context}", err=True, fg="red")
          exit(1)
        run_context.output_dir = RunContext.from_api_output(matching_existing_output).output_dir

      if list_output_dirs:
        print(run_context.output_dir)
        break

      is_pending = matching_existing_output['is_pending'] if matching_existing_output else False
      is_failed = matching_existing_output['is_failed'] if matching_existing_output else run_context.is_failed()
      ran_before = True if matching_existing_output else run_context.ran()
      should_run = not is_pending and (action_on_existing=='run' or is_failed or not ran_before)
      if not should_run and action_on_existing=='skip':
        continue
      if is_pending and action_on_pending == 'skip':
          continue

      if not forwarded_args:
        forwarded_args_cli = None
      else:
        if not on_windows:
           # FIXME: we assume no single quotes...
          forwarded_args_cli = ' '.join(f"'{a}'" for a in forwarded_args)
        else:
          from .compat import escaped_for_cli
          forwarded_args_cli = ' '.join(escaped_for_cli(a) for a in forwarded_args)

      if input_configuration_str == get_default_configuration(ctx.obj['inputs_settings']):
        configuration_cli = None
      else:
        # We can't use --config, or "-c A -c B" until we ensure all clients updated a version supporting it
        if not on_windows:
          configuration = input_configuration_str.replace("'", "'\"'\"'") # support single-quotes
          configuration_cli =  f"--configuration '{configuration}'"
        else:
          from .compat import escaped_for_cli
          configuration_cli =  f'--configuration {escaped_for_cli(input_configuration_str)}'

      if not tuning_params:
        tuning_cli = None
      else:
        if not on_windows:
          tuning_str = tuning_str.replace("'", "'\"'\"'") # support single-quotes
          tuning_cli =  f"--tuning '{tuning_str}'"
        else:
          from .compat import escaped_for_cli
          tuning_cli =  f'--tuning {escaped_for_cli(tuning_str)}'


      from .runners import runners
      platform_cli =None
      Runner = runners[run_context.job_options['type']]
      if getattr(Runner, "platform", default_platform) != default_platform:
        run_context.platform = getattr(Runner, "platform")
      if run_context.platform != default_platform:
        platform_cli = f'--platform "{run_context.platform}"'
      # We could serialize properly the run_context/runner_options, and e.g. call "qa --pickled-cli" and use the CLI command below just for logs... 
      args = [
          f"qa",
          f'--share' if ctx.obj["share"] else None,
          f'--offline' if ctx.obj['offline'] else None,
          f'--label "{ctx.obj["raw_batch_label"]}"' if ctx.obj["raw_batch_label"] != default_batch_label else None,
          platform_cli,
          f'--type "{run_context.type}"' if run_context.type != default_input_type else None,
          f'--database "{run_context.database.as_posix()}"' if run_context.database != get_default_database(ctx.obj['inputs_settings']) else None,
          configuration_cli,
          tuning_cli,
          'run' if should_run else action_on_existing,
          f'--input "{run_context.rel_input_path}"',
          f'--output "{run_context.output_dir}"' if prefix_outputs_path else None,
          forwarded_args_cli if forwarded_args_cli else None,
      ]
      command = ' '.join([arg for arg in args if arg is not None])
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
        # TODO: accumulate and send all at once to avoid 100s of requests?
        db_output = notify_qa_database(**{
          **ctx.obj,
          **run_context.obj, # for now we don't want to worry about backward compatibility, and input_path being abs vs relative...
          "is_pending": True,
          "data": {
            "job_options": run_context.job_options,
          }
        })
        if db_output: # Note: the ID is already in the matching job above
          job.id = db_output["id"]
      if is_pending:
        wait_command = f"qa wait --output-id {matching_existing_output['id']}"
        if action_on_pending=="sync":
          job.id = matching_existing_output['id']
          job.run_context.command = wait_command
        elif action_on_pending=="wait":
          job.run_context.command = f"{wait_command} || {job.run_context.command}"
        else:
          assert action_on_pending=="continue"
      jobs.append(job)

  if list_contexts:
    print(json.dumps([serialize_paths(j.run_context.asdict()) for j in jobs], indent=2))
    return

  if not dryrun:
    is_failed = jobs.start(
      blocking=not no_wait,
      qa_context=ctx.obj,
    )

    from .gitlab import gitlab_token, update_gitlab_status
    from .api import qaboard_url
    if gitlab_token and jobs and is_ci and 'QABOARD_TUNING' not in os.environ:
      name = f"QA {subproject.name}" if subproject else 'QA'
      target_url = f"{qaboard_url}/{config['project']['name']}/commit/{commit_id}"
      label = ctx.obj["batch_label"]
      if label != "default":
        name += f" | {label}"
        target_url += f"?batch={label}"
      update_gitlab_status(
        state='failed' if is_failed else 'success',
        name=name,
        target_url=target_url,
        description=f"{len(jobs)} results",
      )

    if is_failed and not no_wait:
      del os.environ['QA_BATCH'] # restore verbosity
      if should_notify_qa_database:
        print_url(ctx, status="failure")
      exit(1)
    else:
      if should_notify_qa_database:
        print_url(ctx)


@qa.command()
# Do we want this? we could simply use groups not defined in qatools.yaml:artifacts as paths
@click.option('--file', '-f', 'files', multiple=True, help="Save specific files instead of artifacts indicated by yaml file")
@click.option('--exclude', 'excluded_groups', multiple=True, help="Exclude specific artifact groups")
# Do we use this? yes in the API, but let's deprecate and remove for other uses...
@click.option('--out', '-o', 'artifacts_path', default='', help="Path to save artifacts in case of specified files")
@click.argument('groups', nargs=-1, type=click.UNPROCESSED, default=None)
@click.pass_context
def save_artifacts(ctx, files, excluded_groups, artifacts_path, groups):
  """Save the results at a standard location"""
  import filecmp
  from .config import is_in_git_repo, qatools_config_paths
  from .utils import copy, file_info
  from .compat import cased_path

  click.secho(f"Saving artifacts in: {artifacts_commit if not artifacts_path else artifacts_path}", bold=True, underline=True)

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
    config['artifacts']['__sub-qaboard.yaml'] = {"glob": [str(p.relative_to(root_qatools).parent / 'qaboard.yaml') for p in qatools_config_paths]}
    config['artifacts']['__sub-qaboard.yaml'] = {"glob": [str(p.relative_to(root_qatools).parent / 'qatools.yaml') for p in qatools_config_paths]}
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
      click.secho(
          "You are not in a git repository, maybe in an artifacts folder. `save_artifacts` is unavailable.",
          fg='yellow', dim=True)
      exit(1)

  for artifact_name, artifact_config in artifacts.items():
    click.secho(f'Saving artifacts: {artifact_name}', bold=True)
    manifest_path = artifacts_commit / 'manifests' / f'{artifact_name}.json'
    try:
      manifest_path.parent.mkdir(parents=True, exist_ok=True)
    except Exception as e:
      click.secho(f"ERROR: {e}", fg='red')
      click.secho(f"We could not create one the folders required to save the artifacts..", fg='red', dim=True)
      exit(1)
    if manifest_path.exists():
      with manifest_path.open() as f:
        try:
          manifest = json.load(f)
        except: 
          manifest = {}
    else:
      manifest = {} 

    nb_files = 0
    globs = artifact_config.get('globs', artifact_config.get('glob', []))
    if not isinstance(globs, list):
      globs = [globs]

    for g in globs:
      if not g: continue
      for path in Path('.').glob(g):
        path = cased_path(path)
        if not path.is_file():
          continue
        if artifacts_path:
          destination = artifacts_commit_root / artifacts_path / path
        else:
          destination = artifacts_commit_root / path
        if 'QA_VERBOSE_VERBOSE' in os.environ: print(destination)
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


from .bit_accuracy import check_bit_accuracy, check_bit_accuracy_manifest
qa.add_command(check_bit_accuracy)
qa.add_command(check_bit_accuracy_manifest)


from .optimize import optimize
qa.add_command(optimize)


@qa.command()
@click.pass_context
def init(ctx):
  """Provide a sample qaboard.yaml configuration."""
  from .init import qa_init
  qa_init(ctx)


def main():
  from .compat import ensure_cli_backward_compatibility
  ensure_cli_backward_compatibility()
  qa(obj={}, auto_envvar_prefix='QA')

if __name__ == '__main__':
  main()
