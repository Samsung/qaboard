"""
Utilities related to CI database: fetching results, saving results... 
"""
import os
import json
from copy import deepcopy
from functools import lru_cache
from urllib.parse import quote, unquote
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Optional

import simplejson
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
  # click.secho("WARNING: We don't know where to look for your QA-Board server.", fg='yellow', bold=True, err=True)
  # click.secho("         We default to the default configuration (http://localhost:5151) if you `docker-compose up` QA-Board.", fg='yellow', err=True)
  # click.secho("         Please provide it as an environment variable (via QABOARD_HOST, e.g. 'qaboard-srv', 'qaboard-srv:443').", fg='yellow', err=True)
  # click.secho("         If needed you can define QABOARD_PROTOCOL (default: https). You can also provide both QABOARD_HOSTNAME and QABOARD_PORT.", fg='yellow', err=True)
  # click.secho("       > If you don't have a QA-Board server, read the docs to learn how to start one!", fg='yellow', err=True)
  qaboard_url = "http://localhost:5151"
api_prefix = f"{qaboard_url}/api/v1"



def url_to_dir(url: str) -> Path:
  return Path(unquote(url)[2:])

def dir_to_url(path: Path) -> str:
  if not path.is_absolute():
    raise ValueError(f"{path} is not absolute")
  return quote(f"/s{path.as_posix()}")


def print_url(ctx, status="starting"):
  if not ctx.obj['offline'] and not os.environ.get('QA_BATCH'):
    batch_label = ctx.obj["batch_label"]
    commit_url = f"{qaboard_url}/{config['project']['name']}/commit/{commit_id[:10] if commit_id else ''}{f'?batch={quote(batch_label)}' if batch_label != 'default' else ''}"
    if is_ci or ctx.obj['share']:
      if status == "starting":
        click.echo(click.style("Results: ", bold=True) + click.style(commit_url, underline=True, bold=True), err=True)
      elif status == "failure":
        click.echo(
          click.style("[FAILED] Read the full logs at: ", bold=True, fg='red') +
          click.style(
            f"{commit_url}{'?' if batch_label == 'default' else '&'}selected_views=logs",
            fg='red',
            underline=True,
            bold=True,
          ),
        err=True)



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
  from .config import is_ci, is_in_git_repo, config, _metrics
  from .config import commit_id, commit_branch, commit_tag, commit_committer_name, commit_committer_email, commit_authored_datetime, commit_parents, commit_message

  if kwargs.get('offline'):
    return

  # we only update QA-Board if we're in a CI run, or if the user used `qa --ci`
  if not (is_ci or kwargs['share']):
    return

  url = f"{api_prefix}/{object_type}/"
  data = {
    'job_type': 'ci' if is_ci else 'local',
    'commit_sha': commit_id,
    'git_commit_sha': commit_id, # backward compat for now
    # send all the data, with some light custom serialization for Path objects
    **serialize_paths(kwargs),
  }
  # if object_type != "output"  # le'ts be wasteful to make init easier
  # Will help initialize/update the commit/batch in QA-Board
  data.update({
  'commit_branch': commit_branch,
  'commit_tag': commit_tag,
  'commit_committer_name': commit_committer_name,
  'commit_committer_email': commit_committer_email,
  'commit_authored_datetime': commit_authored_datetime,
  'commit_parents': commit_parents,
  'commit_message': commit_message,
  "qaboard_config": serialize_paths(deepcopy(config)),
  "qaboard_metrics": _metrics,
  })
  if 'QA_VERBOSE' in os.environ:
    click.secho(url, fg='cyan', err=True)
    click.secho(str(data), fg='cyan', dim=True, err=True)

  try:
    # we can't use requests' json serialization (simplejson or json) because it fails with numpy arrays
    data = simplejson.dumps(data, ignore_nan=True, cls=NumpyEncoder)
    r = requests.post(url, data=data, headers={'Content-Type': 'application/json'})
    if 'QA_VERBOSE' in os.environ:
      click.secho(r.text, fg='cyan', dim=True, err=True)
    r.raise_for_status()
    try:
      return r.json()
    except:
      click.secho(f"WARNING: Can't understand the server response: {r.text}", fg='yellow', err=True)
  except Exception as e:
    click.secho(f'WARNING: [{e}] Failed to update QA-Board.', fg='yellow', bold=True, err=True)
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

# We used to use a cache but now we want to check run statuses before/after the batch
# @lru_cache()
def batch_info(reference, batch, is_branch=False):
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
    raise ValueError(f'We could not get the results for {batch} batch {reference}')
  return r.json()['batches'][batch]


def get_outputs(qa_context: Optional[Dict[str, Any]]) -> Dict[int, Any]:
  if not qa_context:
    return {}
  should_notify_qa_database = (is_ci or qa_context['share']) and not (qa_context['dryrun'] or qa_context['offline'])
  if not should_notify_qa_database:
    return {}
  try:
    return batch_info(reference=commit_id, batch=qa_context['batch_label'])['outputs']
  except:
    return {}


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
