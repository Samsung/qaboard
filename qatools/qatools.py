#!/usr/bin/env python
"""
CLI tool to runs various tasks related to TOF.
"""
import os
import sys
import errno
import json
import importlib
import traceback
from pathlib import Path

import click

from .lsf import Job, running_lsf_job_names, Priority
from .utils import tuning_foldername, hash_parameters
from .utils import notify_qa_database, iter_parameters, iter_recordings
from .utils import PathType

from .config import database, platform, is_ci, config


entrypoint = config['project']['entrypoint']
try:
    # https://docs.python.org/3/library/importlib.html#importing-a-source-file-directly
    spec = importlib.util.spec_from_file_location('entrypoint', entrypoint)
    entrypoint_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(entrypoint_module)
except Exception as e:
    exc_type, exc_value, exc_traceback = sys.exc_info()
    click.secho(f'ERROR: Error importing the entrypoint ({entrypoint}).', fg='red', err=True)
    # click.secho(''.join(traceback.format_tb(exc_traceback)), fg='yellow', dim=True)
    click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', dim=True)
    click.secho(
        f'{entrypoint} must implement both `run` and `postprocess` functions.\n'
        'Please read the tutorial, and ask @arthurf for help\n'
        'http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial',
        dim=True, err=True)
    exit(1)


@click.group()
@click.pass_context
@click.option('--platform', default=platform)
@click.option('--configuration', default='base', help="Load an additional partial configurations (eg $configuration.json).")
@click.option('--batch-label', default='default', help="Gives tuning experiments a name.")
@click.option('--tuning-filepath', type=PathType(), default=None, help="Json file with extra parameters for tuning")
@click.option('--output-type', default=config['inputs']['default_output_type'], help="Override if your project needs multiple customized visualizations")
def cli(ctx, platform, configuration, batch_label, tuning_filepath, output_type):
  """Wraps all the CLI commands, identifies the TOF run we are talking about"""
  # Click passes `ctx.obj` to downstream commands, we can use it as a scratchpad
  # http://click.pocoo.org/6/complex/
  ctx.obj = {}
  ctx.obj['project'] = config['project']['name']
  ctx.obj['output_type'] = output_type
  # Note: to support multiple databases per project,
  # either use / as database, or somehow we need to hash the db in the output path. 
  ctx.obj['database'] = database
  ctx.obj['batch_label'] = batch_label
  ctx.obj['platform'] = platform
  ctx.obj['configuration'] = configuration
  if tuning_filepath:
    ctx.obj['tuning_filepath'] = tuning_filepath
    with Path(tuning_filepath).open('r') as f:
      ctx.obj['extra_parameters'] = json.load(f)

  batch_output_folder = 'output' if batch_label == 'default' else Path('tuning') / slugify(batch_label)
  # this prefix lacks information on tuning parameters
  ctx.obj['incomplete_prefix_output_dir'] = Path().resolve() / batch_output_folder / platform / configuration
  ctx.obj['prefix_output_dir'] = ctx.obj['incomplete_prefix_output_dir'] / tuning_foldername(ctx.obj['batch_label'], hash_parameters(tuning_filepath))


@cli.command()
@click.pass_context
@click.option('--recording-path', required=True, type=PathType(), help='Path of the recording/test we should work on, relative to the database directory.')
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def run(ctx, recording_path, forwarded_args):
    """
    Runs over a given recording/input/test and computes various success metrics and outputs.
    """
    ctx.obj['recording_path'] =  recording_path
    ctx.obj['output_directory'] =  ctx.obj['prefix_output_dir'] / recording_path.parent / recording_path.stem
    ctx.obj['forwarded_args'] = forwarded_args

    try:
      runtime_metrics = entrypoint_module.run(ctx)
    except Exception as e:
      click.secho(f'[ERROR] The `run` function in {entrypoint} raised an exception:', fg='red', err=True)
      click.secho(str(e), err=True)
      exit(1)

    all_metrics = postprocess_(runtime_metrics, ctx.obj)

    if all_metrics['is_failed']:
      click.secho('[ERROR] Your program seems to have crashed.', fg='red', err=True)
      click.secho('Either `metrics.json` is missing in the output directory, or your postprocessing set "{is_failed: true}".', dim=True, err=True)
      exit(1)


def postprocess_(runtime_metrics, context):
  """Computes computes various success metrics and outputs."""
  try:
    metrics = entrypoint_module.postprocess(runtime_metrics, context)
  except Exception as e:
    click.secho(f'[ERROR] The `postprocess` function in {entrypoint} raised an exception:', fg='red', err=True)
    click.secho(str(e), err=True)
    exit(1)


  save_metrics(output_directory, **metrics)
  with (output_directory/'output').open('r') as f:
    json.dumps({'output_type': context.obj['output_type']})
  notify_qa_database(**context)
  pass


@cli.command()
@click.pass_context
@click.option('--recording-path', required=True, type=PathType(), help='Path of the recording/test we should work on, relative to the database directory.')
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def postprocess(ctx, recording_path, forwarded_args):
  """Run only the post-processing, assuming results already exist."""
  ctx.obj['recording_path'] =  recording_path
  ctx.obj['output_directory'] =  ctx.obj['prefix_output_dir'] / recording_path.parent / recording_path.stem
  ctx.obj['forwarded_args'] = forwarded_args
  postprocessing(runtime_metrics={}, **ctx.obj)



@cli.command()
@click.option('--groups-file', default='swip_tof/UnitTests/batches.yaml', help="YAML file listing groups of recordings selected from the database.")
@click.option('--group', '-g', default=['small'], multiple=True, help="We run over all recordings in those groups")
@click.option('--tuning-search', help='string containing JSON describing the tuning parameters to explore')
@click.option('--no-wait', is_flag=True, help="If true, returns as soon as the jobs are send to LSF, otherwise waits for completion")
@click.option('--dryrun', is_flag=True, help="Only show the commands that would be executed")
@click.option('--overwrite', is_flag=True, help="If true, replace existing outputs")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
@click.pass_context
def batch(ctx, recording_group, recording_groups_file, tuning_search, no_wait, dryrun, overwrite, forwarded_args):
  """Run on all the recordings in a given batch using the LSF cluster.
  Unless we ask to overwrite, we don't recompute already available results.
  """
  running_jobs_names = running_lsf_job_names()
  def not_started(output_directory):
    is_done = (output_directory/'metrics.json').exists()
    is_pending = Job(output_directory).name in running_jobs_names
    return not (is_done or is_pending)

  jobs = []

  for path in iter_recordings(recording_group, recording_groups_file):
    recording_path = path.relative_to(database)
    click.secho(recording_path, bold=True)
    tuning_search_dict = json.loads(tuning_search) if tuning_search else None

    if tuning_search_dict:
      tuning_iterator = iter_parameters(tuning_search_dict)
      for tuning_file, tuning_hash, tuning_params in tuning_iterator:
        output_directory = ctx.obj['incomplete_prefix_output_dir'] / tuning_foldername(ctx.obj['batch_label'], tuning_hash) / recording_path.parent / recording_path.stem
        should_run = overwrite or not_started(output_directory)
        command = ' '.join([
            f"python {config['project']['entrypoint']}",
            f'--batch-label "{ctx.obj["batch_label"]}"',
            f'--platform "{ctx.obj["platform"]}"',
            f'--configuration "{ctx.obj["configuration"]}"',
            f'--tuning-filepath "{tuning_file}"' if tuning_file else '',
            'run' if should_run else 'metrics',
            f'--recording-path "{recording_path}"',
            f'{forwarded_args}'
        ])
        print(command)
        jobs.append(Job(output_directory, command, output_directory, Priority.LOW if tuning_file else Priority.NORMAL))
        notify_qa_database(**ctx.obj, recording_path=recording_path, extra_parameters=tuning_params, is_pending=True)

  for job in jobs:
    if dryrun: continue
    job.send()

  if not dryrun and not no_wait:
    tuning_search_hash = hashlib.md5(tuning_search.encode()).hexdigest() if tuning_search else ''
    name = f"{commit_id}--{tuning_search_hash}--{'|'.join(recording_group)}-wait"
    wait = Job(name, 'echo "finished waiting for jobs on LSF."')
    wait.send(interactive=True, dependencies=jobs)


if __name__ == '__main__':
  cli(obj={}, auto_envvar_prefix='QATOOLS')
