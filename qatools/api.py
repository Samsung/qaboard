"""
Utilities related to CI database: fetching results, saving results... 
"""
import os
from pathlib import Path, PurePosixPath
import json
import simplejson
from functools import lru_cache

import click

from .config import config, commit_id, is_ci, available_metrics
from .config import secrets

qaboard_protocol = os.getenv('QABOARD_PROTOCOL', secrets.get('QABOARD_PROTOCOL', 'https'))
qaboard_hostname = os.getenv('QABOARD_HOSTNAME', secrets.get('QABOARD_HOSTNAME'))
qaboard_port = os.getenv('QABOARD_PORT', secrets.get('QABOARD_PORT'))
qaboard_host = os.getenv('QABOARD_HOST', secrets.get('QABOARD_HOST'))
if qaboard_hostname and qaboard_port:
  qaboard_url = f"{qaboard_protocol}://{qaboard_hostname}:{qaboard_port}"
elif qaboard_host:
  qaboard_url = f"{qaboard_protocol}://{qaboard_host}"
else:
  click.secho("WARNING: We don't know where to look for your QA-Board server.", fg='yellow', bold=True, err=True)
  click.secho("         Please provide it as an environment variable (via QABOARD_HOST, e.g. 'qaboard-srv', 'qaboard-srv:443').", fg='yellow', err=True)
  click.secho("         If needed you can define QABOARD_PROTOCOL (default: https). You can also provide both QABOARD_HOSTNAME and QABOARD_PORT.", fg='yellow', err=True)
  click.secho("       > If you don't have a QA-Board server, read the docs to learn how to start one!", fg='yellow', err=True)

api_prefix = "{qaboard_url}/api/v1"

# TODO: remove this block
# For now we use http, until we deal with cert trust issues
api_protocol = os.getenv('QATOOLS_DB_PROTOCOL', 'http')
api_host = os.getenv('QATOOLS_DB_HOST', 'qa')
api_port = os.getenv('QATOOLS_DB_PORT', '5000')
api_prefix = f"{api_protocol}://{api_host}:{api_port}/api/v1"



def print_url(ctx, status="starting"):
  if not ctx.obj['offline']:
    from requests.utils import quote
    batch_label = ctx.obj["batch_label"]
    # FIXME: use the same port at SIRC for the API/web, and don't hardcode...
    qaboard_url = "https://qa"
    commit_url = f"{qaboard_url}/{config['project']['name']}/commit/{commit_id if commit_id else ''}{f'?batch={quote(batch_label)}' if batch_label != 'default' else ''}"
    if is_ci or ctx.obj['share']:
      if status == "starting":
        click.echo(click.style("Results: ", bold=True) + click.style(commit_url, underline=True, bold=True), err=True)
      elif status == "failure":
        click.secho(f"Read Logs at: {commit_url}{'?' if batch_label == 'default' else '&'}selected_views=logs", fg='red', bold=True)



class NumpyEncoder(simplejson.JSONEncoder):
    """Special simplejson encoder for numpy types"""
    def default(self, obj):
        # we take care not to import numpy unless it's already loaded
        if 'numpy' in str(type(obj)) and hasattr(obj, 'tolist'):
          return obj.tolist()
        else:
          return simplejson.JSONEncoder.default(self, obj)


def serialize_path(path):
  from .config import on_windows
  if on_windows:
    value = path
    # we support mount names that are different on windows and linux
    try: # FIXME: make it configurable in a better way...
      value = (Path('/mnt/datasets') / path.relative_to('\\\\F\\datasets'))
    except:
      pass
    # The server expects to receive paths that are linux-style
    if issubclass(type(value), Path):
      value = value.as_posix()
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

  if kwargs.get('offline'):
    return

  # we only update the output database if we're in a CI run, or if the user used `qa --ci`
  if not is_ci and not kwargs['share']:
    return

  # some light custom serialization for Path objects
  kwargs = serialize_paths(kwargs)

  # we send updates to
  url = f"{api_prefix}/{object_type}/"

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
    if 'QATOOLS_VERBOSE' in os.environ:
      click.secho(r.text, fg='cyan', dim=True, err=True)
    r.raise_for_status()
    try:
      return r.json()
    except:
      click.secho(f"WARNING: Can't understand the server response: {r.text}", fg='yellow', err=True)
  except:
    click.secho('WARNING: Failed to update QA-Board.', fg='yellow', bold=True, err=True)
    click.secho(url, fg='yellow', err=True)
    click.secho(str(data), fg='yellow', err=True)
    try:
      click.secho(str(r.request.headers), fg='yellow', dim=True, err=True)
      click.secho(str(r.request.body), fg='yellow', dim=True, err=True)
      click.secho(f'{r.status_code}: {r.text}', fg='yellow', dim=True, err=True)
    except:
      pass


def get_output(output_id):
  import requests
  url = f"{api_prefix}/output/{output_id}/"
  try:
    r = requests.get(url, headers={'Content-Type': 'application/json'})
    r.raise_for_status()
    return r.json()
  except:
    click.secho(f'WARNING: Failed to contact the QA-Board. (GET Output {output_id})', fg='yellow', bold=True, err=True)
    try:
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
  url = f'{api_prefix}/commit/{commit_id}'
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
