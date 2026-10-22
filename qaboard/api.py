"""
Utilities related to CI database: fetching results, saving results... 
"""
import os
import re
import sys
import json
from pathlib import Path
from copy import deepcopy
from functools import lru_cache
from urllib.parse import quote, unquote, urlparse
from typing import Any, Dict, Optional, List

import click

from .config import project, commit_id, is_ci, available_metrics
from .run import RunContext

from .site_config import site_config, as_requests_verify
from .credentials import resolve_token, default_server, refusal, fix_for
from .auth import print_server_warning, first_time

qaboard_protocol = site_config('QABOARD_PROTOCOL', 'http')
qaboard_hostname = site_config('QABOARD_HOSTNAME')
qaboard_port = site_config('QABOARD_PORT')
qaboard_host = site_config('QABOARD_HOST')
# What gives the URL, e.g. "$QABOARD_URL", None for the default
qaboard_url, qaboard_url_source = default_server()
# Only when nothing says where the server is: QABOARD_URL=http://localhost:5151 is fine.
# `qa auth status` says it too.
if not qaboard_url_source and sys.argv[1:2] != ['auth']:
  click.secho("WARNING: We are not sure where to find your QA-Board server.", fg='yellow', bold=True, err=True)
  click.secho(f"         We will default to {qaboard_url}", fg='yellow', bold=True, err=True)
  click.secho("         To remove this warning provide it as an environment variable (via QABOARD_HOST, e.g. 'qaboard-srv', 'qaboard-srv:443').", fg='yellow', err=True)
  click.secho("         If needed you can define QABOARD_PROTOCOL (default: http). You can also provide both QABOARD_HOSTNAME and QABOARD_PORT.", fg='yellow', err=True)
  click.secho("       > If you have not started a QA-Board server, read the docs to learn how to start one!", fg='yellow', err=True)
  click.secho("       > If your organization has a site package (e.g. qaboard-site-sirc), install it.", fg='yellow', err=True)

api_prefix = site_config('QABOARD_API_PREFIX', f"{qaboard_url}/api/v1")
# Whether requests to the API check TLS certificates: true (default), false, or the path to a CA bundle.
# Useful when the server uses certificates from an internal CA that clients don't trust.
api_verify = as_requests_verify(site_config('QABOARD_API_VERIFY'))
if api_verify is False:
  import warnings
  # requests would warn about each unverified request to the server
  warnings.filterwarnings('ignore', message=f"Unverified HTTPS request is being made to host '{re.escape(urlparse(api_prefix).hostname or '')}'")


# (connect, read) timeouts for requests to the server. The server gives up on requests long before the read timeout.
api_timeout = (30, 600)


def headers_for(server_url):
  """Headers for requests to a server, with the token qa uses for it, if any (see qaboard/credentials.py)."""
  token, _ = resolve_token(server_url)
  return {'Content-Type': 'application/json', **({"Authorization": f"Bearer {token}"} if token else {})}

# API token, to sign what qa sends and for actions that require a signed-in user:
# $QABOARD_TOKEN or $QA_TOKEN, `qa auth login`'s for the server, or the legacy QA_TOKEN in ~/.qaboard/secrets.yaml
qa_token, qa_token_source = resolve_token(qaboard_url)
headers = headers_for(qaboard_url)


# The first time QA-Board refused results qa sent (output, batch, commit), as given by credentials.refusal
results_refused: Optional[Dict[str, Any]] = None


def project_name() -> Optional[str]:
  from .config import project
  return Path(project).as_posix() if project else None


def print_auth_error(r, message="Failed to update QA-Board", ingest=False):
  """
  When the server says why it refused a request (e.g. the token expired), prints it with what to do, once. Returns whether it did.
  `ingest`: the request sent results. In CI, `exit_if_results_refused` then fails with what to do.
  """
  global results_refused
  from .config import is_ci
  refused = refusal(r)
  if not refused:
    return False
  if ingest and results_refused is None:
    results_refused = refused
  if not first_time(f"{refused['reason']}: {refused['error']}"):
    return True
  click.secho(f"WARNING: {message}: {refused['error']}", fg='yellow', bold=True, err=True)
  fix = None if ingest and is_ci and refused['reason'] != 'missing_role' else fix_for(refused, qa_token_source, ci=is_ci, project=project_name(), server=qaboard_url)
  if fix:
    click.secho(f"         {fix}", fg='yellow', err=True)
  return True


def exit_if_results_refused():
  """In CI, exits with an error if QA-Board refused results qa sent (e.g. the token expired): they were not saved."""
  from .config import is_ci
  if not is_ci or not results_refused:
    return
  env_name = qa_token_source if qa_token_source in ('QABOARD_TOKEN', 'QA_TOKEN') else 'QABOARD_TOKEN'
  project = project_name()
  if results_refused['reason'] == 'missing_role':
    fix = f"The user of {env_name} must be a developer of {results_refused.get('project') or project or 'the project'}."
  else:
    fix = f"Set {env_name} to a valid token with the ingest scope{f' for {project}' if project else ''}."
  click.secho(f"ERROR: QA-Board refused the results ({results_refused['reason']}): they were not saved. {fix}", fg='red', bold=True, err=True)
  sys.exit(1)

def url_to_dir(url: str) -> Path:
  from .compat import linux_to_windows
  path = unquote(url)[2:]
  if os.name == 'nt':
    path = linux_to_windows(path)
  return Path(path)  


def dir_to_url(path: Path) -> str:
  if not path.is_absolute():
    raise ValueError(f"{path} is not absolute")
  return quote(f"/s{path.as_posix()}")


def print_url(ctx, status="starting"):
  if ctx.obj['offline']:
    return
  if os.environ.get('QA_BATCH'):
    return
  if '--list' in sys.argv:
    return
  batch_label = ctx.obj["batch_label"]
  commit_url = f"{qaboard_url}/{project.as_posix()}/commit/{commit_id[:10] if commit_id else ''}{f'?batch={quote(batch_label)}' if batch_label != 'default' else ''}"
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




def serialize_path(path):
  from .config import on_windows
  from .compat import windows_to_linux_path
  value = path
  if on_windows:
    try:
      value = windows_to_linux_path(path)
    except Exception:
      pass
    # The server expects to receive paths that are linux-style
    if issubclass(type(value), Path):
      value = value.as_posix()
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


def makeNumpyEncoder():
  # We can't use requests' json serialization (simplejson or json) because it fails with numpy arrays
  import simplejson
  class NumpyEncoder(simplejson.JSONEncoder):
      """Special simplejson encoder for numpy types"""
      def default(self, obj):
          # we take care not to import numpy unless it's already loaded
          if 'numpy' in str(type(obj)) and hasattr(obj, 'tolist'):
            return obj.tolist()
          else:
            return simplejson.JSONEncoder.default(self, obj)
  return NumpyEncoder



def notify_qa_database(object_type='output', **kwargs):
  """
  Updating the QA database.
  """
  import requests
  from .config import is_ci, config, _metrics
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
  # Will help initialize/update the commit/batch in QA-Board.
  # We send it with every object type, even if it's wasteful: it makes init easier
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
    import simplejson
    payload = simplejson.dumps(data, ignore_nan=True, cls=makeNumpyEncoder())
    r = requests.post(url, data=payload, headers=headers, verify=api_verify, timeout=api_timeout)
    if 'QA_VERBOSE' in os.environ:
      click.secho(r.text, fg='cyan', dim=True, err=True)
    print_server_warning(r)
    if print_auth_error(r, "QA-Board refused the results", ingest=True):
      return None
    r.raise_for_status()
    try:
      return r.json()
    except Exception:
      click.secho(f"WARNING: Can't understand the server response: {r.text}", fg='yellow', err=True)
  except Exception as e:
    click.secho(f'WARNING: [{e}] Failed to update QA-Board.', fg='yellow', bold=True, err=True)
    click.secho(url, fg='yellow', err=True)
    # what we sent (or failed to serialize), without the big fields
    data = {k: v for k, v in data.items() if k not in ['qaboard_config', 'qaboard_metrics', 'inputs_settings']}
    click.secho(str(data), fg='yellow', err=True)
    try:
      request_headers = {k: '<redacted>' if k.lower() == 'authorization' else v for k, v in r.request.headers.items()}
      click.secho(str(request_headers), fg='yellow', dim=True, err=True)
      click.secho(f'{r.status_code}: {r.text}', fg='yellow', dim=True, err=True)
    except Exception:
      pass


def get_output(output_id):
  import requests
  url = f"{api_prefix}/output/{output_id}/"
  try:
    r = requests.get(url, headers=headers, verify=api_verify, timeout=api_timeout)
    if print_auth_error(r, f"Failed to get output {output_id} from QA-Board"):
      return None
    r.raise_for_status()
    return r.json()
  except Exception:
    click.secho(f'WARNING: Failed to contact the QA-Board server. (GET Output {output_id})', fg='yellow', bold=True, err=True)
    try:
      click.secho(f'{r.status_code}: {r.text}', fg='yellow', dim=True, err=True)
    except Exception:
      pass


class ResultsUnreadable(Exception):
  """QA-Board refused to read results (e.g. signing in is required): `response` says why"""
  def __init__(self, response):
    super().__init__(f"QA-Board refused to read results ({response.status_code})")
    self.response = response


def batch_info(reference, batch, is_branch=False, project=project, metrics: Optional[List[str]]=None, ignore_errors=False):
  """Get data about a batch of outputs in the database. `ignore_errors` is for network errors and missing commits:
  refusals (e.g. signing in is required) raise ResultsUnreadable."""
  import requests
  params = {
    # project names use "/", but Path() uses "\\" on Windows
    "project": Path(project).as_posix(),
    "batch": batch,
    # the format is metric: target.... not great.
    "metrics": json.dumps({m: 0 for m in (metrics or available_metrics.keys())}),
  }
  if is_branch:
    params["branch"] = reference
  commit_id = reference if not is_branch else ''
  url = f'{api_prefix}/commit/{commit_id}'
  r = requests.get(url, params=params, headers=headers, verify=api_verify, timeout=api_timeout)
  try:
    r.raise_for_status()
    data = r.json()
  except Exception as e:
    if ignore_errors:
      if refusal(r):
        raise ResultsUnreadable(r)
      return {}
    if not print_auth_error(r, "Failed to get info from QA-Board"):
      click.secho(r.text, fg='red', err=True)
    click.secho(f'[ERROR]: Failed to get info from QA-Board. ({url} | {params})', fg='red', bold=True, err=True)
    raise e
  if 'batches' not in data:
    raise ValueError(f'We could not get the results for {batch} batch {reference}')
  batches = data["batches"]
  if batch not in batches:
    raise ValueError(f'We could not get the results for {batch} batch {reference}. Available: {list(b for b in batches)}')
  return batches[batch]


def get_outputs(qa_context: Optional[Dict[str, Any]], ignore_errors=False) -> Dict[int, Any]:
  if not qa_context:
    return {}
  should_notify_qa_database = (is_ci or qa_context['share']) and not (qa_context['dryrun'] or qa_context['offline'])
  if not should_notify_qa_database:
    return {}
  try:
    return batch_info(
      reference=commit_id,
      batch=qa_context['batch_label'],
      # we don't need any metric when calling this function from "qa batch", just the output dirs / configs 
      metrics=["none-required"],
      ignore_errors=ignore_errors,
    )['outputs']
  except ResultsUnreadable:
    raise
  except Exception:
    return {}


@lru_cache()
def aggregated_metrics(batch_label, metrics=None):
  info = batch_info(reference=commit_id, is_branch=False, batch=batch_label, metrics=metrics)
  # We also always return the aggregated metrics from the API,
  # it helps understand how metrics evolved during the optimization, irrelative of the objective function
  # Note: we could do the aggregation ourselves...
  aggregation = 'average' # aggregation = objective.get('aggregation', 'average')
  return {
    k.replace(f"_{aggregation}", ""): v
    for k, v in info['aggregated_metrics'].items()
    if k.endswith(aggregation)
  }


def matching_output(output_reference: RunContext, outputs: List[Dict]):
  """
  Return the output from a given batch that is like a given output.
  This helps us compare an output to historical results.
  """
  matching_outputs = [o for o in outputs if f'{o["test_input_database"]}/{o["test_input_path"]}' == output_reference.input_path.as_posix()]
  valid_outputs = [o for o in matching_outputs if not o["is_pending"]]
  def match_ref(output):
    output_ctx = RunContext.from_api_output(output)
    if not output_ctx.platform == output_reference.platform:
      return False
    if not json.dumps(output_ctx.configurations, sort_keys=True) == json.dumps(output_reference.configurations, sort_keys=True):
      return False
    if not json.dumps(output_ctx.extra_parameters, sort_keys=True) == json.dumps(output_reference.extra_parameters, sort_keys=True):
      return False
    return True
  valid_outputs = [o for o in valid_outputs if match_ref(o)]
  if not valid_outputs:
    return None
  # at most 1, guaranteed by database constraints
  assert len(valid_outputs) == 1
  return valid_outputs[0]
