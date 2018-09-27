import subprocess
from functools import lru_cache
import yaml
import json

import requests
import click

from skopt import Optimizer
from skopt.utils import Space
from skopt.utils import Integer
from skopt.utils import use_named_args

from .utils import NumpyEncoder
from .config import config, commit_id, available_metrics


def init_optimization(optim_config_file, ctx):
  with optim_config_file.open('r') as f:
    optim_config = yaml.load(f)

  # default settings
  if "metric" not in optim_config:
    raise ValueError('ERROR: you must project a `metric` for the optimization')
  optim_config = {
    "evaluations": "1",
    "aggregation": "average",
    "minimize": available_metrics[optim_config['metric']]['smaller_is_better'],
    "solver": {},
    "space": {},
    "fixed": {},
    **optim_config,
  }
  optim_config['solver'] = {
    "name": "scikit-optimize",
    "random_state": 42,
    **optim_config.get('solver', {}),
  }

  space = Space.from_yaml(optim_config_file, namespace='space')
  fixed_params = optim_config.get('fixed', {})
  click.secho("Search space:", fg="blue", err=True)
  click.secho(str(space), fg="blue", dim=True, err=True)
  click.secho("Fixed parameters:", fg="blue", err=True)
  click.secho(str(fixed_params), fg="blue", dim=True, err=True)

  # we use the iteration step in the objective function, to store results at the right place
  dim_iteration = Integer(name='iteration', low=0, high=2^16)
  dims = [*space, dim_iteration]

  @use_named_args(dims)
  def objective(**opt_params):
    params =  {**fixed_params, **opt_params}

    # From the UI we will want to see the iteration as a metric
    del params["iteration"]

    batch_label = f"{ctx.obj['batch_label']}|iter{opt_params['iteration']}"
    command = ' '.join([
      'qa',
      # TODO: write in a batch named {batch_label}_iter{iter}
      f"--batch-label '{batch_label}'",
      f'--platform "{ctx.obj["platform"]}"',
      f'--configuration "{ctx.obj["configuration"]}"',
      f"--tuning '{json.dumps(params, sort_keys=True, cls=NumpyEncoder)}'",
      'batch',
      f'--groups-file {ctx.obj["groups_file"]}',
      ' '.join([f'--group {g}' for g in ctx.obj["group"]]),
      # we notably forward --group
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

    # We could just issue some GROUP_BY SQL if we connected to the database
    agg_metrics =  aggregated_metrics(batch_label, optim_config["aggregation"])
    return agg_metrics[optim_config["metric"]]

  # For the full list of options, refer to:
  # https://scikit-optimize.github.io/#skopt.Optimizer
  optimizer = Optimizer(space, random_state=optim_config['solver']['random_state'])

  # in the optimization loop, `ask` gives us an array of values
  # this wrapper converts it back to the actual named parameters
  @use_named_args([*space])
  def dim_mapping(**opt_params):
    return {**fixed_params, **opt_params}

  return objective, optimizer, optim_config, dim_mapping


@lru_cache()
def aggregated_metrics(batch_label, aggregation):
  # TODO: support for custom scores (eg weighted? normalized?)
  # TODO: get all the metrics for this projects.... the metric arg is not great..
  r = requests.get(f'http://dvs:5000/api/v1/commit/{commit_id}',
                   params = {
                     "project": config['project']['name'],
                     "batch": batch_label,
                     # the format is metric: threshold.... not great.
                     "metrics": json.dumps({metric: 0 for metric in available_metrics.keys()}),
                   })
  print(r.url)
  print(r.json()['batches'][batch_label])
  agg_metrics = r.json()['batches'][batch_label]['aggregated_metrics']
  return {k.replace(f"_{aggregation}", ""): v
             for k, v in agg_metrics.items()
             if k.endswith(aggregation)
            }




def make_plots(results, dir):
  import matplotlib
  import matplotlib.pyplot as plt
  # https://matplotlib.org/faq/usage_faq.html#non-interactive-example
  # https://matplotlib.org/api/_as_gen/matplotlib.pyplot.savefig.html

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