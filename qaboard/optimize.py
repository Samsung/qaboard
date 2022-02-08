import yaml
import json
import subprocess

import click
from joblib import Parallel, delayed

from .api import NumpyEncoder, batch_info, notify_qa_database, print_url, matching_output
from .config import project, subproject, commit_id, outputs_commit, available_metrics, default_batches_files, default_platform
from .conventions import batch_dir
from .utils import PathType
from .run import RunContext



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
  batch_dir_for = lambda label: batch_dir(outputs_commit, label, save_with_ci=True)
  optim_dir = batch_dir_for(ctx.obj['batch_label'])
  optim_dir.mkdir(parents=True, exist_ok=True)

  ctx.obj['batches'] = batches
  ctx.obj['batches_files'] = batches_files
  ctx.obj['forwarded_args'] = forwarded_args
  print_url(ctx)

  from shutil import rmtree
  from .api import aggregated_metrics
  objective, optimizer, optim_config, dim_mapping = init_optimization(config_file, ctx)
  if not parallel_param_sampling:
    parallel_param_sampling = optim_config.get('parallel_sampling', 1)

  # TODO: warm-start
  #   load and "tell" existing results (if there are any)
  #   (or use a checkpoint?)
  for iteration in range(optim_config['evaluations']):
      click.secho(f"Starting iteration {iteration}", fg='blue')
      if parallel_param_sampling == 1:
        suggested = optimizer.ask()
      else:
        click.secho(f"  {parallel_param_sampling} parallel samples", fg='blue')
        suggested = optimizer.ask(n_points=parallel_param_sampling)
      # print("suggested", suggested)
      click.secho(f"Computing objective", fg='blue')
      if parallel_param_sampling == 1:
        y = objective([*suggested, iteration])
      else:
        y = Parallel(n_jobs=parallel_param_sampling)(delayed(objective)([*s, iteration+idx]) for idx, s in enumerate(suggested))
      # print(f"y={y}", suggested)
      click.secho(f"Updating optimizer", fg='blue')
      results = optimizer.tell(suggested, y)

      click.secho(f"Updating QA-Board", fg='blue')
      if parallel_param_sampling == 1:
        suggested = [suggested]
        y = [y]
      for idx, y_iter in enumerate(y): 
        iteration_batch_label = f"{ctx.obj['batch_label']}|iter{iteration+idx+1}"
        iteration_batch_dir = batch_dir_for(iteration_batch_label)
        aggregated_metrics_ = aggregated_metrics(iteration_batch_label)
        notify_qa_database(**{
          **ctx.obj,
          **{
            "extra_parameters": dim_mapping(suggested[idx]),
            # TODO: we really should to tuning/platform in make_batch_conf_dir
            #       1. make change, 2. rename existing folders)
            "output_directory": iteration_batch_dir,
            'input_path': '|'.join(batches),
            # we want to show in the summary tab the best results for the tuning experiment
            # but in the exploration see the results per iteration....
            "input_type": 'optim_iteration', # or... single ? don't show them in the UI
            "is_pending": False,
            "is_failed": False,
            "metrics": {
              "iteration": iteration+idx+1,
              "objective": y_iter,
              **aggregated_metrics_,
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
        is_best = results.func_vals[iteration+idx] <= results.fun or iteration+idx==0
        if is_best:
          click.secho(f'New best @iteration{iteration+idx+1}: {y} at iteration {iteration+idx+1}', fg='green')

        is_best_data = {
          "is_best_iter": True,
          "best_params": dim_mapping(suggested[idx]),
          "best_metrics": {
            "objective": y_iter,
            **aggregated_metrics_,
          },
        } if is_best else {}

        notify_qa_database(object_type='batch', **{
          **ctx.obj,
          **{
              "data": {
                "optimization": True,
                "iteration": iteration+idx+1,
                "iteration_label": iteration_batch_label,
                **is_best_data,
              },
          },
        })

        if is_best:
          try:
            click.secho(f'Creating plots', fg='blue')
            make_plots(results, optim_dir)
          except:
            pass
        else:
          # We remove the results to make sure we don't waste disk space
          # It is also be done server-side...
          print(f"RM {iteration_batch_dir}")
          rmtree(iteration_batch_dir, ignore_errors=True)
          exit(0)

  print(results)
  if not results.models: # needs at least n_initial_points(=5) evaluations!
    return

  # tuning plots are saved in the label directory
  make_plots(results, optim_dir)




def init_optimization(optim_config_file, ctx):
  with optim_config_file.open('r') as f:
    optim_config = yaml.load(f, Loader=yaml.SafeLoader)

  # default settings
  if "objective" not in optim_config:
    raise ValueError('ERROR: the configuration must provide an `objective`.')
  if "evaluations" not in optim_config:
    raise ValueError('ERROR: the configuration must project a `evaluations` budget.')
  optim_config = {
    "solver": {},
    "search_space": {},
    "preset_params": {},
    **optim_config,
  }
  optim_config['solver'] = {
    "name": "scikit-optimize",
    "random_state": 42,
    **optim_config.get('solver', {}),
  }
  from skopt.utils import Space
  space = Space.from_yaml(optim_config_file, namespace='search_space')
  preset_params = optim_config.get('preset_params', {})
  click.secho("Search space:", fg="blue", err=True)
  click.secho(str(space), fg="blue", dim=True, err=True)
  click.secho("Preset parameters:", fg="blue", err=True)
  click.secho(str(preset_params), fg="blue", dim=True, err=True)

  # we use the iteration step in the objective function, to store results at the right place
  from skopt.utils import Integer
  dim_iteration = Integer(name='iteration', low=0, high=2^16)
  dims = [*space, dim_iteration]

  from skopt.utils import use_named_args

  @use_named_args(dims)
  def objective(**opt_params):
    params =  {**preset_params, **opt_params}

    # From the UI we will want to see the iteration as a metric
    del params["iteration"]

    batch_label = f"{ctx.obj['raw_batch_label']}|iter{opt_params['iteration']+1}"
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
    shared_batch_label = f"{ctx.obj['batch_label']}|iter{opt_params['iteration']+1}"
    return batch_objective(project, commit_id, shared_batch_label, optim_config['objective'])

  # For the full list of options, refer to:
  # https://scikit-optimize.github.io/stable/modules/generated/skopt.optimizer.Optimizer.html#skopt.optimizer.Optimizer
  from skopt import Optimizer
  del optim_config['solver']['name']
  optimizer = Optimizer(space, **optim_config['solver'])

  # in the optimization loop, `ask` gives us an array of values
  # this wrapper converts it back to the actual named parameters
  @use_named_args([*space])
  def dim_mapping(**opt_params):
    return {**preset_params, **opt_params}

  return objective, optimizer, optim_config, dim_mapping




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

def batch_objective(project, commit_id, batch_label, config_objective):
  this_batch_info = batch_info(reference=commit_id, is_branch=False, batch=batch_label, project=project)
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
      )
  else:
    use_default_targets = True

  objective = 0
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
    objective += options.get('weight', 1) * partial_objective
  return objective






def make_plots(results, dir):
  # click.secho(str(dir), dim=True)
  import matplotlib
  import matplotlib.pyplot as plt
  # https://matplotlib.org/faq/usage_faq.html#non-interactive-example
  # https://matplotlib.org/api/_as_gen/matplotlib.pyplot.savefig.html

  if not dir.exists():
    dir.mkdir(parents=True, exist_ok=True)

  # WIP: there is currently no support for plotting categorical variables...
  # You have to manually checkout this pull request:
  #   git pr 675  # install https://github.com/tj/git-extras
  #   git pull origin master 
  # https://github.com/scikit-optimize/scikit-optimize/pull/675
  from skopt.plots import plot_convergence
  click.secho(f'. plot_convergence', fg='blue')
  _ = plot_convergence(results)
  plt.savefig(dir/'plot_convergence.png')

  # Those plots can be VERY slow.
  # TODO: create them in the  background
  # from skopt.plots import plot_objective
  # click.secho(f'. plot_objective', fg='blue')
  # _ = plot_objective(results)
  # plt.savefig(dir/'plot_objective.png')

  # from skopt.plots import plot_regret
  # click.secho(f'. plot_regret', fg='blue')
  # _ = plot_regret(results)
  # plt.savefig(dir/'plot_regret.png')

  # from skopt.plots import plot_evaluations
  # click.secho(f'. plot_evaluations', fg='blue')
  # _ = plot_evaluations(results)
  # plt.savefig(dir/'plot_evaluations.png')





# compare convergence...
# https://github.com/scikit-optimize/scikit-optimize/blob/master/examples/strategy-comparison.ipynb
# for all runs...
# from skopt.plots import plot_convergence
# plot = plot_convergence(("dummy_minimize", dummy_res),
#                         ("gp_minimize", gp_res),
#                         ("forest_minimize('rf')", rf_res),
#                         ("forest_minimize('et)", et_res), 
#                         true_minimum=0.397887, yscale="log")
# plot.legend(loc="best", prop={'size': 6}, numpoints=1);


# checkpoints?
# https://github.com/scikit-optimize/scikit-optimize/blob/master/examples/interruptible-optimization.ipynb
# https://github.com/scikit-optimize/scikit-optimize/blob/master/examples/store-and-load-results.ipynb
# poor man's solution:
# import pickle
# with open('my-optimizer.pkl', 'wb') as f:
#     pickle.dump(opt, f)
# with open('my-optimizer.pkl', 'rb') as f:
#     opt_restored = pickle.load(f)