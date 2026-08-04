import os
import sys
import uuid
import yaml
import json
import datetime
import subprocess

import click

from .api import NumpyEncoder, batch_info, notify_qa_database, print_url, matching_output
from .config import project, subproject, commit_id, outputs_commit, available_metrics, default_batches_files, default_platform
from .conventions import batch_dir
from .utils import PathType, getenvs
from .run import RunContext
from .optimization import make_plots, make_study, parse_options, parse_search_space, run_optimization



@click.command(context_settings=dict(
    ignore_unknown_options=True,
))
@click.option('--batch', '-b', 'batches', required=True, multiple=True, help="Use the inputs+configs+database in those batches")
@click.option('--batches-file', 'batches_files', default=default_batches_files, multiple=True, help="YAML file listing batches of inputs+config+database selected from the database.")
@click.option('--config-file', required=True, type=PathType(), help="YAML search space configuration file.")
@click.option('--parallel-param-sampling', type=int, help="Parallel paramater sampling.")
@click.argument('forwarded_args', nargs=-1, type=click.UNPROCESSED)
@click.pass_context
def optimize(ctx, batches, batches_files, config_file, parallel_param_sampling, forwarded_args):
  command_id = os.environ.get('QA_BATCH_COMMAND_ID', str(uuid.uuid4())) # unique IDs for triggered runs makes it easier to wait/cancel them
  command_data = {
    "command_created_at_datetime":  datetime.datetime.utcnow().isoformat(),
    "argv": sys.argv,
    **ctx.obj,
  }
  job_url = getenvs(('BUILD_URL', 'CI_JOB_URL', 'CIRCLE_BUILD_URL', 'TRAVIS_BUILD_WEB_URL')) # jenkins, gitlabCI, cirlceCI, travisCI
  if job_url:
    command_data['job_url'] = job_url
  command={command_id: command_data}

  batch_dir_for = lambda label: batch_dir(outputs_commit, label, save_with_ci=True)
  optim_dir = batch_dir_for(ctx.obj['batch_label'])
  optim_dir.mkdir(parents=True, exist_ok=True)

  ctx.obj['batches'] = batches
  ctx.obj['batches_files'] = batches_files
  ctx.obj['forwarded_args'] = forwarded_args
  print_url(ctx)

  from shutil import rmtree
  from .api import aggregated_metrics
  objective, study, distributions, options, optim_config, dim_mapping = init_optimization(config_file, ctx, optim_dir)
  if parallel_param_sampling:
    options['parallel_sampling'] = parallel_param_sampling

  pareto = options['pareto']
  metric_names = options['objective_metrics']

  def on_trial(trial_number, params, components, scalar, is_best):
    """Report one finished evaluation to QA-Board. Runs under the search loop's lock."""
    failed = components is None
    iteration_batch_label = f"{ctx.obj['batch_label']}|iter{trial_number+1}"
    iteration_batch_dir = batch_dir_for(iteration_batch_label)
    try:
      aggregated_metrics_ = aggregated_metrics(iteration_batch_label, metrics=tuple(metric_names))
    except Exception:
      # a failed trial may not have any results to aggregate: that must not stop the search
      aggregated_metrics_ = {}
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
            "iteration": trial_number+1,
            **({} if failed else {"objective": scalar}),
            **aggregated_metrics_,
          },
        },
      }, command=command)

      if is_best:
        click.secho(f'New best @iteration{trial_number+1}: {scalar}', fg='green')

      is_best_data = {
        "is_best_iter": True,
        "best_params": dim_mapping(params),
        "best_metrics": {
          "objective": scalar,
          **aggregated_metrics_,
        },
      } if is_best else {}

      if pareto:
        # the current front, so the UI can show the trade-offs, not just one winner
        front = [
          {"iteration": t.number+1, "params": dim_mapping(t.params), "objectives": dict(zip(metric_names, t.values))}
          for t in study.best_trials
        ]
      notify_qa_database(
        object_type='batch',
        command=command,
        **ctx.obj,
        **{"data": {
            "optimization": True,
            "iteration": trial_number+1,
            "iteration_label": iteration_batch_label,
            **({"pareto_front": front} if pareto else {}),
            **is_best_data,
        }},
      )
    except Exception as e:
      click.secho(f"WARNING: could not update QA-Board for iteration {trial_number+1}: {e}", fg='yellow', err=True)

    make_plots(study, optim_dir, metric_names=metric_names if pareto else None)
    if not is_best and not failed:
      # We remove the results to make sure we don't waste disk space
      # It is also be done server-side...
      # Failed iterations are kept: their logs explain what went wrong.
      print(f"RM {iteration_batch_dir}")
      rmtree(iteration_batch_dir, ignore_errors=True)

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

  if summary['early_stopped']:
    click.secho(f"Stopped early after {summary['finished']} evaluations.", fg='blue', bold=True)
  if best_objective(study) is None:
    click.secho("No evaluation succeeded, there is nothing to report.", fg='red', bold=True)
    return
  if pareto:
    click.secho(f"Pareto front: {len(study.best_trials)} trade-offs", fg='green', bold=True)
    for t in study.best_trials:
      objectives = ', '.join(f'{name}: {value:.6g}' for name, value in zip(metric_names, t.values))
      click.secho(f"  iteration {t.number+1}: {objectives}", fg='green')
      click.secho(f"    {dim_mapping(t.params)}", fg='green', dim=True)
  else:
    click.secho(f"Best objective: {study.best_value}", fg='green', bold=True)
    click.secho(f"Best parameters: {dim_mapping(study.best_params)}", fg='green')

  # tuning plots are saved in the label directory
  make_plots(study, optim_dir, metric_names=metric_names if pareto else None)




def best_objective(study):
  """
  Best (summed) objective value so far, or None if no evaluation succeeded yet.
  `study.best_value` raises when every trial failed, and failures are expected here:
  a single batch that does not compute its metrics should not abort the whole search.
  """
  from optuna.trial import TrialState
  values = [sum(t.values) for t in study.trials if t.state == TrialState.COMPLETE]
  return min(values) if values else None


def init_optimization(optim_config_file, ctx, optim_dir):
  with optim_config_file.open('r') as f:
    optim_config = yaml.load(f, Loader=yaml.SafeLoader)

  # default settings
  optim_config = {
    "solver": {},
    "search_space": {},
    "preset_params": {},
    **optim_config,
  }
  options = parse_options(optim_config)
  distributions = parse_search_space(optim_config['search_space'])
  preset_params = optim_config.get('preset_params', {})
  click.secho("Search space:", fg="blue", err=True)
  for name, distribution in distributions.items():
    click.secho(f"  {name}: {distribution}", fg="blue", dim=True, err=True)
  click.secho("Preset parameters:", fg="blue", err=True)
  click.secho(str(preset_params), fg="blue", dim=True, err=True)

  def objective(opt_params, iteration):
    """
    Run a batch with the suggested parameters, and return the objective value of each
    metric, as {metric: value}. Returns None if the objective could not be computed, so
    the caller can mark the trial as failed instead of losing the whole optimization run.
    """
    params = {**preset_params, **opt_params}

    batch_label = f"{ctx.obj['raw_batch_label']}|iter{iteration+1}"
    command = ' '.join([
      'qa',
      f"--label '{batch_label}'",
      f'--share' if ctx.obj["share"] else '',
      f'--offline' if ctx.obj['offline'] else '',
      f'--platform "{ctx.obj["platform"]}"' if ctx.obj['platform'] != default_platform else '',
      f"--configuration '{ctx.obj['configuration']}'" if ctx.params.get('configurations') else '',
      f"--tuning '{json.dumps(params, sort_keys=True, cls=NumpyEncoder)}'",
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
      p = subprocess.run(
          command,
          shell=True,
          encoding="utf-8",
      )
      if p.returncode != 0:
        click.secho(f'[ERROR ({p.returncode})] Check the logs in QA-Board to know what output failed', fg='red', bold=True)

    # Now that we finished computing all the results, we will download the results and
    # compute the objective function:
    shared_batch_label = f"{ctx.obj['batch_label']}|iter{iteration+1}"
    try:
      return batch_objective_components(project, commit_id, shared_batch_label, optim_config['objective'])
    except Exception as e:
      click.secho(f"[ERROR] Could not compute the objective at iteration {iteration+1}: {e}", fg='red', bold=True)
      return None

  # Results are stored on disk: re-running the same experiment resumes where it left off
  storage_path = optim_dir / 'optuna.db'
  if not options['resume'] and storage_path.exists():
    click.secho(f"Restarting from scratch (resume: false): removing {storage_path}", fg='blue', err=True)
    storage_path.unlink()
  n_objectives = len(options['objective_metrics']) if options['pareto'] else 1
  study = make_study(optim_config['solver'], storage=f"sqlite:///{storage_path}", n_objectives=n_objectives)
  try:
    study.set_metric_names(options['objective_metrics'] if options['pareto'] else ['objective'])
  except Exception:
    pass
  if len(study.trials):
    click.secho(f"Resuming: {len(study.trials)} trials already in {storage_path}", fg='blue', bold=True, err=True)

  # `ask` gives us only the parameters being optimized,
  # this wrapper adds back the parameters set to fixed values
  def dim_mapping(opt_params):
    return {**preset_params, **opt_params}

  return objective, study, distributions, options, optim_config, dim_mapping




relu = lambda x: x if x > 0 else 0

def make_loss(metric, options):
  """
  Return a loss function of the form: loss(metric, metric_target)
  """
  loss = options.get('loss', 'identity')
  smaller_is_better = available_metrics[metric].get('smaller_is_better', True)
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
  The weighted objective value of each metric, as {metric: value}.
  The scalar objective is their sum; in Pareto mode each is optimized on its own.
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
          metric_target = available_metrics[metric]['target']
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
        except:
          click.secho(f'Could not find {metric}', fg='red')
          click.secho(output['output_dir_url'][2:], fg='red')
    partial_objective = make_reduce(options)(losses)
    components[metric] = options.get('weight', 1) * partial_objective
  return components


def batch_objective(project, commit_id, batch_label, config_objective):
  """The scalar objective of a batch: the sum of its per-metric components."""
  return sum(batch_objective_components(project, commit_id, batch_label, config_objective).values())






# The plots (make_plots) live in qaboard/optimization.py next to the engine:
# they are written as Plotly JSON + a standalone HTML report, and the webapp renders
# them natively -- see webapp/src/components/tuning/TuningExploration.js



# compare convergence across runs...
# https://optuna.readthedocs.io/en/stable/reference/visualization/generated/optuna.visualization.plot_optimization_history.html
# plot_optimization_history accepts a list of studies:
# _ = plot_optimization_history([study_gp, study_tpe, study_random])


# checkpoints / warm-start?
# Optuna studies can live in a database instead of memory, which would give us both
# resumable runs and a way to "tell" past results at startup:
#   study = optuna.create_study(storage="sqlite:///optim.db", study_name=..., load_if_exists=True)
# https://optuna.readthedocs.io/en/stable/tutorial/20_recipes/001_rdb.html
