#!/usr/bin/env python
"""
CLI tool to runs various tasks related to QA.
"""
import os
import time
from pathlib import Path
import sys
import importlib
import errno
import traceback
import json
import yaml

import click

from .lsf import Job, running_lsf_job_names, Priority, kill_jobs
from .api import notify_qa_database

from .conventions import batch_dir, make_prefix_outputs_path, make_hash
from .conventions import serialize_config, deserialize_config
from .utils import PathType
from .utils import load_tuning_search, iter_parameters, iter_recordings

# The `qa init` command is implemented in config.py
# it helps avoiding try/catch on the import and providing lots of NA values
from .config import config_has_error
from .config import subproject, config, database, platform
from .config import user
from .config import commit_id, commit_ci_dir, branch_ci_dir, root_qatools, commit_rootproject_ci_dir

from .config import repo, is_ci


def entrypoint_module():
  """Lazily returns the entrypoint module defined in qatools.yaml"""
  entrypoint = config['project'].get('entrypoint')
  if not entrypoint:
    click.secho(f'ERROR: Could not find the entrypoint', fg='red', err=True, bold=True)
    click.secho(f'Add to qatools.yaml:\n```\nproject:\n  entrypoint: my_main.py\n```', fg='yellow', err=True, dim=True)
    exit(1)
  else:
    entrypoint = Path(entrypoint)
  try:
      # https://docs.python.org/3/library/importlib.html#importing-a-source-file-directly
      sys.path.append(str(entrypoint.parent)) # for imports from within the entrypoint's directory
      spec = importlib.util.spec_from_file_location('entrypoint', entrypoint)
      module = importlib.util.module_from_spec(spec)
      spec.loader.exec_module(module)
  except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      click.secho(f'ERROR: Error importing the entrypoint ({entrypoint}).', fg='red', err=True)
      click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', dim=True)
      click.secho(
          f'{entrypoint} must implement both `run` and `postprocess` functions.\n'
          'Please read the tutorial, and ask @arthurf for help\n'
          'http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial',
          dim=True, err=True)
      exit(1)
  return module


default_batch_label = 'default'
default_platform = platform
default_configuration = config.get('inputs', {}).get('configuration', "default")

@click.group()
@click.pass_context
@click.option('--platform', default=platform)
@click.option('--configuration', default=default_configuration, help="Will be passed to the run function")
@click.option('--batch-label', default=default_batch_label, help="Gives tuning experiments a name.")
@click.option('--tuning', default=None, help="Extra parameters for tuning (JSON)")
@click.option('--tuning-filepath', type=PathType(), default=None, help="File with extra parameters for tuning")
@click.option('--dryrun', is_flag=True, help="Only show the commands that would be executed")
@click.option('--ci', is_flag=True, help="Save outputs at the CI's centralized location, and show them in the UI.")
@click.option('--inputs-database', default=database, type=PathType(), help="Test database location")
@click.option('--inputs-glob', default=None, multiple=True, help="How we define inputs")
@click.option('--no-qa-database', is_flag=True, help="Do not notify the QA database about what is pending/running/done...")
def cli(ctx, platform, configuration, batch_label, tuning, tuning_filepath, dryrun, ci, inputs_database, inputs_glob, no_qa_database):
  """Entrypoint to running your algo, launching batchs..."""
  # We want all paths to be relative to top-most qatools.yaml
  # it should be located at the root of the git repository
  if config_has_error:
    click.secho(f'Aborting: please first fix the configuration errrors in qatools.yaml', fg='red', err=True, bold=True)
    exit(1)

  will_show_help = '-h' in sys.argv or '--help' in sys.argv
  if root_qatools != Path().resolve() and not will_show_help:
      click.secho(f'Working directory changed to root project folder: {root_qatools}', fg='cyan')
      os.chdir(root_qatools)

  # We want open permissions on outputs and artifacts
  # it makes collaboration among mutliple users / automated tools so much easier...
  os.umask(0)

  # Click passes `ctx.obj` to downstream commands, we can use it as a scratchpad
  # http://click.pocoo.org/6/complex/
  ctx.obj = {}
  ctx.obj['database'] = inputs_database
  ctx.obj['inputs_globs'] = inputs_glob
  ctx.obj['dryrun'] = dryrun
  ctx.obj['ci'] = ci
  ctx.obj['user'] = user
  ctx.obj['project'] = config['project']['name']
  ctx.obj['commit_ci_dir'] = commit_ci_dir
  # Note: to support multiple databases per project,
  # either use / as database, or somehow we need to hash the db in the output path. 
  ctx.obj['batch_label'] = batch_label if not ci else f"@{user}| {batch_label}"
  ctx.obj['platform'] = platform
  ctx.obj['configuration'] = configuration
  ctx.obj['configurations'] = deserialize_config(configuration)
  ctx.obj['no_qa_database'] = no_qa_database
  ctx.obj['extra_parameters'] = {}
  if tuning:
    ctx.obj['extra_parameters'] = json.loads(tuning)
  elif tuning_filepath:
    ctx.obj['tuning_filepath'] = tuning_filepath
    with tuning_filepath.open('r') as f:
      if tuning_filepath.suffix == '.yaml':
        ctx.obj['extra_parameters'] = yaml.load(f)
      elif tuning_filepath.suffix == '.cde':
        from cde import Config
        ctx.obj['extra_parameters'] = Config.loads(f.read()).asdict()
      else:
        ctx.obj['extra_parameters'] = json.load(f)
  # batch runs will override this since batches may have different configurations
  ctx.obj['prefix_output_dir'] = make_prefix_outputs_path(commit_ci_dir, batch_label, platform, configuration, ctx.obj['extra_parameters'] if tuning else tuning_filepath, ci)
  if is_ci: # we always want colors in the CI
    ctx.color = True


@cli.command()
@click.option('-i', '--input', 'input_path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
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
    print(f"Could not find {variable}", file=sys.stderr)


@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('-i', '--input', 'input_path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path. If not provided, defaults to ctx.obj["prefix_output_dir"] / input_path.with_suffix('')')
@click.option('--no-postprocess', is_flag=True, help="Don't do the postprocessing.")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def run(ctx, input_path, output_path, no_postprocess, forwarded_args):
    """
    Runs over a given input/recording/test and computes various success metrics and outputs.
    """
    if input_path.is_absolute():
        click.secho(f"[ERROR] the input should be given as a relative path.", fg='red')
        exit(1)
    absolute_input_path = (ctx.obj['database'] / input_path).resolve()
    ctx.obj['absolute_input_path'] =  absolute_input_path
    if not absolute_input_path.exists():
        click.secho(f"[ERROR] {absolute_input_path} cannot be found", fg='red')
        exit(1)

    if not output_path:
        output_directory = ctx.obj['prefix_output_dir'] / input_path.with_suffix('')
    else:
        # FIXME: if output_path is absolute, it should be just output_path?
        output_directory = output_path

    import shutil
    shutil.rmtree(output_directory, ignore_errors=True)
    output_directory.mkdir(parents=True, exist_ok=True)

    ctx.obj['output_directory'] = output_directory.resolve()
    ctx.obj['input_path'] =  input_path
    ctx.obj['forwarded_args'] = forwarded_args
    if not ctx.obj['no_qa_database']:
        notify_qa_database(**ctx.obj, is_pending=True, is_running=True)

    start = time.time()
    try:
      runtime_metrics = entrypoint_module().run(ctx)
      if not runtime_metrics:
        runtime_metrics = {}
      runtime_metrics['compute_time'] = time.time() - start

    except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      click.secho(f'[ERROR] The `run` function in your raised an exception:', fg='red', bold=True)
      click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', err=True)
      runtime_metrics = {'is_failed': True}

    metrics = postprocess_(runtime_metrics, ctx, skip=no_postprocess)
    if not metrics:
      metrics = runtime_metrics

    if metrics['is_failed']:
      click.secho('[ERROR] The run has failed.', fg='red', err=True)
      click.secho(str(metrics), fg='red')
    else:
      click.secho(str(metrics), fg='green')      


    from .utils import file_info
    # To help identify if input files change, we compute and save some metadata.
    if absolute_input_path.is_dir():
      input_files = {path.as_posix(): file_info(path) for path in absolute_input_path.rglob('*') if path.is_file()}
    else:
      input_files = {absolute_input_path.as_posix(): file_info(absolute_input_path)}      
    with (output_directory / 'manifest.inputs.json').open('w') as f:
      json.dump(input_files, f, indent=2)

    # To help the UI application know what results we created, we save the complete list.
    output_files = {path.relative_to(output_directory).as_posix(): file_info(path) for path in output_directory.rglob('*') if path.is_file()}
    with (output_directory / 'manifest.outputs.json').open('w') as f:
      json.dump(output_files, f, indent=2)


def postprocess_(runtime_metrics, context, skip=True):
  """Computes computes various success metrics and outputs."""
  try:
    if not skip:
      metrics = entrypoint_module().postprocess(runtime_metrics, context)
    else:
      metrics = runtime_metrics 
  except Exception as e:
    # TODO: in case of import error because postprocess was not defined, just ignore it...?
    # TODO: we should provide a default postprocess function, that reads metrics.json and returns {**previous, **runtime_metrics}
    exc_type, exc_value, exc_traceback = sys.exc_info()
    click.secho(f'[ERROR] The `postprocess` function in your entrypoint raised an exception:', fg='red', bold=True)
    click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red')
    metrics = {**runtime_metrics, 'is_failed': True}

  if 'is_failed' not in metrics:
    click.secho("[Warning] The result of the `postprocess` function misses a key `is_failed` (bool)", fg='yellow')
    metrics['is_failed'] = False

  if (context.obj['output_directory'] / 'metrics.json').exists():
    with (context.obj['output_directory'] / 'metrics.json').open('r') as f:
      previous_metrics = json.load(f)
      metrics = {
        **previous_metrics,
        **metrics,
      }
  with (context.obj['output_directory'] / 'metrics.json').open('w') as f:
      json.dump(metrics, f, sort_keys=True, indent=2, separators=(',', ': '))

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
  if not output_path:
    output_directory = ctx.obj['prefix_output_dir'] / input_path.parent / input_path.stem
  else:
    output_directory = output_path
  ctx.obj['input_path'] =  input_path
  ctx.obj['output_directory'] =  output_directory
  ctx.obj['absolute_input_path'] = (ctx.obj['database'] / input_path).resolve()
  ctx.obj['forwarded_args'] = forwarded_args
  metrics = postprocess_({}, ctx)
  click.secho(str(metrics), fg='green')      



@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('-i', '--input', 'input_path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('-o', '--output', 'output_path', type=PathType(), default=None, help='Custom output directory path. If not provided, defaults to ctx.obj["prefix_output_dir"] / input_path.with_suffix('')')
def sync(ctx, input_path, output_path):
  """Updates the database metrics using metrics.json"""
  if not output_path:
    output_directory = ctx.obj['prefix_output_dir'] / input_path.parent / input_path.stem
  else:
    output_directory = output_path

  if (output_directory/'metrics.json').exists():
    with (output_directory/'metrics.json').open('r') as f:
      metrics = json.load(f)
    ctx.obj['input_path'] =  input_path
    ctx.obj['output_directory'] =  output_directory
    notify_qa_database(**ctx.obj, metrics=metrics, is_pending=False, is_running=False)
    click.secho(str(metrics), fg='green')      


@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.option('--group', '-g', multiple=True, help="We run over all recordings in those groups")
@click.option('--groups-file', default=config.get('inputs', {}).get('groups'), help="YAML file listing groups of recordings selected from the database.")
@click.option('--tuning-search', help='string containing JSON describing the tuning parameters to explore')
@click.option('--tuning-search-file', type=PathType(), default=None, help='tuning file describing the tuning parameters to explore')
@click.option('--no-wait', is_flag=True, help="If true, returns as soon as the jobs are send to LSF, otherwise waits for completion")
@click.option('--prefix-outputs-path', type=PathType(), default=None, help='Custom prefix for the outputs; they will be at $prefix/$output_path')
@click.option('--return-prefix-outputs-path', is_flag=True, help="Only print the prefixes for the results of each batch we run an")
@click.option('--dryrun', is_flag=True, help="Only show the commands that would be executed")
@click.option('--no-batch-qa-database', is_flag=True, help="Do not notify the qa database before sending jobs.")
@click.option('--lsf-threads', default=config.get('lsf', {}).get('threads', 0), type=int, help="restrict number of lsf threads to use. 0=no restriction")
@click.option('--lsf-memory', default=config.get('lsf', {}).get('memory', 0), type=int, help="restrict memory (MB) to use. 0=no restriction")
@click.option('--lsf-sequential/--lsf-parallel', default=config.get('lsf', {}).get('sequential', False), help="Run locally, dont use LSF")
@click.option('--action-on-existing', default=config.get('outputs', {}).get('action_on_existing', "postprocess"), help="When there are already results, whether to do run/postprocess/sync/skip")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
@click.pass_context
def batch(ctx, group, groups_file, tuning_search, tuning_search_file, no_wait, prefix_outputs_path, return_prefix_outputs_path, dryrun, no_batch_qa_database, lsf_threads, lsf_memory, lsf_sequential, action_on_existing, forwarded_args):
  """Run on all the inputs/tests/recordings in a given batch using the LSF cluster."""
  if not groups_file:
    click.secho(f'WARNING: Could not find how to identify input tests.', fg='red', err=True, bold=True)
    click.secho(f'Consider adding to qatools.yaml somelike like:\n```\ninputs:\n  groups: batches.yaml\n```', fg='red', err=True)
    click.secho(f'Where batches.yaml is formatted like in http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools/input_groups.yaml', fg='red', err=True)
    return

  dryrun = ctx.obj['dryrun'] or return_prefix_outputs_path
  default_lsf_config = {"threads": lsf_threads, "memory": lsf_memory, 'sequential': lsf_sequential}

  running_jobs_names = running_lsf_job_names()
  def not_started(output_directory):
    is_done = (output_directory/'metrics.json').exists()
    is_pending = Job(output_directory).name in running_jobs_names
    return not (is_done or is_pending)

  jobs = []
  output_directories = []
  batch_hash = make_hash([group, tuning_search, str(tuning_search_file)])
  batch_job_prefix = f"{batch_hash[:10]}/"

  tuning_search_dict, filetype = load_tuning_search(tuning_search, tuning_search_file)

  tests_iter = iter_recordings(group, groups_file, ctx.obj['database'], ctx.obj['configuration'], default_lsf_config, config, globs=ctx.obj['inputs_globs'])
  for input_path_abs, input_configurations, lsf_configuration in tests_iter:
    input_configuration = serialize_config(input_configurations)
    input_path = input_path_abs.relative_to(ctx.obj['database'])
    click.secho(str(input_path), fg='blue', err=True)

    tuning_iterator = iter_parameters(tuning_search_dict, filetype=filetype, extra_parameters=ctx.obj['extra_parameters'])
    for tuning_file, tuning_hash, tuning_params in tuning_iterator:
      if not prefix_outputs_path:
          prefix_output_dir = make_prefix_outputs_path(commit_ci_dir, ctx.obj['batch_label'], ctx.obj["platform"], input_configuration, tuning_file if tuning_params else None, ctx.obj['ci'])
      else:
          prefix_output_dir = commit_ci_dir / prefix_outputs_path
          if tuning_file:
              prefix_output_dir = prefix_output_dir / Path(tuning_file).stem
      output_directory = prefix_output_dir / input_path.parent / input_path.stem
      if return_prefix_outputs_path:
        print(output_directory)
        break

      should_run = action_on_existing=='run' or not_started(output_directory)
      if not should_run and action_on_existing=='skip':
        continue

      args = [
          f"cd {subproject} &&" if str(subproject) != '.' else None,
          f"qa",
          f'--batch-label "{ctx.obj["batch_label"]}"' if ctx.obj["batch_label"] != default_batch_label else None,
          f'--platform "{ctx.obj["platform"]}"' if ctx.obj["platform"] != platform else None,
          f'--inputs-database "{ctx.obj["database"]}"' if ctx.obj['database'] != database else None,
          f'--no-qa-database' if ctx.obj['no_qa_database'] else None,
          f"--configuration '{input_configuration}'" if input_configuration != default_configuration else None,
          f'--tuning-filepath "{tuning_file}"' if tuning_params else None,
          'run' if should_run else action_on_existing,
          f'--input-path "{input_path}"',
          f'--output-path "{output_directory}"',
          ' '.join(forwarded_args),
      ]
      command = ' '.join([arg for arg in args if arg is not None])
      click.secho(command, dim=True, err=True)
      priority = Priority.LOW if tuning_params else Priority.NORMAL
      jobs.append(Job(f"{batch_job_prefix}{output_directory}", command, output_directory, priority, lsf_configuration['threads'], lsf_configuration['memory'], lsf_configuration['sequential']))
      output_directories.append(output_directory)

      if not dryrun and not ctx.obj['no_qa_database'] and not no_batch_qa_database:
        notify_qa_database(**{
          **ctx.obj,
          **{
            "configuration": input_configuration,
            "output_directory": output_directory,
            "input_path": input_path,
            "extra_parameters": tuning_params,
            "is_pending": True,
          },
        })


  waiting_job = [Job(f"{batch_job_prefix}*")]
  jobs_sent = []


  # in case we receive SIGTERM, we cancel all remaining sent jobs
  import signal
  def sigterm_handler(_signo, _stackframe):
    secho('Terminated', _signo, _stackframe, fg='red')
    kill_jobs(waiting_job, on_lsf=True)
  signal.signal(signal.SIGTERM, sigterm_handler)

  try:
      for job in jobs:
        if dryrun: continue
        job.send()
        jobs_sent.append(job)
    
      if not dryrun and not no_wait:
            tuning_search_hash = make_hash(tuning_search) if tuning_search else ''
            name = f"{commit_id}--{tuning_search_hash}--{'|'.join(group)}-wait"
            wait = Job(name, 'echo "Finished waiting for LSF jobs."')
            wait.send(interactive=True, dependencies=waiting_job)
            # sanity check
            for output_directory in output_directories:
              assert output_directory.exists()
  except:
    kill_jobs(waiting_job, on_lsf=True)


@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.option('--group', '-g', required=True, multiple=True, help="We run over all recordings in those groups")
@click.option('--groups-file', default=config.get('inputs', {}).get('groups'), help="YAML file listing groups of recordings selected from the database.")
@click.option('--config-file', required=True, type=PathType(), help="YAML search space configuration file.")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
@click.pass_context
def optimize(ctx, group, groups_file, config_file, forwarded_args):
  ctx.obj['prefix_output_dir'].mkdir(parents=True, exist_ok=True)
  ctx.obj['group'] = group
  ctx.obj['groups_file'] = groups_file
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
          'input_path': '|'.join(group),
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





@cli.command()
def save_artifacts():
  """Save the results at a standard location"""
  import shutil
  import filecmp
  from qatools.config import qatools_config_paths

  def copy(src, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(str(src), str(destination))
    # we already use umask 0, but just to be sure, we set the permissions to be open
    os.chmod(destination, 0o777)

  def copy_data(src, destination):
    shutil.copyfile(str(src), str(destination))

  click.secho(f"Saving artifacts in: {commit_rootproject_ci_dir}", bold=True, underline=True)

  # default artifacts
  if 'artifacts' not in config:
    config['artifacts'] = {}  
  config['artifacts']['qatools.yaml'] = {"glob": 'qatools.yaml'}
  config['artifacts']['qatools'] = {"glob": 'qatools/*'}
  # we also allow sub-qatools-projects
  config['artifacts']['sub-qatools.yaml'] = {"glob": [str(p.relative_to(root_qatools)) for p in qatools_config_paths]}
  config['artifacts']['sub-qatools'] = {"glob": '**/qatools/*'}
  print(config['artifacts']['sub-qatools.yaml'])
  if not repo:
      click.secho(
          "You are not in a git repository, maybe in an artifacts folder. `check_bit_accuracy` is unavailable.",
          fg='yellow', dim=True)
      exit(1)

  for artifact_name, artifact_config in config['artifacts'].items():
    click.secho(f'Saving artifacts: {artifact_name}', bold=True)
    globs = artifact_config['glob']
    if not isinstance(globs, list):
      globs = [globs]

    for g in globs:
      for path in Path('.').glob(g):
        if not path.is_file():
          continue
        destination = commit_rootproject_ci_dir / path
        if destination.exists() and filecmp.cmp(str(path), str(destination), shallow=True):
          continue
        click.secho(str(path), dim=True)

        # We are forced to add some retry logic to deal with our broken storage
        # sometimes it raises a permission error but everything is OK on the second try...
        try:
          copy(path, destination)
        except:
          time.sleep(0.1) # seconds
          try:
            copy(path, destination)
          except: # wt...
            copy_data(path, destination)


@cli.command()
@click.option(
    "--reference-branch",
    default=config.get('project', {}).get('reference_branch', 'master'),
)
def check_bit_accuracy(reference_branch):
    """
  Checks the bit accuracy of the results in the current ouput directory
  versus the latest commit on origin/develop.
  """
    from .utils import latest_commit
    from .config import commit, commit_branch, repo
    from .bit_accuracy import assert_bit_accurate_to

    if config["project"].get("type", 'git') != "git":
        click.secho("Bit-accuracy tests are only supported for git-based projects", err=True)
        exit(1)

    if not repo:
        click.secho(
            "You are not in a git repository, maybe in an artifacts folder. `check_bit_accuracy` is unavailable.",
            fg='yellow', dim=True)

    if commit_branch != reference_branch:
        click.secho(f'Comparing bit-accuracy versus the latest commit on {reference_branch}', fg='cyan', bold=True, err=True)
        assert assert_bit_accurate_to(
            latest_commit(repo, f"origin/{reference_branch}")
        ), "ERRROR: the bit-accuracy test has failed"

    # bit-accuracy on the reference branch is check on the commit's parents
    else:
        all_bit_accurate = True
        click.secho(f'We are on branch {reference_branch}', fg='cyan', bold=True, err=True)
        click.secho(f"Therefore, we check bit-accuracy against {commit}'s parents", fg='cyan', bold=True, err=True)
        for commit_ref in commit.parents:
            click.secho(f"* bit-accuracy versus {commit_ref}:", fg='cyan', err=True)
            if not assert_bit_accurate_to(commit_ref):
                all_bit_accurate = False
        assert all_bit_accurate, "ERRROR: the bit-accuracy test has failed"



def main():
  cli(obj={}, auto_envvar_prefix='QATOOLS')

if __name__ == '__main__':
  main()
