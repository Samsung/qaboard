"""
Utilities related to CI database: fetching results, saving results... 
"""
import os
from pathlib import Path, PurePosixPath
import json
import simplejson
from functools import lru_cache

import click

from .config import config, commit_id, available_metrics

# For now we use http, until we deal with cert trust issues
api_protocol = os.getenv('QATOOLS_DB_PROTOCOL', 'http')
api_host = os.getenv('QATOOLS_DB_HOST', 'qa')
api_port = os.getenv('QATOOLS_DB_PORT', '5000')


class NumpyEncoder(simplejson.JSONEncoder):
    """ Special simplejson encoder for numpy types """
    def default(self, obj):
        import numpy as np
        if isinstance(obj, (np.int_, np.intc, np.intp, np.int8,
            np.int16, np.int32, np.int64, np.uint8,
            np.uint16, np.uint32, np.uint64)):
            return int(obj)
        elif isinstance(obj, (np.float_, np.float16, np.float32,
            np.float64)):
            return float(obj)
        elif isinstance(obj,(np.ndarray,)):
            return obj.tolist()
        return simplejson.JSONEncoder.default(self, obj)




def serialize_path(path):
  from .config import on_windows
  # The server expects to recieve file that are valid on linux
  if on_windows:
  	value = path
    try:
      value = (Path('/stage/algo_data') / path.relative_to('\\\\netapp\\algo_data')).as_posix()
    except:
      pass
    try:
      value = (Path('/stage/algo_archive') / path.relative_to('\\\\netapp\\algo_archive')).as_posix()
    except:
      pass
    try:
      value = (Path('/stage/algo_db') / path.relative_to('\\\\netapp\\algo_db')).as_posix()
    except:
      pass
  else:
  	value = path
  return str(value)


def serialize_paths(data):
  """Serialize recursively Path to strings"""
  if issubclass(type(data), Path):
  	data = serialize_path(data)
  elif isinstance(data, dict):
	  data = {key: serialize_paths(value) for key, value in data.items()}
  elif isinstance(data, list):
  	data = [serialize_paths(value) for value in data]
  return data

def notify_qa_database(object_type='output', **kwargs):
  """
  Updating the QA database.
  """
  import requests
  from .config import is_ci, commit_id, config, ci_root
  
  # we only update the output database if we're in a CI run, or if the user used `qa --ci`
  if not is_ci and not kwargs['ci']:
    return

  # some light custom serialization for Path objects
  kwargs = serialize_paths(kwargs)

  # we send updates to
  url = f"{api_protocol}://{api_host}:{api_port}/api/v1/{object_type}/"

  data = {
    'job_type': 'ci' if is_ci else 'local',
    'git_commit_sha': commit_id,
    **kwargs,
  }
  if 'QATOOLS_VERBOSE' in os.environ:
    click.secho(url, fg='cyan', err=True)
    click.secho(str(data), fg='cyan', dim=True, err=True)
  
  try:
    # we can't use requests' json serialization (simplejson or json) because it fails with numpy arrays
    data = simplejson.dumps(data, ignore_nan=True, cls=NumpyEncoder)
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
