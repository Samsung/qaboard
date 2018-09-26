#!/usr/bin/env python
"""
CLI tool to runs various tasks related to QA.
"""
import sys
import os
import errno
import json
import yaml
import importlib
from pathlib import Path
from traceback import format_exception

import click

from .lsf import Job, running_lsf_job_names, Priority, killJobs
from .utils import make_prefix_outputs_path, load_tuning_search
from .utils import save_metrics, notify_qa_database, iter_parameters, iter_recordings
from .utils import PathType
from .utils import make_hash

# The `init` command is implemented in config.py
# it helps avoiding try/catch on the import and providing lots of NA values
from .config import database, platform, config, commit_id, commit_ci_dir, repo, is_ci, commit_ci_postfix

entrypoint = Path(config['project']['entrypoint'])
try:
    # https://docs.python.org/3/library/importlib.html#importing-a-source-file-directly
    sys.path.append(str(entrypoint.parent)) # for imports from within the entrypoint's directory
    spec = importlib.util.spec_from_file_location('entrypoint', entrypoint)
    entrypoint_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(entrypoint_module)
except Exception as e:
    import traceback
    exc_type, exc_value, exc_traceback = sys.exc_info()
    click.secho(f'ERROR: Error importing the entrypoint ({entrypoint}).', fg='red', err=True)
    click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', dim=True)
    click.secho(
        f'{entrypoint} must implement both `run` and `postprocess` functions.\n'
        'Please read the tutorial, and ask @arthurf for help\n'
        'http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial',
        dim=True, err=True)
    exit(1)


# we want open permissions on outputs and artifacts
# it makes collaboration among mutliple users / automated tools so much easier...
os.umask(0)


@click.group()
@click.pass_context
@click.option('--platform', default=platform)
@click.option('--configuration', default=config['inputs']['configuration'], help="Load an additional partial configurations (eg $configuration.json).")
@click.option('--batch-label', default='default', help="Gives tuning experiments a name.")
@click.option('--tuning-filepath', type=PathType(), default=None, help="File with extra parameters for tuning")
@click.option('--dryrun', is_flag=True, help="Only show the commands that would be executed")
@click.option('--no-qa-database', is_flag=True, help="Do not notify the QA database about what is pending/running/done...")
def cli(ctx, platform, configuration, batch_label, tuning_filepath, dryrun, no_qa_database):
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
  if tuning_filepath:
    ctx.obj['tuning_filepath'] = tuning_filepath
    with tuning_filepath.open('r') as f:
      if tuning_filepath.suffix == '.yaml':
        ctx.obj['extra_parameters'] = yaml.load(f)
      else:
        ctx.obj['extra_parameters'] = json.load(f)
  # batch runs will override this since batches may have different configurations
  ctx.obj['prefix_output_dir'] = make_prefix_outputs_path(commit_ci_dir, batch_label, platform, configuration, tuning_filepath)
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
        output_path = ctx.obj['prefix_output_dir'] / input_path.parent / input_path.stem
    else:
        output_path = commit_ci_dir / output_path
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
@click.option('--output-path', type=PathType(), default=None, help='Custom output directory path. If not provided, defaults to ctx.obj["prefix_output_dir"] / input_path.parent / input_path.stem')
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
def run(ctx, input_path, output_path, forwarded_args):
    """
    Runs over a given input/recording/test and computes various success metrics and outputs.
    """
    if not output_path:
        output_path = ctx.obj['prefix_output_dir'] / input_path.parent / input_path.stem
    else:
        output_path = commit_ci_dir / output_path
    ctx.obj['input_path'] =  input_path
    ctx.obj['output_directory'] =  output_path
    ctx.obj['output_directory'].mkdir(parents=True, exist_ok=True)
    ctx.obj['forwarded_args'] = forwarded_args
    if not ctx.obj['no_qa_database']:
        notify_qa_database(**ctx.obj, is_pending=True, is_running=True)

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
  if not context.obj['no_qa_database']:
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
    output_path = ctx.obj['prefix_output_dir'] / input_path.parent / input_path.stem
  else:
    output_path = commit_ci_dir / output_path
  ctx.obj['input_path'] =  input_path
  ctx.obj['output_directory'] =  output_path
  ctx.obj['forwarded_args'] = forwarded_args
  postprocess_({}, ctx)



@cli.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.option('--group', '-g', default=['small'], multiple=True, help="We run over all recordings in those groups")
@click.option('--groups-file', default=config['inputs']['groups'], help="YAML file listing groups of recordings selected from the database.")
@click.option('--tuning-search', help='string containing JSON describing the tuning parameters to explore')
@click.option('--tuning-search-file', type=PathType(), default=None, help='tuning file describing the tuning parameters to explore')
@click.option('--no-wait', is_flag=True, help="If true, returns as soon as the jobs are send to LSF, otherwise waits for completion")
@click.option('--overwrite', is_flag=True, help="If true, replace existing outputs")
@click.option('--prefix-outputs-path', type=PathType(), default=None, help='Custom prefix for the outputs; they will be at $prefix/$output_path')
@click.option('--return-prefix-outputs-path', is_flag=True, help="Only print the prefixes for the results of each batch we run an")
@click.option('--dryrun', is_flag=True, help="Only show the commands that would be executed")
@click.option('--no-batch-qa-database', is_flag=True, help="Do not notify the qa database before sending jobs.")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
@click.pass_context
def batch(ctx, group, groups_file, tuning_search, tuning_search_file, no_wait, overwrite, prefix_outputs_path, return_prefix_outputs_path, dryrun, no_batch_qa_database, forwarded_args):
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

  tuning_search_dict, filetype = load_tuning_search(tuning_search, tuning_search_file)

  for input_path_abs, input_configuration in iter_recordings(group, groups_file, ctx.obj['database'], ctx.obj['configuration'], config):
    input_path = input_path_abs.relative_to(ctx.obj['database'])
    click.secho(str(input_path), fg='blue', bold=True, err=True)

    tuning_iterator = iter_parameters(tuning_search_dict, filetype=filetype)
    for tuning_file, tuning_hash, tuning_params in tuning_iterator:
      if not prefix_outputs_path:
          prefix_output_dir = make_prefix_outputs_path(commit_ci_dir, ctx.obj['batch_label'], ctx.obj["platform"], input_configuration, tuning_file)
      else:
          prefix_output_dir = commit_ci_dir / prefix_outputs_path
          if tuning_file:
              prefix_output_dir = prefix_output_dir / Path(tuning_file).stem
      output_directory = prefix_output_dir / input_path.parent / input_path.stem
      if return_prefix_outputs_path:
        print(output_directory)
        break

      should_run = overwrite or not_started(output_directory)
      command = ' '.join([
          f"qa",
          f'--batch-label "{ctx.obj["batch_label"]}"',
          f'--platform "{ctx.obj["platform"]}"',
          f'--no-qa-database' if ctx.obj['no_qa_database'] else '',
          f'--configuration "{input_configuration}"',
          f'--tuning-filepath "{tuning_file}"' if tuning_file else '',
          'run' if should_run else 'postprocess',
          f'--input-path "{input_path}"',
          f'--output-path "{output_directory}"',
          ' '.join(forwarded_args),
      ])
      click.secho(command, dim=True, err=True)
      priority = Priority.LOW if tuning_params else Priority.NORMAL
      jobs.append(Job(batch_hash[:10] + str(output_directory), command, output_directory, priority))
      if not dryrun:
        run_info = {
          **ctx.obj,
          "configuration": input_configuration,
          "input_path": input_path,
          "extra_parameters": tuning_params,
          "is_pending": True,
        }
        if not ctx.obj['no_qa_database'] and not no_batch_qa_database:
            notify_qa_database(**run_info)

  wildcard_job = [Job(batch_hash[:10] + "*")]
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
            wait.send(interactive=True, dependencies=wildcard_job)
  except:
      killJobs(wildcard_job, on_lsf = True)


@cli.command()
def save_artifacts():
  """Save the results at a standard location"""
  import shutil
  import filecmp

  click.secho(str(commit_ci_dir), bold=True, underline=True)

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
    for path in Path('.').glob(artifact_config['glob']):
      if not path.is_file():
        continue
      destination = commit_ci_dir / path
      if destination.exists() and filecmp.cmp(str(path), str(destination), shallow=True):
        continue
      click.secho(str(path), dim=True)
      destination.parent.mkdir(parents=True, exist_ok=True)
      shutil.copy(str(path), str(destination))
      # we already use umask 0, but just to be sure, we set the permissions to be open
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
            latest_commit(repo, reference_branch)
        ), "ERRROR: the bit-accuracy test has failed"

    # bit-accuracy on the reference branch is check on the commit's parents
    else:
        all_bit_accurate = True
        for commit_ref in reference_commit().parents:
            if not assert_bit_accurate_to(commit_ref):
                all_bit_accurate = False
        assert all_bit_accurate, "ERRROR: the bit-accuracy test has failed"


def main():
  cli(obj={}, auto_envvar_prefix='QATOOLS')

if __name__ == '__main__':
  main()