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

from .utils import batch_dir, make_prefix_outputs_path, load_tuning_search
from .utils import iter_parameters, iter_recordings
from .utils import PathType
from .utils import make_hash

# The `init` command is implemented in config.py
# it helps avoiding try/catch on the import and providing lots of NA values
from .config import config, database, platform
from .config import commit_id, commit_ci_dir, branch_ci_dir
from .config import repo, is_ci


entrypoint = Path(config['project']['entrypoint'])
def entrypoint_module():
  """Lazily returns the entrypoint module"""
  # TODO: make this lazy, so that qa starts without loading lots of big packages
  # used in the entrypoint like numpy scipy etc
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

# we want open permissions on outputs and artifacts
# it makes collaboration among mutliple users / automated tools so much easier...
os.umask(0)


@click.group()
@click.pass_context
@click.option('--platform', default=platform)
@click.option('--configuration', default=config['inputs']['configuration'], help="Load an additional partial configurations (eg $configuration.json).")
@click.option('--batch-label', default='default', help="Gives tuning experiments a name.")
@click.option('--tuning', default=None, help="Extra parameters for tuning (JSON)")
@click.option('--tuning-filepath', type=PathType(), default=None, help="File with extra parameters for tuning")
@click.option('--dryrun', is_flag=True, help="Only show the commands that would be executed")
@click.option('--no-qa-database', is_flag=True, help="Do not notify the QA database about what is pending/running/done...")
def cli(ctx, platform, configuration, batch_label, tuning, tuning_filepath, dryrun, no_qa_database):
  """Entrypoint to running your algo, launching batchs..."""
  # Click passes `ctx.obj` to downstream commands, we can use it as a scratchpad
  # http://click.pocoo.org/6/complex/
  ctx.obj = {}
  ctx.obj['dryrun'] = dryrun
  ctx.obj['project'] = config['project']['name']
  ctx.obj['commit_ci_dir'] = commit_ci_dir
  # Note: to support multiple databases per project,
  # either use / as database, or somehow we need to hash the db in the output path. 
  ctx.obj['database'] = database
  ctx.obj['batch_label'] = batch_label
  ctx.obj['platform'] = platform
  ctx.obj['configuration'] = configuration
  ctx.obj['no_qa_database'] = no_qa_database
  ctx.obj['extra_parameters'] = {}
  if tuning:
    ctx.obj['extra_parameters'] = json.loads(tuning)
  elif tuning_filepath:
    ctx.obj['tuning_filepath'] = tuning_filepath
    with tuning_filepath.open('r') as f:
      if tuning_filepath.suffix == '.yaml':
        ctx.obj['extra_parameters'] = yaml.load(f)
      else:
        ctx.obj['extra_parameters'] = json.load(f)
  # batch runs will override this since batches may have different configurations
  ctx.obj['prefix_output_dir'] = make_prefix_outputs_path(commit_ci_dir, batch_label, platform, configuration, ctx.obj['extra_parameters'] if tuning else tuning_filepath)
  if is_ci: # we always want colors in the CI
    ctx.color = True


@cli.command()
@click.option('--input-path', type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('--output-path', type=PathType(), default=None, help='Custom output path. If not provided, defaults to ctx.obj["prefix_output_dir"] / input_path.parent / input_path.stem')
@click.argument('variable')
@click.pass_context
def get(ctx, input_path, output_path, variable):
  """Prints the value of the requested variable."""
  try:
    if not output_path:
        output_directory = ctx.obj['prefix_output_dir'] / input_path.with_suffix('')
    else:
        output_directory = commit_ci_dir / output_path
  except:
    pass
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
@click.option('--input-path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('--output-path', type=PathType(), default=None, help='Custom output directory path. If not provided, defaults to ctx.obj["prefix_output_dir"] / input_path.with_suffix('')')
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def run(ctx, input_path, output_path, forwarded_args):
    """
    Runs over a given input/recording/test and computes various success metrics and outputs.
    """
    if not output_path:
        abs_input_path = ctx.obj['database'] / input_path
        if not abs_input_path.exists():
            click.secho("[ERROR] {abs_input_path} cannot be found", fg='red')
            exit(1)
        output_directory = ctx.obj['prefix_output_dir'] / input_path.with_suffix('')
    else:
        # FIXME: if output_path is absolute, it should be just output_path?
        output_directory = commit_ci_dir / output_path

    output_directory.mkdir(parents=True, exist_ok=True)
    ctx.obj['output_directory'] =  output_directory
    ctx.obj['input_path'] =  input_path
    ctx.obj['forwarded_args'] = forwarded_args
    if not ctx.obj['no_qa_database']:
        notify_qa_database(**ctx.obj, is_pending=True, is_running=True)

    start = time.time()
    try:
      runtime_metrics = {
       'compute_time': time.time()-start,
        **entrypoint_module().run(ctx),
      }

    except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      click.secho(f'[ERROR] The `run` function in {entrypoint} raised an exception:', fg='red', bold=True)
      click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', err=True)
      exit(1)

    metrics = postprocess_(runtime_metrics, ctx)

    if 'is_failed' not in metrics:
      click.secho("[ERROR] The result of the `postprocess` misses a key `is_failed` (bool)", fg='red')
      exit(1)

    if metrics['is_failed']:
      click.secho('[ERROR] Your program seems to have crashed.', fg='red', err=True)
      click.secho(str(metrics), fg='red')      
      exit(1)

    click.secho(str(metrics), fg='green')      


def postprocess_(runtime_metrics, context):
  """Computes computes various success metrics and outputs."""
  try:
    metrics = entrypoint_module().postprocess(runtime_metrics, context)
  except Exception as e:
    # TODO: in case of import error because postprocess was not defined, just ignore it...?
    # TODO: we should provide a default postprocess function, that reads metrics.json and returns {**previous, **runtime_metrics}
    exc_type, exc_value, exc_traceback = sys.exc_info()
    click.secho(f'[ERROR] The `postprocess` function in {entrypoint} raised an exception:', fg='red', bold=True)
    click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red')
    metrics = {"is_failed": True}

  if (context.obj['output_directory']/'metrics.json').exists():
    with (context.obj['output_directory']/'metrics.json').open('r') as f:
      metrics.update(json.load(f))
  with (context.obj['output_directory']/'metrics.json').open('w') as f:
      json.dump(metrics, f, sort_keys=True, indent=2, separators=(',', ': '))

  if not context.obj.get('no_qa_database') and not context.obj.get('dryrun'):
    notify_qa_database(**context.obj, metrics=metrics, is_pending=False, is_running=False)
  return metrics

@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('--input-path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('--output-path', type=PathType(), default=None, help='Custom output directory path. If not provided, defaults to ctx.obj["prefix_output_dir"] / input_path.parent / input_path.stem')
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def postprocess(ctx, input_path, output_path, forwarded_args):
  """Run only the post-processing, assuming results already exist."""
  if not output_path:
    output_directory = ctx.obj['prefix_output_dir'] / input_path.parent / input_path.stem
  else:
    output_directory = commit_ci_dir / output_path
  ctx.obj['input_path'] =  input_path
  ctx.obj['output_directory'] =  output_directory
  ctx.obj['forwarded_args'] = forwarded_args
  metrics = postprocess_({}, ctx)
  click.secho(str(metrics), fg='green')      


@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.option('--group', '-g', multiple=True, help="We run over all recordings in those groups")
@click.option('--groups-file', default=config['inputs']['groups'], help="YAML file listing groups of recordings selected from the database.")
@click.option('--tuning-search', help='string containing JSON describing the tuning parameters to explore')
@click.option('--tuning-search-file', type=PathType(), default=None, help='tuning file describing the tuning parameters to explore')
@click.option('--no-wait', is_flag=True, help="If true, returns as soon as the jobs are send to LSF, otherwise waits for completion")
@click.option('--overwrite', is_flag=True, help="If true, replace existing outputs")
@click.option('--prefix-outputs-path', type=PathType(), default=None, help='Custom prefix for the outputs; they will be at $prefix/$output_path')
@click.option('--return-prefix-outputs-path', is_flag=True, help="Only print the prefixes for the results of each batch we run an")
@click.option('--dryrun', is_flag=True, help="Only show the commands that would be executed")
@click.option('--no-batch-qa-database', is_flag=True, help="Do not notify the qa database before sending jobs.")
@click.option('--lsf-threads', default=0, type=int, help="Restrict number of lsf threads to use. 0 = no restriction")
@click.option('--lsf-memory', default=0, type=int, help="Restrict memory (MB) to use. 0 = no restriction")
@click.option('--skip-existing', is_flag=True , help="If true, skip the postprocess command on existing outputs")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
@click.pass_context
def batch(ctx, group, groups_file, tuning_search, tuning_search_file, no_wait, overwrite, prefix_outputs_path, return_prefix_outputs_path, dryrun, no_batch_qa_database, lsf_threads, lsf_memory, skip_existing, forwarded_args):
  """Run on all the inputs/tests/recordings in a given batch using the LSF cluster.
  Unless we ask to overwrite, we don't recompute already available results.
  """
  dryrun = ctx.obj['dryrun'] or return_prefix_outputs_path

  running_jobs_names = running_lsf_job_names()
  def not_started(output_directory):
    is_done = (output_directory/'metrics.json').exists()
    is_pending = Job(output_directory).name in running_jobs_names
    return not (is_done or is_pending)

  jobs = []
  batch_hash = make_hash([group, tuning_search, str(tuning_search_file)])
  batch_job_prefix = f"{batch_hash[:10]}/"

  tuning_search_dict, filetype = load_tuning_search(tuning_search, tuning_search_file)

  for input_path_abs, input_configuration in iter_recordings(group, groups_file, ctx.obj['database'], ctx.obj['configuration'], config):
    input_path = input_path_abs.relative_to(ctx.obj['database'])
    click.secho(str(input_path), fg='blue', dim=True, err=True)

    tuning_iterator = iter_parameters(tuning_search_dict, filetype=filetype, extra_parameters=ctx.obj['extra_parameters'])
    for tuning_file, tuning_hash, tuning_params in tuning_iterator:
      if not prefix_outputs_path:
          prefix_output_dir = make_prefix_outputs_path(commit_ci_dir, ctx.obj['batch_label'], ctx.obj["platform"], input_configuration, tuning_file if tuning_params else None)
      else:
          prefix_output_dir = commit_ci_dir / prefix_outputs_path
          if tuning_file:
              prefix_output_dir = prefix_output_dir / Path(tuning_file).stem
      output_directory = prefix_output_dir / input_path.parent / input_path.stem
      if return_prefix_outputs_path:
        print(output_directory)
        break

      should_run = overwrite or not_started(output_directory)
      if not should_run and skip_existing:
        continue

      command = ' '.join([
          f"qa",
          f'--batch-label "{ctx.obj["batch_label"]}"',
          f'--platform "{ctx.obj["platform"]}"',
          f'--no-qa-database' if ctx.obj['no_qa_database'] else '',
          f'--configuration "{input_configuration}"',
          f'--tuning-filepath "{tuning_file}"' if tuning_params else '',
          'run' if should_run else 'postprocess',
          f'--input-path "{input_path}"',
          f'--output-path "{output_directory}"',
          ' '.join(forwarded_args),
      ])
      click.secho(command, dim=True, err=True)
      priority = Priority.LOW if tuning_params else Priority.NORMAL
      jobs.append(Job(f"{batch_job_prefix}{output_directory}", command, output_directory, priority, lsf_threads, lsf_memory))

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
  try:
      for job in jobs:
        if dryrun: continue
        job.send()
        jobs_sent.append(job)
    
      if not dryrun and not no_wait:
            tuning_search_hash = make_hash(tuning_search) if tuning_search else ''
            name = f"{commit_id}--{tuning_search_hash}--{'|'.join(group)}-wait"
            wait = Job(name, 'echo "finished waiting for jobs on LSF."')
            wait.send(interactive=True, dependencies=waiting_job)
  except:
      kill_jobs(waiting_job, on_lsf = True)



@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.option('--group', '-g', required=True, multiple=True, help="We run over all recordings in those groups")
@click.option('--groups-file', default=config['inputs']['groups'], help="YAML file listing groups of recordings selected from the database.")
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

  def copy(src, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(str(src), str(destination))
    # we already use umask 0, but just to be sure, we set the permissions to be open
    os.chmod(destination, 0o777)

  def copy_data(src, destination):
    shutil.copyfile(str(src), str(destination))

  click.secho(f"Saving artifacts in: {commit_ci_dir}", bold=True, underline=True)

  # default artifacts
  config['artifacts']['qatools.yaml'] = {"glob": 'qatools.yaml'}
  config['artifacts']['qatools'] = {"glob": 'qatools/*'}

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
        destination = commit_ci_dir / path
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
    default=config['project']['reference_branch'],
)
def check_bit_accuracy(reference_branch):
    """
  Checks the bit accuracy of the results in the current ouput directory
  versus the latest commit on origin/develop.
  """
    from .utils import latest_commit
    from .config import commit, commit_branch, repo
    from .bit_accuracy import assert_bit_accurate_to

    if config["project"]["type"] != "git":
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