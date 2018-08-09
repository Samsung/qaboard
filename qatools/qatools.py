#!/usr/bin/env python
"""
CLI tool to runs various tasks related to QA.
"""
import sys
import errno
import json
import importlib
from traceback import format_exception
from pathlib import Path

import click

from .lsf import Job, running_lsf_job_names, Priority
from .utils import tuning_foldername, hash_parameters
from .utils import save_metrics, notify_qa_database, iter_parameters, iter_recordings
from .utils import PathType

# The `init` command is implemented in config.py
# it helps avoiding try/catch on the import and providing lots of NA values
from .config import database, platform, config, commit_id, commit_ci_dir


entrypoint = Path(config['project']['entrypoint'])
try:
    # https://docs.python.org/3/library/importlib.html#importing-a-source-file-directly
    sys.path.append(str(entrypoint.parent)) # for imports from within the entrypoint's directory
    spec = importlib.util.spec_from_file_location('entrypoint', entrypoint)
    entrypoint_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(entrypoint_module)
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


@click.group()
@click.pass_context
@click.option('--platform', default=platform)
@click.option('--configuration', default=config['inputs']['configuration'], help="Load an additional partial configurations (eg $configuration.json).")
@click.option('--batch-label', default='default', help="Gives tuning experiments a name.")
@click.option('--tuning-filepath', type=PathType(), default=None, help="Json file with extra parameters for tuning")
@click.option('--output-type', default=config['outputs']['output_type'], help="Override if your project needs multiple customized visualizations")
@click.option('--dryrun', is_flag=True, help="Only show the commands that would be executed")
def cli(ctx, platform, configuration, batch_label, tuning_filepath, output_type, dryrun):
  """Entrypoint to running your algo, launching batchs..."""
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
  ctx.obj['incomplete_prefix_output_dir'] = (commit_ci_dir if commit_ci_dir else Path()) / batch_output_folder / platform / configuration
  ctx.obj['prefix_output_dir'] = ctx.obj['incomplete_prefix_output_dir'] / tuning_foldername(ctx.obj['batch_label'], hash_parameters(tuning_filepath))
  ctx.obj['dryrun'] = dryrun


@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('--input-path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.option('--output-path', type=PathType(), default=None, help='Custom output path. If not provided, defaults to ctx.obj["prefix_output_dir"] / input_path.parent / input_path.stem')
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def run(ctx, input_path, output_path, forwarded_args):
    """
    Runs over a given input/recording/test and computes various success metrics and outputs.
    """
    if not output_path:
        output_path = ctx.obj['prefix_output_dir'] / input_path.parent / input_path.stem
    else:
        output_path = (commit_ci_dir if commit_ci_dir else Path()) / output_path
    ctx.obj['input_path'] =  input_path
    ctx.obj['output_directory'] =  output_path
    ctx.obj['output_directory'].mkdir(parents=True, exist_ok=True)
    ctx.obj['forwarded_args'] = forwarded_args

    notify_qa_database(**ctx.obj, is_pending=True)

    try:
      runtime_metrics = entrypoint_module.run(ctx)
    except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      click.secho(f'[ERROR] The `run` function in {entrypoint} raised an exception:', fg='red', bold=True)
      click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', err=True)
      exit(1)

    metrics = postprocess_(runtime_metrics, ctx)
    print(metrics)

    if 'is_failed' not in metrics:
      click.secho("[ERROR] Please have the postprocessing return among its metrics `is_failed` (bool)", fg='red')
      exit(1)

    if metrics['is_failed']:
      click.secho('[ERROR] Your program seems to have crashed.', fg='red', err=True)
      click.secho('Either `metrics.json` is missing in the output directory, or your postprocessing set "{is_failed: true}".', dim=True, err=True)
      exit(1)


def postprocess_(runtime_metrics, context):
  """Computes computes various success metrics and outputs."""
  try:
    metrics = entrypoint_module.postprocess(runtime_metrics, context)
  except Exception as e:
    exc_type, exc_value, exc_traceback = sys.exc_info()
    click.secho(f'[ERROR] The `postprocess` function in {entrypoint} raised an exception:', fg='red', bold=True)
    click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red')
    metrics = {"is_failed": True}

  save_metrics(context.obj['output_directory'], **metrics)
  with (context.obj['output_directory']/'output.json').open('w') as f:
    json.dump({'output_type': context.obj['output_type']}, f)
  notify_qa_database(**context.obj, metrics=metrics)
  return metrics

@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.pass_context
@click.option('--input-path', required=True, type=PathType(), help='Path of the input/recording/test we should work on, relative to the database directory.')
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def postprocess(ctx, input_path, forwarded_args):
  """Run only the post-processing, assuming results already exist."""
  ctx.obj['input_path'] =  input_path
  ctx.obj['output_directory'] =  ctx.obj['prefix_output_dir'] / input_path.parent / input_path.stem
  ctx.obj['forwarded_args'] = forwarded_args
  postprocess_({}, ctx)



@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.option('--group', '-g', default=['small'], multiple=True, help="We run over all recordings in those groups")
@click.option('--groups-file', default=config['inputs']['groups'], help="YAML file listing groups of recordings selected from the database.")
@click.option('--tuning-search', help='string containing JSON describing the tuning parameters to explore')
@click.option('--no-wait', is_flag=True, help="If true, returns as soon as the jobs are send to LSF, otherwise waits for completion")
@click.option('--overwrite', is_flag=True, help="If true, replace existing outputs")
@click.option('--dryrun', is_flag=True, help="Only show the commands that would be executed")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
@click.pass_context
def batch(ctx, group, groups_file, tuning_search, no_wait, overwrite, dryrun, forwarded_args):
  """Run on all the inputs/tests/recordings in a given batch using the LSF cluster.
  Unless we ask to overwrite, we don't recompute already available results.
  """
  dryrun = ctx.obj['dryrun']

  running_jobs_names = running_lsf_job_names()
  def not_started(output_directory):
    is_done = (output_directory/'metrics.json').exists()
    is_pending = Job(output_directory).name in running_jobs_names
    return not (is_done or is_pending)

  jobs = []

  for input_path_abs, input_configuration in iter_recordings(group, groups_file, ctx.obj['database'], ctx.obj['configuration']):
    input_path = input_path_abs.relative_to(ctx.obj['database'])
    click.secho(str(input_path), fg='blue', bold=True)
    tuning_search_dict = json.loads(tuning_search) if tuning_search else None

    tuning_iterator = iter_parameters(tuning_search_dict)
    for tuning_file, tuning_hash, tuning_params in tuning_iterator:
      output_directory = ctx.obj['incomplete_prefix_output_dir'] / tuning_foldername(ctx.obj['batch_label'], tuning_hash) / input_path.parent / input_path.stem
      should_run = overwrite or not_started(output_directory)
      command = ' '.join([
          f"qa",
          f'--batch-label "{ctx.obj["batch_label"]}"',
          f'--platform "{ctx.obj["platform"]}"',
          f'--configuration "{input_configuration}"',
          f'--tuning-filepath "{tuning_file}"' if tuning_file else '',
          'run' if should_run else 'postprocess',
          f'--input-path "{input_path}"',
          ' '.join(forwarded_args),
      ])
      click.secho(command, dim=True)
      jobs.append(Job(output_directory, command, output_directory, Priority.LOW if tuning_file else Priority.NORMAL))
      if not dryrun:
        run_info = {
          **ctx.obj,
          "configuration": input_configuration,
          "input_path": input_path,
          "extra_parameters": tuning_params,
          "is_pending": True,
        }
        notify_qa_database(**run_info)

  for job in jobs:
    if dryrun: continue
    job.send()

  if not dryrun and not no_wait:
    tuning_search_hash = hashlib.md5(tuning_search.encode()).hexdigest() if tuning_search else ''
    name = f"{commit_id}--{tuning_search_hash}--{'|'.join(group)}-wait"
    wait = Job(name, 'echo "finished waiting for jobs on LSF."')
    wait.send(interactive=True, dependencies=jobs)


@cli.command()
def save_artifacts():
  """Save the results at a standard location"""
  import shutil
  import filecmp
  import os
  click.secho(str(commit_ci_dir), bold=True, underline=True)

  # default artifacts
  config['artifacts']['qatools.yaml'] = {"glob": 'qatools.yaml'}
  config['artifacts']['qatools'] = {"glob": 'qatools/*'}

  if not commit_ci_dir:
      click.secho(
          "You are not in a git repository, maybe in an artifacts folder. `check_bit_accuracy` is unavailable.",
          fg='yellow', dim=True)
      exit(1)

  for artifact_name, artifact_config in config['artifacts'].items():
    click.secho(f'Saving artifacts: {artifact_name}', bold=True)
    for path in Path('.').glob(artifact_config['glob']):
      if not path.is_file():
        continue
      destination = commit_ci_dir / path
      if destination.exists() and filecmp.cmp(str(path), str(destination), shallow=True):
        continue
      click.secho(str(path), dim=True)
      destination.parent.mkdir(parents=True, exist_ok=True)
      shutil.copy(str(path), str(destination))
      # we may want to do this for the parent folders also
      os.chmod(destination, 0o777)


@cli.command()
@click.option(
    "--reference-branch",
    default=f"origin/{config['project']['reference_branch']}",
)
def check_bit_accuracy(reference_branch):
    """
  Checks the bit accuracy of the results in the current ouput directory
  versus the latest commit on origin/develop.
  """
    from .utils import latest_commit
    from .config import commit_branch, repo
    from .bit_accuracy import assert_bit_accurate_to

    if config["project"]["type"] != "git":
        click.secho("Bit-accuracy tests are only supported for git-based projects", err=True)
        exit(1)

    if not repo:
        click.secho(
            "You are not in a git repository, maybe in an artifacts folder. `check_bit_accuracy` is unavailable.",
            fg='yellow', dim=True)

    if commit_branch not in [reference_branch, f"origin/{reference_branch}"]:
        assert assert_bit_accurate_to(
            latest_commit(reference_branch)
        ), "ERRROR: the bit-accuracy test has failed"

    # bit-accuracy on the reference branch is check on the commit's parents
    else:
        all_bit_accurate = True
        for commit_ref in reference_commit().parents:
            if not assert_bit_accurate_to(commit_ref):
                all_bit_accurate = False
        assert all_bit_accurate, "ERRROR: the bit-accuracy test has failed"




if __name__ == '__main__':
  cli(obj={}, auto_envvar_prefix='QATOOLS')
