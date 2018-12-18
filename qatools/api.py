"""
Utilities related to CI database: fetching results, saving results... 
"""
import os
from pathlib import Path
import json
from functools import lru_cache

import click

from .config import config, commit_id, available_metrics


api_protocol = os.getenv('QATOOLS_DB_PROTOCOL', 'http')
api_host = os.getenv('QATOOLS_DB_HOST', 'dvs')
api_port = os.getenv('QATOOLS_DB_PORT', '5000')


class NumpyEncoder(json.JSONEncoder):
    """ Special json encoder for numpy types """
    def default(self, obj):
        import numpy as np

        if isinstance(obj, (np.int_, np.intc, np.intp, np.int8,
            np.int16, np.int32, np.int64, np.uint8,
            np.uint16, np.uint32, np.uint64)):
            return int(obj)
        elif isinstance(obj, (np.float_, np.float16, np.float32,
            np.float64)):
            return float(obj)
        elif isinstance(obj,(np.ndarray,)): #### This is the fix
            return obj.tolist()
        return json.JSONEncoder.default(self, obj)



def notify_qa_database(object_type='output', **kwargs):
  """
  Updating the QA database.
  """
  import requests
  from .config import is_ci, on_windows, commit_id, config

  # some light custom serialization for Path objects
  for key, value in kwargs.items():
    if issubclass(type(value), Path):
      # the server expects to recieve file that are valid on linux
      if on_windows:
        try:
          kwargs[key] = config['ci_root']['linux'] / kwargs[key].relative_to(ci_root)
        except:
          pass
        kwargs[key] = str(value)

  # we send updates to
  url = f"{api_protocol}://{api_host}:{api_port}/api/v1/{object_type}/"

  data = {
    'job_type': 'ci' if is_ci else 'local',
    'git_commit_sha': commit_id,
    **kwargs,
  }
  try:
    # we can't use requests' json serialization (simplejson or json) because it fails with numpy arrays
    data = json.dumps(data, cls=NumpyEncoder)
    r = requests.post(url, data=data, headers={'Content-Type': 'application/json'})
    r.raise_for_status()
  except:
    click.secho('WARNING: Failed to update the QA database.', fg='yellow', err=True)
    click.secho(url, fg='yellow', err=True)
    click.secho(str(data), fg='yellow', err=True)
    try:
      click.secho(str(r.request.headers), fg='yellow', dim=True, err=True)
      click.secho(str(r.request.body), fg='yellow', dim=True, err=True)
      click.secho(f'{r.status_code}: {r.text}', fg='yellow', dim=True, err=True)
    except:
      pass



@lru_cache()
def batch_info(reference, is_branch, batch):
  """Get data about a batch of outputs in the database"""
  import requests
  params = {
    "project": config['project']['name'],
    "batch": batch,
    # the format is metric: target.... not great.
    "metrics": json.dumps({metric: 0 for metric in available_metrics.keys()}),
  }
  if is_branch:
    params["branch"] = reference
  commit_id = reference if not is_branch else ''
  url = f'{api_protocol}://{api_host}:{api_port}/api/v1/commit/{commit_id}'
  r = requests.get(url, params=params)
  if 'batches' not in r.json():
  	print(r.url)
  	raise ValueError(f'We could not get the results for {batch}')
  return r.json()['batches'][batch]



@lru_cache()
def aggregated_metrics(batch_label):
  info = batch_info(reference=commit_id, is_branch=False, batch=batch_label)
  # We also always return the aggregated metrics from the API,
  # it helps understand how metrics evolved during the optimization, irrelative of the objective function
  # Note: we could do the aggregation ourselves...
  aggregation = 'average' # aggregation = objective.get('aggregation', 'average')
  return {
    k.replace(f"_{aggregation}", ""): v
    for k, v in info['aggregated_metrics'].items()
    if k.endswith(aggregation)
  }
