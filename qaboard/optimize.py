import os
import sys
import uuid
import yaml
import json
import re
import datetime
import subprocess
from pathlib import Path

import click

from .api import makeNumpyEncoder, batch_info, notify_qa_database, print_url, matching_output
from .config import project, subproject, commit_id, outputs_commit, available_metrics, default_batches_files, default_platform
from .conventions import batch_dir
from .utils import PathType, getenvs
from .batch_logs import saves_logs, batch_log, run_in_log
from .run import RunContext

seed = int(os.environ.get('QA_SEED', 101))


@click.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.option('--batch', '-b', 'batches', required=True, multiple=True, help="Use the inputs+configs+database in those batches")
@click.option('--batches-file', 'batches_files', default=default_batches_files, multiple=True, help="YAML file listing batches of inputs+config+database selected from the database.")
@click.option('--config-file', required=True, type=PathType(), help="YAML file with the search space, the objective and the number of evaluations.")
@click.option('--checkpoint', type=PathType(), help="Where to save the search, to resume it if it's interrupted. Default: in the batch's directory.")
@click.option('--parallel-param-sampling', type=int, help="How many parameter sets to evaluate at the same time (default: `parallel_sampling` in the config, or 1).")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
@click.pass_context
@saves_logs
def optimize(ctx, batches, batches_files, config_file, checkpoint, parallel_param_sampling, forwarded_args):
  """
  Search for the parameters that optimize your metrics.
  Each evaluation runs `qa batch` with the label <label>|iter<N>, the best one's runs end up in <label>.
  """
  import random
  random.seed(seed)
  import numpy as np
  np.random.seed(seed)

  log = batch_log(ctx)
  command_id = os.environ.get('QA_BATCH_COMMAND_ID', log['command_id'] if log else str(uuid.uuid4())) # unique IDs for triggered runs makes it easier to wait/cancel them 
  command_data = {
    "command_created_at_datetime":  datetime.datetime.utcnow().isoformat(),
    "argv": sys.argv,
    **ctx.obj,
  }
  if log:
    command_data['log'] = log['path'] # relative to the batch directory
  job_url = getenvs(('BUILD_URL', 'CI_JOB_URL', 'CIRCLE_BUILD_URL', 'TRAVIS_BUILD_WEB_URL')) # jenkins, gitlabCI, cirlceCI, travisCI
  if job_url:
    command_data['job_url'] = job_url
  command={command_id: command_data}
  # Each iteration runs `qa batch`: they are part of this command (and never send QA_NOTIFY emails)
  from .notify import inherit_root_command
  inherit_root_command(ctx, os.environ.get('QA_BATCH_ROOT_COMMAND_ID') or command_id)

  batch_dir_for = lambda label: batch_dir(outputs_commit, label, save_with_ci=True)
  optim_dir = batch_dir_for(ctx.obj['batch_label'])
  optim_dir.mkdir(parents=True, exist_ok=True)
  os.environ["QA_OPTIM_DIR"] = str(optim_dir)

  ctx.obj['batches'] = batches
  ctx.obj['batches_files'] = batches_files
  ctx.obj['forwarded_args'] = forwarded_args
  print_url(ctx)

  from shutil import rmtree
  from .api import aggregated_metrics
  from .optimization import describe_search_space, parse_solver, run_optimization, sampler_name, study_summary

  try:
    setup = init_optimization(config_file, checkpoint or optim_dir / 'optuna-journal.log', ctx, parallel_param_sampling)
  except (ValueError, ImportError) as e:
    raise click.ClickException(str(e))
  objective, study, distributions, options, optim_config, dim_mapping = setup
  metric_names = options['objective_metrics']
  pareto = options['pareto']

  # What the web app shows about the search
  def update_batch(**data):
    notify_qa_database(object_type='batch', command=command, **ctx.obj, data={"optimization": True, **data})

  # trials left by an interrupted run keep their numbers: new iterations come after them
  previous_trials = len(study.trials)
  progress = {"iteration": max(1, previous_trials)}
  update_batch(
    # the server cleans up the iterations up to this one
    iteration=progress["iteration"],
    iterations=options['evaluations'],
    optimization_status="running",
    optimization_started_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
    optimization_config={
      "search_space": describe_search_space(distributions),
      "objective": {m: {k: v for k, v in (optim_config['objective'][m] or {}).items() if k in ('weight', 'loss', 'reduce', 'margin')} for m in metric_names},
      "pareto": pareto,
      "sampler": sampler_name(study),
      # the first evaluations try random parameters
      "n_startup_trials": parse_solver(optim_config.get('solver'))['n_startup_trials'],
      "parallel_sampling": options['parallel_sampling'],
      "early_stopping": options['patience'],
      "preset_params": optim_config.get('preset_params') or {},
      # to continue the search from the web app: the same config and batches, a bigger budget
      "config": optim_config,
      "batches": list(batches),
    },
    **study_summary(study, metric_names if pareto else None),
  )
  if previous_trials:
    click.secho(f"Resuming: {previous_trials} evaluations were already done", fg='blue', bold=True)

  def on_trial(trial_number, params, losses, loss, is_best):
    """Reports a finished evaluation to QA-Board, in iteration order (see run_optimization)."""
    iteration = trial_number + 1
    progress["iteration"] = iteration
    failed = losses is None
    iteration_batch_label = f"{ctx.obj['batch_label']}|iter{iteration}"
    iteration_batch_dir = batch_dir_for(iteration_batch_label)
    try:
      aggregated_metrics_ = aggregated_metrics(iteration_batch_label, metrics=tuple(metric_names))
    except Exception:
      # a failed evaluation may have no results to aggregate: that must not stop the search
      aggregated_metrics_ = {}
    if failed:
      click.secho(f'Iteration {iteration} failed: its runs are kept, check their logs', fg='red')
    elif is_best:
      click.secho(f'New best @iteration{iteration}: {loss}', fg='green')
    try:
      notify_qa_database(**{
        **ctx.obj,
        **{
          "extra_parameters": dim_mapping(params),
          # TODO: we really should to tuning/platform in make_batch_conf_dir
          #       1. make change, 2. rename existing folders)
          "output_directory": iteration_batch_dir,
          'input_path': '|'.join(batches),
          # we want to show in the summary tab the best results for the tuning experiment
          # but in the exploration see the results per iteration....
          "input_type": 'optim_iteration', # or... single ? don't show them in the UI
          "is_pending": False,
          "is_failed": failed,
          "metrics": {
            "iteration": iteration,
            **({} if failed else {"objective": loss}),
            **aggregated_metrics_,
          },
        },
      }, command=command)
      update_batch(
        iteration=iteration,
        iteration_label=iteration_batch_label,
        **({
          "is_best_iter": True,
          "best_params": dim_mapping(params),
          "keep_all_best_iters": optim_config.get("keep_all_best_iters"),
          "best_metrics": {
            "objective": loss,
            **aggregated_metrics_,
          },
        } if is_best else {}),
        **study_summary(study, metric_names if pareto else None),
      )
    except Exception as e:
      click.secho(f"WARNING: could not update QA-Board for iteration {iteration}: {e}", fg='yellow', err=True)
    if not is_best and not failed:
      # We remove the results to make sure we don't waste disk space
      # It is also be done server-side...
      # Failed iterations are kept: their logs explain what went wrong.
      print(f"RM {iteration_batch_dir}")
      rmtree(iteration_batch_dir, ignore_errors=True)

  status = "interrupted"
  try:
    summary = run_optimization(
      study,
      distributions,
      objective,
      evaluations=options['evaluations'],
      parallel_sampling=options['parallel_sampling'],
      patience=options['patience'],
      metric_names=metric_names if pareto else None,
      on_trial=on_trial,
      log=lambda message: click.secho(message, fg='blue'),
    )
    status = "stopped_early" if summary["early_stopped"] else "done"
    if best_objective(study) is None:
      status = "failed"
  finally:
    try:
      update_batch(
        iteration=progress["iteration"],
        optimization_status=status,
        optimization_ended_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **study_summary(study, metric_names if pareto else None),
      )
    except Exception as e:
      click.secho(f"WARNING: could not update QA-Board: {e}", fg='yellow', err=True)

  if status == "failed":
    raise click.ClickException("qa optimize: no evaluation succeeded. Check the logs of the iterations' runs.")
  if summary['early_stopped']:
    click.secho(f"Stopped early after {summary['finished']} evaluations.", fg='blue', bold=True)
  click.secho(f"Best objective: {best_objective(study)}", fg='green', bold=True)
  if pareto:
    click.secho(f"Pareto front: {len(study.best_trials)} trade-offs", fg='green', bold=True)
    for t in sorted(study.best_trials, key=lambda t: t.number):
      losses = ', '.join(f'{name}: {value:.6g}' for name, value in zip(metric_names, t.values))
      click.secho(f"  iteration {t.number+1}: {losses}  {dim_mapping(t.params)}", fg='green')
  else:
    click.secho(f"Best parameters: {dim_mapping(study.best_params)}", fg='green')


def best_objective(study):
  """
  Best (summed) objective value so far, or None if no evaluation succeeded yet.
  `study.best_value` raises when every trial failed, and failures are expected here:
  a single batch that does not compute its metrics should not stop the whole search.
  """
  from optuna.trial import TrialState
  values = [sum(t.values) for t in study.trials if t.state == TrialState.COMPLETE]
  return min(values) if values else None


def init_optimization(optim_config_file, checkpoint, ctx, parallel_param_sampling=None):
  from .optimization import check_resumable, make_storage, make_study, parse_options, parse_search_space, parse_solver

  with optim_config_file.open('r') as f:
    optim_config = yaml.load(f, Loader=yaml.SafeLoader)
  options = parse_options(optim_config)
  if parallel_param_sampling:
    options['parallel_sampling'] = parallel_param_sampling
  distributions = parse_search_space(optim_config.get('search_space'))
  parse_solver(optim_config.get('solver'))
  preset_params = optim_config.get('preset_params') or {}
  # wrong metrics would only fail after the first evaluation, maybe hours later
  check_objective(optim_config['objective'])

  click.secho("Search space:", fg="blue", err=True)
  for name, distribution in distributions.items():
    click.secho(f"  {name}: {distribution}", fg="blue", dim=True, err=True)
  if preset_params:
    click.secho("Preset parameters:", fg="blue", err=True)
    click.secho(str(preset_params), fg="blue", dim=True, err=True)

  def objective(opt_params, trial_number):
    """
    Runs a batch with the suggested parameters, and returns the loss of each metric of the objective.
    Returns None if they could not be computed: the evaluation counts as failed, and the search goes on.
    """
    iteration = trial_number + 1
    params = {**preset_params, **opt_params}
    batch_label = f"{ctx.obj['raw_batch_label']}|iter{iteration}"
    command = ' '.join([
      'qa',
      f"--label '{batch_label}'",
      f'--share' if ctx.obj["share"] else '',
      f'--offline' if ctx.obj['offline'] else '',
      f'--platform "{ctx.obj["platform"]}"' if ctx.obj['platform'] != default_platform else '',
      f"--configuration '{ctx.obj['configuration']}'" if ctx.params.get('configurations') else '',
      f"--tuning '{json.dumps(params, sort_keys=True, cls=makeNumpyEncoder())}'",
      'batch',
      ' '.join([f'--batches-file "{b}"' for b in ctx.obj["batches_files"]]),
      ' '.join([f'"{b}"' for b in ctx.obj["batches"]]),
      # we notably forward --batch
      ' '.join(ctx.obj["forwarded_args"]),
    ])
    click.secho(command, fg="blue")
    import re
    command = re.sub('^qa', 'python -m qaboard', command) # helps make sure we run the right thing when testing 
    if str(subproject) != '.':
      command = f"cd {subproject} && {command}"

    if not ctx.obj['dryrun']:
      if batch_log(ctx):
        # The iterations don't save their own logs, they would be lost with their batches
        returncode = run_in_log(command)
      else:
        returncode = subprocess.run(
            command,
            shell=True,
            encoding="utf-8",
        ).returncode
      if returncode != 0:
        click.secho(f'[ERROR ({returncode})] Check the logs in QA-Board to know what output failed', fg='red', bold=True)

    # Now that we finished computing all the results, we will download the results and
    # compute the objective function:
    shared_batch_label = f"{ctx.obj['batch_label']}|iter{iteration}"
    try:
      return batch_objective_components(project, commit_id, shared_batch_label, optim_config['objective'])
    except Exception as e:
      click.secho(f"[ERROR] Iteration {iteration}: could not compute the objective: {e}", fg='red', bold=True)
      return None

  # The search is saved as it goes: running the same experiment again resumes it
  checkpoint = Path(checkpoint)
  if checkpoint.suffix == '.pkl':
    # Older QA-Board servers and docs give scikit-optimize's pickle (e.g. checkpoint.pkl): we can't resume
    # from it, but we save next to it (e.g. checkpoint.optuna.log), and the same command resumes later.
    checkpoint = checkpoint.with_suffix('.optuna.log')
  if not options['resume'] and checkpoint.exists():
    click.secho(f"Starting over (resume: false): removing {checkpoint}", fg='blue', err=True)
    checkpoint.unlink()
  if checkpoint.exists() and checkpoint.stat().st_size > 0:
    with checkpoint.open('rb') as f:
      if f.read(1) != b'{':
        raise ValueError(
          f"{checkpoint} was saved by an older qa optimize, which QA-Board can't resume from. "
          "Remove it, or give another --checkpoint, to start over."
        )
  checkpoint.parent.mkdir(parents=True, exist_ok=True)
  n_objectives = len(options['objective_metrics']) if options['pareto'] else 1
  study = make_study(
    {**(optim_config.get('solver') or {})},
    storage=make_storage(checkpoint),
    n_objectives=n_objectives,
    parallel_sampling=options['parallel_sampling'],
  )
  reason = check_resumable(study, {
    "objective": optim_config['objective'],
    "pareto": options['pareto'],
    "search_space": optim_config['search_space'],
  })
  if reason:
    raise ValueError(reason)

  # `ask` gives us only the parameters being optimized,
  # this wrapper adds back the parameters set to fixed values
  def dim_mapping(opt_params):
    return {**preset_params, **opt_params}

  return objective, study, distributions, options, optim_config, dim_mapping


# The objective's `loss` and `reduce` options, see make_loss and make_reduce
LOSSES = r'(square_)?(relu_)?(identity|shift|relative)'
REDUCES = r'sum|relu|l\d'


def check_objective(config_objective):
  """Raises if a metric of the objective can't be computed, before running anything."""
  for metric, options in config_objective.items():
    if metric == 'target':
      continue
    options = options or {}
    make_loss(metric, options)
    loss = options.get('loss', 'identity')
    if not re.fullmatch(LOSSES, str(loss)):
      raise ValueError(f"`objective.{metric}.loss` is `{loss}`, expected identity, shift or relative, optionally as relu_X, square_X or square_relu_X.")
    reduce = options.get('reduce', 'sum')
    if not re.fullmatch(REDUCES, str(reduce)):
      raise ValueError(f"`objective.{metric}.reduce` is `{reduce}`, expected sum, relu, l1 or l2.")
    target = config_objective.get('target') or {}
    compares_to_target = 'shift' in loss or 'relative' in loss
    if compares_to_target and not ('id' in target or 'branch' in target or 'tag' in target):
      if (available_metrics.get(metric) or {}).get('target') is None:
        raise ValueError(
          f"`objective.{metric}.loss: {loss}` compares {metric} to a target, and {metric} has none in your metrics file "
          "(outputs.metrics in qaboard.yaml). Add one, or compare to a reference batch with `objective.target`."
        )


relu = lambda x: x if x > 0 else 0

def make_loss(metric, options):
  """
  Return a loss function of the form: loss(metric, metric_target)
  """
  loss = options.get('loss', 'identity')
  from .gate import smaller_is_better as direction
  smaller_is_better = direction(metric, available_metrics, None)
  if smaller_is_better is None:
    raise ValueError(
      f"qa optimize: declare whether smaller values of {metric} are better in your metrics file (outputs.metrics in qaboard.yaml), "
      f"with `smaller_is_better`, so that it knows what to minimize"
    )
  sign_inversion = (1 if smaller_is_better else -1)
  if loss == 'identity':
    loss_inner = lambda x, x_t: x * sign_inversion
  elif 'shift' in loss:
    loss_inner = lambda x, x_t: (x - x_t) * sign_inversion
  elif 'relative' in loss:
    loss_inner = lambda x, x_t: (x - x_t) / x_t * sign_inversion

  if 'relu' in loss:
    margin = options.get('margin', 0.0)
    return lambda x, x_t: relu(loss_inner(x, x_t) + margin)
  if 'square' in loss:
    return lambda x, x_t: loss_inner(x, x_t)**2
  return loss_inner


def make_reduce(options):
  """
  Return a reduce/aggregation function used to aggregate many losses from different tests into a single number.
  We normalize by the number of outputs to make it more easily human-understandable.
  """
  reduce_type =  options.get('reduce', 'sum')
  if reduce_type == 'sum':
    return lambda x: sum(x) / len(x)
  if reduce_type == 'relu':
    return lambda x: relu(sum(x)) / len(x)
  if len(reduce_type) == 2:
    from numpy.linalg import norm
    return lambda x: norm(x, ord=int(reduce_type[1])) / len(x)

def batch_objective_components(project, commit_id, batch_label, config_objective):
  """
  The loss of each metric of the objective for a batch, as {metric: weight * reduced loss}.
  The objective is their sum; with `pareto: true` each is optimized on its own.
  """
  metrics = [m for m in config_objective.keys() if m != 'target']
  this_batch_info = batch_info(
    reference=commit_id,
    is_branch=False,
    batch=batch_label,
    project=project,
    metrics=metrics,
  )
  # We can compare to KPI quality target defined
  if 'target' in config_objective and config_objective['target']:
    target = config_objective['target']
    use_default_targets = not 'id' in target and not 'branch' in target
    # or get reference results from historical data
    if not use_default_targets:
      target_batch_info = batch_info(
        target.get('id', target.get('branch', target.get('tag', ''))),
        batch=target.get('batch', 'default'),
        is_branch='branch' in target, # for tag we need special care...
        # the working directory changed...
        project=project,
        metrics=metrics,
      )
  else:
    use_default_targets = True

  components = {}
  for metric, options in config_objective.items():
    if metric == 'target': # this is a special key, not a metric 
      continue
    if options is None:
      options = {}
    loss_name = options.get('loss', 'identity')
    loss = make_loss(metric, options)
    losses = []
    for output in this_batch_info['outputs'].values():
      if 'target' in config_objective and ('shift' in loss_name or 'relative' in loss_name):
        if use_default_targets:
          metric_target = (available_metrics.get(metric) or {}).get('target')
          if metric_target is None:
            raise ValueError(f"qa optimize: {metric} has no target in your metrics file (outputs.metrics in qaboard.yaml)")
        else:
          output_target = matching_output(RunContext.from_api_output(output), target_batch_info['outputs'].values())
          if not output_target:
            raise ValueError(f"Could not find an output for {output['test_input_path']} in the target batch")
          metric_target = output_target['metrics'][metric]
      else:
        metric_target = None
      if output['metrics'].get('is_failed'):
        click.secho('Failed output', fg='red')        
        click.secho(output['output_dir_url'][2:], fg='red')
      else:
        try:
          losses.append(loss(output['metrics'][metric], metric_target) )
        except Exception:
          click.secho(f'Could not find {metric}', fg='red')        
          click.secho(output['output_dir_url'][2:], fg='red')
    if not losses:
      raise ValueError(f"Could not compute the loss function!")
    partial_objective = make_reduce(options)(losses)
    components[metric] = float(options.get('weight', 1) * partial_objective)
  return components


def batch_objective(project, commit_id, batch_label, config_objective):
  """The objective of a batch: the sum of its metrics' losses"""
  return sum(batch_objective_components(project, commit_id, batch_label, config_objective).values())
