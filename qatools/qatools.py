#!/usr/bin/env python
"""
CLI tool to runs various tasks related to QA.
"""
import os
import time
from pathlib import Path
import sys
import traceback
import json
import yaml

import click

from .lsf import Job, LsfPriority
from .lsf import get_running_lsf_jobs, job_is_failed, job_ran_once, run_jobs
from .api import notify_qa_database

from .conventions import batch_dir, make_prefix_outputs_path, make_hash
from .conventions import serialize_config, deserialize_config, get_settings
from .utils import PathType, entrypoint_module, input_data, load_tuning_search
from .utils import redirect_std_streams
from .iterators import iter_inputs, iter_parameters

# The `qa init` command is implemented in config.py
# it helps avoiding try/catch on the import and providing lots of NA values
from .config import config_has_error
from .config import subproject, config, get_default_database
from .config import default_batches_files, default_batch_label, default_platform
from .config import get_default_configuration, config_inputs_types, default_inputs_type
from .config import user, commit_id, commit_ci_dir, root_qatools, commit_rootproject_ci_dir
from .config import is_ci, on_windows


@click.group()
@click.pass_context
@click.option('--platform', default=default_platform)
@click.option('--configuration', '-c', help="Will be passed to the run function")
@click.option('--label', '-l', 'batch_label', default=default_batch_label, help="Gives tuning experiments a name.")
@click.option('--tuning', default=None, help="Extra parameters for tuning (JSON)")
@click.option('--tuning-filepath', type=PathType(), default=None, help="File with extra parameters for tuning")
@click.option('--dryrun', is_flag=True, help="Only show the commands that would be executed")
@click.option('--share', is_flag=True, help="Show outputs in QA-Board, doesn't just save them locally.")
@click.option('--database', 'inputs_database', type=PathType(), help="Test database location")
@click.option('--type', 'inputs_type', default=default_inputs_type, help="How we define inputs")
@click.option('--no-qa-database', is_flag=True, help="Do not notify the QA database about what is pending/running/done...")
def cli(ctx, platform, configuration, batch_label, tuning, tuning_filepath, dryrun, share, inputs_database, inputs_type, no_qa_database):
  """Entrypoint to running your algo, launching batchs..."""
  # We want all paths to be relative to top-most qatools.yaml
  # it should be located at the root of the git repository
  if config_has_error:
    click.secho(f'Aborting: please first fix the configuration errrors in qatools.yaml', fg='red', err=True, bold=True)
    exit(1)

  # Click passes `ctx.obj` to downstream commands, we can use it as a scratchpad
  # http://click.pocoo.org/6/complex/
  ctx.obj = {}

  will_show_help = '-h' in sys.argv or '--help' in sys.argv
  get_command = 'get' in sys.argv
  if root_qatools != Path().resolve() and not will_show_help and not get_command:
    ctx.obj['previous_cwd'] = os.getcwd()
    click.echo(click.style("Working	directory changed to: ", fg='cyan') + click.style(str(root_qatools), fg='cyan', bold=True), err=True)
    os.chdir(root_qatools)

  # We want open permissions on outputs and artifacts
  # it makes collaboration among mutliple users / automated tools so much easier...
  os.umask(0)

  ctx.obj['project'] = config['project']['name']
  ctx.obj['HOST'] = os.environ.get('HOST', os.environ.get('HOSTNAME'))
  ctx.obj['user'] = user
  ctx.obj['dryrun'] = dryrun
  ctx.obj['share'] = share
  ctx.obj['no_qa_database'] = no_qa_database

  ctx.obj['commit_ci_dir'] = commit_ci_dir
  # Note: to support multiple databases per project,
  # either use / as database, or somehow we need to hash the db in the output path. 
  ctx.obj['raw_batch_label'] = batch_label
  ctx.obj['batch_label'] = batch_label if not share else f"@{user}| {batch_label}"
  ctx.obj['platform'] = platform

  ctx.obj['inputs_type'] = inputs_type
  ctx.obj['inputs_settings'] = get_settings(inputs_type, config)
  ctx.obj['database'] = inputs_database if inputs_database else get_default_database(ctx.obj['inputs_settings'])
  ctx.obj['configuration'] = configuration if configuration else get_default_configuration(ctx.obj['inputs_settings'])
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
  ctx.obj['prefix_output_dir'] = make_prefix_outputs_path(commit_ci_dir, ctx.obj['batch_label'], platform, ctx.obj['configuration'], ctx.obj['extra_parameters'] if tuning else tuning_filepath, share)

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


@cli.command()
@click.option('-i', '--input', 'input_path', type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path. If not provided, defaults to ctx.obj["prefix_output_dir"] / input_path.with_suffix('')')
@click.argument('variable')
@click.pass_context
def get(ctx, input_path, output_path, variable):
  """Prints the value of the requested variable. Mostly useful for debug."""
  try:
    output_directory = ctx.obj['prefix_output_dir'] / input_path.with_suffix('') if not output_path else output_path
  except:
    pass
  from .config import commit_rootproject_ci_dir, commit_ci_dir, commit_type, commit_branch, branch_ci_dir
  locals().update(globals())
  locals().update(ctx.obj)
  if variable in locals():
    print(locals().get(variable))
  else:
    click.secho(f"Could not find {variable}", err=True, fg='red')
    exit(1)



@cli.command(context_settings=dict(
    ignore_unknown_options=True,
    allow_interspersed_args=False,
))
@click.pass_context
@click.option('-i', '--input', 'input_path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path. If not provided, defaults to ctx.obj["prefix_output_dir"] / input_path.with_suffix('')')
@click.option('--no-postprocess', is_flag=True, help="Don't do the postprocessing.")
@click.option('--save-manifests-in-database', is_flag=True, help="Save the input and outputs manifests in the database.")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def run(ctx, input_path, output_path, no_postprocess, forwarded_args, save_manifests_in_database):
    """
    Runs over a given input/recording/test and computes various success metrics and outputs.
    """
    ctx.obj.update(input_data(ctx.obj['database'], input_path, config))
    absolute_input_path = ctx.obj['prefix_output_dir']
    output_directory = ctx.obj['prefix_output_dir'] / input_path.with_suffix('') if not output_path else output_path

    if not 'QATOOLS_RUN_KEEP' in os.environ:
      import shutil
      shutil.rmtree(output_directory, ignore_errors=True)
    output_directory.mkdir(parents=True, exist_ok=True)

    # without this, we can only log runs from `qa batch`, on linux, via LSF
    # this redirect is not 100% perfect, we don't get stdout from C calls
    # if not 'LSB_JOBID' in os.environ: # When using LSF, we usally already have incremental logs
    with redirect_std_streams(output_directory / 'log.txt', color=ctx.obj['color']):
      # Help reproduce qa runs with something copy-pastable in the logs
      if is_ci:
        from shlex import quote
        click.secho(' '.join(['qa', *map(quote, sys.argv[1:])]), fg='cyan', bold=True)

      ctx.obj['output_directory'] = output_directory.resolve()
      ctx.obj['forwarded_args'] = forwarded_args
      if not ctx.obj['no_qa_database']:
          notify_qa_database(**ctx.obj, is_pending=True, is_running=True)

      start = time.time()
      try:
        # TODO: remove, it's only there for backward compatibility with HW_ALG tuning 
        if 'ENV' in ctx.obj['extra_parameters']:
          ctx.obj['ENV'] = ctx.obj['extra_parameters']
          del ctx.obj['extra_parameters']

        runtime_metrics = entrypoint_module(config).run(ctx)
        if not runtime_metrics:
          runtime_metrics = {}
        runtime_metrics['compute_time'] = time.time() - start

      except Exception as e:
        exc_type, exc_value, exc_traceback = sys.exc_info()
        click.secho(f'[ERROR] Your `run` function raised an exception: {e}', fg='red', bold=True)
        try:
          exc_type, exc_value, exc_traceback = sys.exc_info()
          click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red')
        except Exception as e: # debug strange stale file errors, ideally remove this...
          print(f"ERROR: {e}")
        runtime_metrics = {'is_failed': True}

      # TODO: remove, it's only there for backward compatibility with HW_ALG tuning 
      if 'ENV' in ctx.obj:
        ctx.obj['extra_parameters'].update(ctx.obj['ENV'])
        del ctx.obj['ENV']

      metrics = postprocess_(runtime_metrics, ctx, skip=no_postprocess, save_manifests_in_database=save_manifests_in_database)
      if not metrics:
        metrics = runtime_metrics

      if metrics['is_failed']:
        click.secho('[ERROR] The run has failed.', fg='red', err=True)
        click.secho(str(metrics), fg='red', bold=True)
        exit(1)
      else:
        click.secho(str(metrics), fg='green')


def postprocess_(runtime_metrics, context, skip=False, save_manifests_in_database=False):
  """Computes computes various success metrics and outputs."""
  output_directory = context.obj['output_directory']
  try:
    if not skip:
      metrics = entrypoint_module(config).postprocess(runtime_metrics, context)
    else:
      metrics = runtime_metrics 
  except Exception as e:
    # TODO: in case of import error because postprocess was not defined, just ignore it...?
    # TODO: we should provide a default postprocess function, that reads metrics.json and returns {**previous, **runtime_metrics}
    exc_type, exc_value, exc_traceback = sys.exc_info()
    click.secho(f'[ERROR] Your `postprocess` function raised an exception:', fg='red', bold=True)
    click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red')
    metrics = {**runtime_metrics, 'is_failed': True}

  if 'is_failed' not in metrics:
    click.secho("[Warning] The result of the `postprocess` function misses a key `is_failed` (bool)", fg='yellow')
    metrics['is_failed'] = False

  if (output_directory / 'metrics.json').exists():
    with (output_directory / 'metrics.json').open('r') as f:
      previous_metrics = json.load(f)
      metrics = {
        **previous_metrics,
        **metrics,
      }
  with (output_directory / 'metrics.json').open('w') as f:
      json.dump(metrics, f, sort_keys=True, indent=2, separators=(',', ': '))

  from .utils import file_info
  # To help identify if input files change, we compute and save some metadata.
  full_input_path = (context.obj['database'] / context.obj['input_path'])
  if is_ci or save_manifests_in_database:
    manifest_inputs = context.obj.get('manifest-inputs', [full_input_path])
    input_files = {}
    for manifest_input in manifest_inputs:
      manifest_input = Path(manifest_input)
      if manifest_input.is_dir():
        input_files.update({path.as_posix(): file_info(path, config) for path in manifest_input.rglob('*') if path.is_file()})
      elif manifest_input.is_file():
        input_files.update({manifest_input.as_posix(): file_info(manifest_input, config)})
    with (output_directory / 'manifest.inputs.json').open('w') as f:
      json.dump(input_files, f, indent=2)

  def should_be_in_manifest(path):
    # avoid logs with timestamps and temporary NFS files
    return path.is_file() and path.name != 'log.txt' and not path.name.startswith('.nfs00000')
  # To help the UI application know what results we created, we save the complete list.
  output_files = {path.relative_to(output_directory).as_posix(): file_info(path, config) for path in output_directory.rglob('*') if should_be_in_manifest(path)}
  with (output_directory / 'manifest.outputs.json').open('w') as f:
    json.dump(output_files, f, indent=2)

  if save_manifests_in_database:
    if full_input_path.is_file():
      click.secho('WARNING: saving the manifests in the database is only implemented for inputs that are *folders*.', fg='yellow', err=True)
    else:
      from .utils import copy
      copy(output_directory / 'manifest.inputs.json', full_input_path / 'manifest.inputs.json')
      copy(output_directory / 'manifest.outputs.json', full_input_path / 'manifest.outputs.json')

  if not context.obj.get('no_qa_database') and not context.obj.get('dryrun'):
    notify_qa_database(**context.obj, metrics=metrics, is_pending=False, is_running=False)

  return metrics



@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('-i', '--input', 'input_path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path. If not provided, defaults to ctx.obj["prefix_output_dir"] / input_path.with_suffix('')')
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def postprocess(ctx, input_path, output_path, forwarded_args):
  """Run only the post-processing, assuming results already exist."""
  ctx.obj.update(input_data(ctx.obj['database'], input_path, config))
  absolute_input_path = ctx.obj['prefix_output_dir']
  if not output_path:
    output_directory = ctx.obj['prefix_output_dir'] / input_path.with_suffix('')
  else:
    output_directory = output_path
  ctx.obj['output_directory'] =  output_directory
  ctx.obj['forwarded_args'] = forwarded_args
  metrics = postprocess_({}, ctx)
  if metrics['is_failed']:
    click.secho('[ERROR] The run has failed.', fg='red', err=True, bold=True)
    click.secho(str(metrics), fg='red')
  else:
    click.secho(str(metrics), fg='green')      



@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('-i', '--input', 'input_path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path. If not provided, defaults to ctx.obj["prefix_output_dir"] / input_path.with_suffix('')')
def sync(ctx, input_path, output_path):
  """Updates the database metrics using metrics.json"""
  ctx.obj.update(input_data(ctx.obj['database'], input_path, config))
  absolute_input_path = ctx.obj['prefix_output_dir']
  if not output_path:
    output_directory = ctx.obj['prefix_output_dir'] / input_path.with_suffix('')
  else:
    output_directory = output_path

  if (output_directory/'metrics.json').exists():
    with (output_directory/'metrics.json').open('r') as f:
      metrics = json.load(f)
    ctx.obj['output_directory'] =  output_directory
    notify_qa_database(**ctx.obj, metrics=metrics, is_pending=False, is_running=False)
    click.secho(str(metrics), fg='green')      


lsf_config = config.get('runners').get('lsf', {}) if 'runners' in config else config.get('lsf', {})
@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.option('--batch', '-b', 'batches', multiple=True, help="We run over all inputs+configs+database in those batches")
@click.option('--batches-file', 'batches_files', default=default_batches_files, multiple=True, help="YAML files listing batches of inputs+configs+database.")
@click.option('--tuning-search', help='string containing JSON describing the tuning parameters to explore')
@click.option('--tuning-search-file', type=PathType(), default=None, help='tuning file describing the tuning parameters to explore')
@click.option('--no-wait', is_flag=True, help="If true, returns as soon as the jobs are send to LSF, otherwise waits for completion")
@click.option('--prefix-outputs-path', type=PathType(), default=None, help='Custom prefix for the outputs; they will be at $prefix/$output_path')
@click.option('--list', 'list_contexts', is_flag=True, help="Print as JSON details about each run we would do.")
@click.option('--list-output-dirs', is_flag=True, help="Only print the prefixes for the results of each batch we run on.")
@click.option('--list-inputs', is_flag=True, help="Print to stdout a JSON with a list of the inputs we would call qa run on.")
@click.option('--no-batch-qa-database', is_flag=True, help="Do not notify the qa database before sending jobs.")
@click.option('--runner', default=config.get('runners', {}).get('default', 'lsf' if os.name!='nt' else 'local'), help="Run runs locally or on LSF")
@click.option('--lsf-threads', default=lsf_config.get('threads', 0), type=int, help="restrict number of lsf threads to use. 0=no restriction")
@click.option('--lsf-memory', default=lsf_config.get('memory', 0), help="restrict memory (MB) to use. 0=no restriction")
@click.option('--lsf-queue', default=lsf_config.get('queue'), help="LSF queue (-q)")
@click.option('--lsf-fast-queue', default=lsf_config.get('fast_queue'), help="Fast LSF queue, for interactive jobs")
@click.option('--lsf-resources', default=lsf_config.get('resources', None), help="LSF resources restrictions (-R)")
@click.option('--lsf-priority', default=lsf_config.get('priority', 0), type=int, help="LSF priority (-sp)")
@click.option('--action-on-existing', default=config.get('outputs', {}).get('action_on_existing', "postprocess"), help="When there are already results, whether to do run/postprocess/sync/skip")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
@click.pass_context
def batch(ctx, batches, batches_files, tuning_search, tuning_search_file, no_wait, prefix_outputs_path, list_contexts, list_output_dirs, list_inputs, no_batch_qa_database, runner, lsf_threads, lsf_memory, lsf_queue, lsf_fast_queue, lsf_resources, lsf_priority, action_on_existing, forwarded_args):
  """Run on all the inputs/tests/recordings in a given batch using the LSF cluster."""
  if not batches_files:
    click.secho(f'WARNING: Could not find how to identify input tests.', fg='red', err=True, bold=True)
    click.secho(f'Consider adding to qatools.yaml somelike like:\n```\ninputs:\n  batches: batches.yaml\n```', fg='red', err=True)
    click.secho(f'Where batches.yaml is formatted like in http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools/input_groups.yaml', fg='red', err=True)
    return

  if not batches:
    if not len(forwarded_args):
        click.secho(f'ERROR: you must provide a batch', fg='red', err=True, bold=True)
        click.secho(f'Use either `qa batch BATCH`, or `qa batch --batch BATCH_2 --batch BATCH_2`', fg='red', err=True)
        exit(1)
    batches, *forwarded_args = forwarded_args
    batches = [batches]

  batch_label = ctx.obj['batch_label']
  commit_url = f"https://qa/{config['project']['name']}/commit/{commit_id if commit_id else ''}{f'?batch={batch_label}' if batch_label != 'default' else ''}"

  dryrun = ctx.obj['dryrun'] or list_output_dirs or list_inputs or list_contexts

  # it's debatable whether dryrun should list possibly running jobs
  running_lsf_jobs = get_running_lsf_jobs() if not dryrun else set()

  default_lsf_config =  {
    "project": lsf_config.get('project', config.get("project", {}).get('name', 'qatools')),
    "max_threads": lsf_threads,
    "max_memory": lsf_memory,
    "queue": lsf_queue,
    "fast_queue": lsf_fast_queue,
    'resources': lsf_resources
  }
  batch_hash = make_hash([batches, tuning_search, str(tuning_search_file)])
  lsf_jobs_prefix = f"{batch_hash[:8]}/"

  should_notify_qa_database = not dryrun and not ctx.obj['no_qa_database'] and not no_batch_qa_database
  if should_notify_qa_database:
    if is_ci or ctx.obj['share']:
      click.echo(click.style("Results at: ", bold=True) + click.style(commit_url, underline=True, bold=True), err=True)
    import uuid
    import datetime
    command_data = {
      "command_created_at_datetime":  datetime.datetime.utcnow().isoformat(),
      "argv": sys.argv,
      "lsf_jobs_prefix": lsf_jobs_prefix,
      **ctx.obj,
    }
    notify_qa_database(object_type='batch', command={str(uuid.uuid4()): command_data}, **ctx.obj)

  jobs = []
  jobs_contexts = []

  tuning_search_dict, filetype = load_tuning_search(tuning_search, tuning_search_file)
  inputs_iter = iter_inputs(batches, batches_files, ctx.obj['database'], ctx.obj['configurations'], default_lsf_config, config, ctx.obj['inputs_settings'])
  for input_path_abs, input_configurations, lsf_configuration, input_database in inputs_iter:
    input_configuration = serialize_config(input_configurations)
    input_path = input_path_abs.relative_to(input_database)

    tuning_iterator = iter_parameters(tuning_search_dict, filetype=filetype, extra_parameters=ctx.obj['extra_parameters'])
    for tuning_file, tuning_hash, tuning_params in tuning_iterator:
      if not prefix_outputs_path:
          prefix_output_dir = make_prefix_outputs_path(commit_ci_dir, ctx.obj["batch_label"], ctx.obj["platform"], input_configuration, tuning_file if tuning_params else None, ctx.obj['share'])
      else:
          prefix_output_dir = commit_ci_dir / prefix_outputs_path
          if tuning_file:
              prefix_output_dir = prefix_output_dir / Path(tuning_file).stem
      output_directory = prefix_output_dir / input_path.with_suffix('')
      if list_output_dirs:
        print(output_directory)
        break
      if list_inputs:
        print(input_path_abs)        
        break
      if list_contexts:
        jobs_contexts.append({
          "absolute_input_path": str(input_path_abs),
          "input_path": str(input_path),
          "database": str(input_database),
          "configurations": input_configurations,
          "input_database": str(input_database),
        })
        break

      # LSF job names are based on the output directory and transformed 
      is_pending = Job(output_directory).name in running_lsf_jobs
      is_failed = job_is_failed(output_directory)
      should_run = not is_pending and (action_on_existing=='run' or is_failed or not job_ran_once(output_directory)) 
      if not should_run and action_on_existing=='skip':
        continue

      if input_configuration == get_default_configuration(ctx.obj['inputs_settings']):
        configuration_cli = None
      else:
        if not on_windows:
          configuration_cli =  f"--configuration '{input_configuration}'"
        else:
          input_configuration_serialized = input_configuration.replace('"', '\\"')
          configuration_cli =  f'--configuration "{input_configuration_serialized}"'

      args = [
          f"qa",
          f'--share' if ctx.obj["share"] else None,
          f'--label "{ctx.obj["raw_batch_label"]}"' if ctx.obj["raw_batch_label"] != default_batch_label else None,
          f'--platform "{ctx.obj["platform"]}"' if ctx.obj["platform"] != default_platform else None,
          f'--type "{ctx.obj["inputs_type"]}"' if ctx.obj["inputs_type"] != default_inputs_type else None,
          f'--database "{input_database.as_posix()}"' if input_database != get_default_database(ctx.obj['inputs_settings']) else None,
          f'--no-qa-database' if ctx.obj['no_qa_database'] else None,
          configuration_cli,
          f'--tuning-filepath "{tuning_file}"' if tuning_params else None,
          'run' if should_run else action_on_existing,
          f'--input "{input_path}"',
          f'--output "{output_directory}"' if prefix_outputs_path else None,
          ' '.join(forwarded_args),
      ]
      command = ' '.join([arg for arg in args if arg is not None])
      click.secho(command, dim=True, err=True)
      if str(subproject) != '.':
        command = f"cd {subproject} && {command}"

      lsf_configuration['priority'] = LsfPriority.LOW if tuning_params else LsfPriority.NORMAL
      job = Job(f"{lsf_jobs_prefix}{output_directory}", command, output_directory, lsf_configuration)
      if should_notify_qa_database:
        db_output = notify_qa_database(**{
          **ctx.obj,
          **{
            "configuration": input_configuration,
            "output_directory": output_directory,
            "input_path": input_path,
            "database": input_database,
            "extra_parameters": tuning_params,
            "is_pending": True,
          },
        })
        if db_output:
          job.id = db_output["id"]

      jobs.append(job)


  if list_contexts:
    print(json.dumps(jobs_contexts, indent=2))
    return

  if not dryrun:
    tuning_search_hash = make_hash(tuning_search) if tuning_search else ''
    waiting_job_name = f"{commit_id}-{tuning_search_hash}-{'|'.join(batches)}-wait"
    # Our share storage takes a while to sync. It should be solved, and this sleep removed
    # But for local runs, no need to wait
    delay_before_status_check = 0 if is_ci or ctx.obj['share'] else 0 #seconds
    is_failed = run_jobs(jobs, runner, no_wait, lsf_jobs_prefix, default_lsf_config, waiting_job_name, delay_before_status_check=delay_before_status_check, config=config, ctx=ctx)

    from .gitlab import update_gitlab_status
    if jobs and is_ci and (batch_label=='default' or 'QATOOLS_ALWAYS_UPDATE_GITLAB' in os.environ):
      update_gitlab_status(commit_id, 'failed' if is_failed else 'success')

    if is_failed:
      if is_ci:
        click.secho(f"Read all the logs at: {commit_url}{'?' if batch_label == 'default' else '&'}selected_views=logs", fg='red', bold=True)
      exit(1)



@cli.command()
@click.pass_context
def save_artifacts(ctx):
  """Save the results at a standard location"""
  import filecmp
  from qatools.config import is_in_git_repo, qatools_config_paths
  from .utils import copy, file_info, cased_path

  click.secho(f"Saving artifacts in: {commit_rootproject_ci_dir}", bold=True, underline=True)

  # default artifacts
  if 'artifacts' not in config:
    config['artifacts'] = {}  
  config['artifacts']['__qatools.yaml'] = {"glob": 'qatools.yaml'}
  config['artifacts']['__qatools'] = {"glob": 'qatools/*'}
  # we also allow sub-qatools-projects
  config['artifacts']['__sub-qatools.yaml'] = {"glob": [str(p.relative_to(root_qatools).parent / 'qatools.yaml') for p in qatools_config_paths]}
  config['artifacts']['__metrics.yaml'] = {"glob": config.get('outputs', {}).get('metrics')}
  config['artifacts']['__batches.yaml'] = {"glob": default_batches_files}
  config['artifacts']['__envrc'] = {"glob": ['.envrc', '**/*.envrc']}
  if 'QATOOLS_EXTRA_VERBOSE' in os.environ: print(config['artifacts'])
  if not is_in_git_repo:
      click.secho(
          "You are not in a git repository, maybe in an artifacts folder. `save_artifacts` is unavailable.",
          fg='yellow', dim=True)
      exit(1)

  for artifact_name, artifact_config in config['artifacts'].items():
    click.secho(f'Saving artifacts: {artifact_name}', bold=True)
    manifest_path = commit_ci_dir / 'manifests' / f'{artifact_name}.json'
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    if manifest_path.exists():
      with manifest_path.open() as f:
        try:
          manifest = json.load(f)
        except: 
          manifest = {}
    else:
      manifest = {} 

    nb_files = 0
    globs = artifact_config.get('glob')
    if not isinstance(globs, list):
      globs = [globs]

    for g in globs:
      if not g: continue
      for path in Path('.').glob(g):
        path = cased_path(path)
        if not path.is_file():
          continue
        destination = commit_rootproject_ci_dir / path
        if 'QATOOLS_EXTRA_VERBOSE' in os.environ: print(destination)
        if destination.exists() and filecmp.cmp(str(path), str(destination), shallow=True):
          # when working on subprojects, the artifact might be copied already,
          # but manifests are saved per-subproject
          if path.as_posix() not in manifest:
            manifest[path.as_posix()] = file_info(path, config)
          continue
        if 'QATOOLS_VERBOSE' in os.environ or ctx.obj['dryrun']:
          click.secho(str(path), dim=True)
        if not ctx.obj['dryrun']:
          copy(path, destination)
          manifest[path.as_posix()] = file_info(path, config)

    if not ctx.obj['dryrun']:
      with manifest_path.open('w') as f:
        json.dump(manifest, f)
    if nb_files > 0:
      click.secho(f"{nb_files} files copied")
    # if the commit was deleted, this notification will mark it as good again 
  notify_qa_database(object_type='commit', **ctx.obj)


@cli.command()
@click.pass_context
@click.option('--batch', '-b', 'batches', required=True, multiple=True, help="Only check bit-accuracy for this batch of inputs+configs+database.")
@click.option('--batches-file', 'batches_files', default=default_batches_files, multiple=True, help="YAML file listing batches of inputs+config+database selected from the database.")
def check_bit_accuracy_manifest(ctx, batches, batches_files):
    """
  Checks the bit accuracy of the results in the current ouput directory
  versus the latest commit on origin/develop.
  """
    from .config import is_ci
    from .bit_accuracy import is_bit_accurate

    commit_dir = commit_ci_dir if is_ci else Path()
    all_bit_accurate = True
    inputs_iter = iter_inputs(batches, batches_files, ctx.obj['database'], ctx.obj['configurations'], {}, config, ctx.obj['inputs_settings'])
    nb_compared = 0
    for input_path_abs, input_configurations, _, input_database in inputs_iter:
      nb_compared += 1
      if input_path_abs.is_file():
        click.secho('ERROR: check_bit_accuracy_manifest only works for inputs that are folders', fg='red', err=True)
        # otherwise the manifest is at
        #   * input_path.parent / 'manifest.json' in the database
        #   * input_path.with_suffix('') / 'manifest.json' in the results
        # # reference_output_directory = input_path_abs if input_path_abs.is_folder() else input_path_abs.parent
        exit(1)

      prefix_output_dir = make_prefix_outputs_path(subproject, ctx.obj['batch_label'], ctx.obj["platform"], serialize_config(input_configurations), None, ctx.obj['share'])
      # print(prefix_output_dir)
      input_path = input_path_abs.relative_to(input_database)
      # print(commit_dir / prefix_output_dir, input_database, [input_path])
      input_is_bit_accurate = is_bit_accurate(commit_dir / prefix_output_dir, input_database, [input_path])
      all_bit_accurate = all_bit_accurate and input_is_bit_accurate

    if not all_bit_accurate:
      click.secho("\nError: you are not bit-accurate versus the manifest.", fg='red', underline=True, bold=True)
      click.secho("Reminder: the manifest lists the expected inputs/outputs for each test. It acts as an explicit gatekeeper against changes", fg='red', dim=True)
      if not input_database.is_absolute():
        click.secho("If that's what you wanted, update and commit all manifests.", fg='red')
        # click.secho("If that's what you wanted, update all manifests using:", fg='red')
        # click.secho("$ qa batch * --save-manifests-in-database", fg='red')
        # click.secho("$ git add        # your changes", fg='red')
        # click.secho("$ git commit     # now retry your CI", fg='red')
      else:
        click.secho("To update the manifests for all tests, run:", fg='red')
        click.secho("$ qa batch --save-manifests --batch *", fg='red')
      exit(1)

    if not nb_compared:
      click.secho("\nWARNING: Nothing was compared! It's not likely to be what you expected...", fg='yellow', underline=True, bold=True)



@cli.command()
@click.pass_context
@click.option(
    "--reference",
    default=config.get('project', {}).get('reference_branch', 'master'),
    help="Branch, tag or commit used as reference."
)
@click.option('--batch', '-b', 'batches', multiple=True, help="Only check bit-accuracy for those batches of inputs+configs+database.")
@click.option('--batches-file', 'batches_files', default=default_batches_files, multiple=True, help="YAML file listing batches of inputs+config+database selected from the database.")
@click.option('--reference-platform', help="Compare against a difference platform.")
def check_bit_accuracy(ctx, reference, batches, batches_files, reference_platform):
    """
  Checks the bit accuracy of the results in the current ouput directory
  versus the latest commit on origin/develop.
  """
    from .config import is_in_git_repo, commit, commit_branch, repo, is_ci, ci_dir
    from .bit_accuracy import is_bit_accurate, lastest_successful_ci_commit
    from .conventions import get_commit_ci_dir
    from .utils import latest_commit

    if not is_in_git_repo:
      click.secho("You are not in a git repository, maybe in an artifacts folder. `check_bit_accuracy` is unavailable.", fg='yellow', dim=True)
      exit(1)


    if is_ci and commit_branch == reference:
      click.secho(f'We are on branch {reference}', fg='cyan', bold=True, err=True)
      click.secho(f"Comparing bit-accuracy against this commit's ({commit_id[:8]}) parents.", fg='cyan', bold=True, err=True)
      # It will work until we try to rebase merge requests.
      # We really should use Gitlab' API (or our database) to ask about previous pipelines on the branch
      reference_commits = commit.parents
    else:
      click.secho(f'Comparing bit-accuracy versus the latest commit from origin/{reference}', fg='cyan', bold=True, err=True)
      reference_commits = [latest_commit(repo, reference)]

    reference_shas = ','.join([r.hexsha[:8] for r in reference_commits])
    click.secho(f"{commit_id[:8]} versus {reference_shas}.", fg='cyan', err=True)
    
    # This where the new results are located
    commit_dir = commit_rootproject_ci_dir if is_ci else Path()

    if not batches:
      output_directories = list(p.parent.relative_to(commit_dir) for p in (commit_dir / subproject / 'output').rglob('manifest.outputs.json'))
    else:
      output_directories = []
      inputs_iter = iter_inputs(batches, batches_files, ctx.obj['database'], ctx.obj['configurations'], {}, config, ctx.obj['inputs_settings'])
      for input_path_abs, input_configurations, _, input_database in inputs_iter:
        prefix_output_dir = make_prefix_outputs_path(subproject, ctx.obj['batch_label'], ctx.obj["platform"], serialize_config(input_configurations), None, ctx.obj['share'])
        input_path = input_path_abs.relative_to(input_database)
        output_directory = prefix_output_dir / input_path.with_suffix('')
        output_directories.append(output_directory)

    for reference_commit in reference_commits:
      # if the reference commit is pending or failed, we wait or maybe pick a parent
      reference_commit = lastest_successful_ci_commit(reference_commit)
      click.secho(f'Current directory  : {commit_dir}', fg='cyan', bold=True, err=True)
      reference_rootproject_ci_dir = get_commit_ci_dir(ci_dir, reference_commit)
      click.secho(f"Reference directory: {reference_rootproject_ci_dir}", fg='cyan', bold=True, err=True)
      all_bit_accurate = True
      for o in output_directories:
        for reference_commit in reference_commits:
          all_bit_accurate = is_bit_accurate(commit_dir, reference_rootproject_ci_dir, [o], reference_platform) and all_bit_accurate
    if not all_bit_accurate:
      click.secho(f"ERROR: results are not bit-accurate to {reference_shas}.", fg='red', bold=True)
      if is_ci:
        click.secho(f"\nTo investigate, go to", fg='red', underline=True)
        for reference_commit in reference_commits:
          click.secho(f"https://qa/{config['project']['name']}/commit/{commit_id}?reference={reference_commit.hexsha}&selected_views=bit_accuracy", fg='red')
      exit(1)

@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.option('--batch', '-b', 'batches', required=True, multiple=True, help="Use the inputs+configs+database in those batches")
@click.option('--batches-file', 'batches_files', default=default_batches_files, multiple=True, help="YAML file listing batches of inputs+config+database selected from the database.")
@click.option('--config-file', required=True, type=PathType(), help="YAML search space configuration file.")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
@click.pass_context
def optimize(ctx, batches, batches_files, config_file, forwarded_args):
  ctx.obj['prefix_output_dir'].mkdir(parents=True, exist_ok=True)
  ctx.obj['batches'] = batches
  ctx.obj['batches_files'] = batches_files
  ctx.obj['forwarded_args'] = forwarded_args

  from shutil import rmtree
  from .tuning import init_optimization, make_plots
  from .api import aggregated_metrics
  objective, optimizer, optim_config, dim_mapping = init_optimization(config_file, ctx)

  # TODO: warm-start
  #   load and "tell" existing results (if there are any)
  #   (or use a checkpoint?)

  for iteration in range(optim_config['evaluations']):
      suggested = optimizer.ask()
      y = objective([*suggested, iteration])
      results = optimizer.tell(suggested, y)

      iteration_batch_label = f"{ctx.obj['batch_label']}|iter{iteration+1}"
      iteration_batch_dir = batch_dir(commit_ci_dir, iteration_batch_label, True)
      notify_qa_database(**{
        **ctx.obj,
        **{
          "extra_parameters": dim_mapping(suggested),
          # TODO: we really should to tuning/platform in make_prefix_outputs_path
          #       1. make change, 2. rename existing folders)
          "output_directory": iteration_batch_dir,
          'input_path': '|'.join(batches),
          # we want to show in the summary tab the best results for the tuning experiment
          # but in the exploration see the results per iteration....
          "output_type": 'optim_iteration', # or... single ? don't show them in the UI
          "is_pending": False,
          "is_pending": False,
          "is_failed": False,
          "metrics": {
            "iteration": iteration+1,
            "objective": y,
            **aggregated_metrics(iteration_batch_label),
          },
        },
      })

      notify_qa_database(object_type='batch', **{
        **ctx.obj,
        **{
            "data": {
              "optimization": True,
              "iterations": iteration+1,
            },
        },
      })

      # results
      #    .x [float]: location of the minimum.
      #    .fun [float]: function value at the minimum.
      #    .models: surrogate models used for each iteration.
      #    .x_iters [array]: location of function evaluation for each iteration.
      #    .func_vals [array]: function value for each iteration.
      #    .space [Space]: the optimization space.
      #    .specs [dict]: parameters passed to the function.
      is_best = results.fun < results.func_vals[iteration]
      if iteration==0 or is_best:
        click.secho(f'New best @iteration{iteration+1}: {y} at iteration {iteration+1}', fg='green')
        notify_qa_database(object_type='batch', **{
          **ctx.obj,
          **{
              "data": {
                "best_params": dim_mapping(suggested),
                "best_iter": iteration+1,
                "best_metrics": aggregated_metrics(iteration_batch_label),
              },
          },
        })
        try:
          make_plots(results, batch_dir(commit_ci_dir, ctx.obj['batch_label'], tuning=True))
        except:
          pass
      else:
        # We remove the results to make sure we don't waste disk space
        rmtree(iteration_batch_dir, ignore_errors=True)

  print(results)
  if not results.models: # needs at least n_initial_points(=5) evaluations!
    return

  # tuning plots are saved in the label directory
  make_plots(results, batch_dir(commit_ci_dir, ctx.obj['batch_label'], tuning=True))





def main():
  cli(obj={}, auto_envvar_prefix='QATOOLS')

if __name__ == '__main__':
  main()
