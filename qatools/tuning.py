import subprocess
from functools import lru_cache
import yaml
import json

import requests
import click
import numpy as np

from skopt import Optimizer
from skopt.utils import Space
from skopt.utils import Integer
from skopt.utils import use_named_args

from .api import NumpyEncoder, batch_info
from .config import commit_id, available_metrics


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

  space = Space.from_yaml(optim_config_file, namespace='search_space')
  preset_params = optim_config.get('preset_params', {})
  click.secho("Search space:", fg="blue", err=True)
  click.secho(str(space), fg="blue", dim=True, err=True)
  click.secho("Preset parameters:", fg="blue", err=True)
  click.secho(str(preset_params), fg="blue", dim=True, err=True)

  # we use the iteration step in the objective function, to store results at the right place
  dim_iteration = Integer(name='iteration', low=0, high=2^16)
  dims = [*space, dim_iteration]

  @use_named_args(dims)
  def objective(**opt_params):
    params =  {**preset_params, **opt_params}

    # From the UI we will want to see the iteration as a metric
    del params["iteration"]

    batch_label = f"{ctx.obj['batch_label']}|iter{opt_params['iteration']+1}"
    command = ' '.join([
      'qa',
      f"--batch-label '{batch_label}'",
      f'--platform "{ctx.obj["platform"]}"',
      f'--configuration "{ctx.obj["configuration"]}"',
      f"--tuning '{json.dumps(params, sort_keys=True, cls=NumpyEncoder)}'",
      'batch',
      f'--batches-file {ctx.obj["batches_file"]}',
      ' '.join([f'--batch {b}' for b in ctx.obj["batches"]]),
      # we notably forward --batch
      ' '.join(ctx.obj["forwarded_args"]),
    ])
    click.secho(command, fg="blue")
    if not ctx.obj['dryrun']:
      out = subprocess.run(
          command,
          shell=True,
          encoding="utf-8",
          stdout=subprocess.PIPE,
          stderr=subprocess.STDOUT,
          check=True,
      )
      click.secho(out.stdout)

    # Now that we finished computing all the results, we will download the results and
    # compute the objective function:
    return batch_objective(batch_label, optim_config['objective'])

  # For the full list of options, refer to:
  # https://scikit-optimize.github.io/#skopt.Optimizer
  optimizer = Optimizer(space, random_state=optim_config['solver']['random_state'])

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
  reduce_type =  options.get('reduce', 'l2')
  if reduce_type == 'sum':
    return lambda x: sum(x) / len(x)
  if reduce_type == 'relu':
    return lambda x: relu(sum(x)) / len(x)
  if len(reduce_type) == 2:
    return lambda x: np.linalg.norm(x, ord=int(reduce_type[1])) / len(x)


def matching_output(output_reference, outputs):
  """
  Return the output from from a given batch that looks most similar to a given output.
  This helps us compare an output to historical results.
  """
  matching_outputs = [o for o in outputs if o.test_input_path == output_reference.test_input_path]
  valid_outputs = [o for o in matching_outputs if not o.is_pending and not o.is_failed]
  if not valid_outputs:
    raise ValueError(f"Could not find an output for {output_reference.test_input_path} in the target batch")

  def match_key(output):
    return (
      5 if output.configuration == output_reference.configuration else 0 +
      3 if output.platform == output_reference.platform else 0 +
      1 if json.dumps(output.extra_parameters, sorted=True) == json.dumps(output_reference.extra_parameters, sorted=True) else 0
    )
  valid_outputs.sort(key=match_key, reverse=True)
  return valid_outputs[0]



def batch_objective(batch_label, config_objective):
  this_batch_info = batch_info(reference=commit_id, is_branch=False, batch=batch_label)
  # We can compare to KPI quality target defined using qatools
  if 'target' in config_objective and config_objective['target']:
    target = config_objective['target']
    use_default_targets = not 'id' in target and not 'branch' in target
    # or get reference results from historical data
    if not use_default_targets:
      target_batch_info = batch_info(
        target['id'] if 'id' in target else target['branch'],
        is_branch='branch' in target,
        batch=target.get('batch', 'default')
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
          output_target = matching_output(output, target_batch_info['outputs'])
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
  _ = plot_convergence(results)
  plt.savefig(dir/'plot_convergence.png')

  from skopt.plots import plot_objective
  _ = plot_objective(results)
  plt.savefig(dir/'plot_objective.png')

  from skopt.plots import plot_regret
  _ = plot_regret(results)
  plt.savefig(dir/'plot_regret.png')

  from skopt.plots import plot_evaluations
  _ = plot_evaluations(results)
  plt.savefig(dir/'plot_evaluations.png')





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


# parallel optimization
# in the yaml:
# parallel: X (if you have a small dataset.self.)
# https://github.com/scikit-optimize/scikit-optimize/blob/master/examples/parallel-optimization.ipynb
# from sklearn.externals.joblib import Parallel, delayed
# x = optimizer.ask(n_points=4)  # x is a list of n_points points    
# y = Parallel()(delayed(branin)(v) for v in x)  # evaluate points in parallel
# optimizer.tell(x, y)


# checkpoints?
# https://github.com/scikit-optimize/scikit-optimize/blob/master/examples/interruptible-optimization.ipynb
# https://github.com/scikit-optimize/scikit-optimize/blob/master/examples/store-and-load-results.ipynb
# poor man's solution:
# import pickle
# with open('my-optimizer.pkl', 'wb') as f:
#     pickle.dump(opt, f)
# with open('my-optimizer.pkl', 'rb') as f:
#     opt_restored = pickle.load(f)