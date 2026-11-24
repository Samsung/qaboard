"""
Utilities related to CI database: fetching results, saving results... 
"""
import os
import re
import sys
import json
import math
import decimal
from pathlib import Path
from functools import lru_cache
from urllib.parse import quote, urlparse
from typing import Any

import click

# Only for the warning below: functions read project, commit_id and is_ci from qaboard.config when they're called,
# so that tests that reload or patch qaboard.config, or change directory, see the new values.
from .config import is_ci, is_doctor_command, is_command_without_project
from .run import RunContext

from .site_config import site_config, as_requests_verify
from .credentials import resolve_token, default_server, refusal, fix_for
from .auth import print_server_warning, first_time
from .http_client import LOG_HOOKS
from .compat import url_to_dir # noqa: F401 (qaboard.api.url_to_dir is used across qa)
from .payloads import results_payload, serialize_path, serialize_paths # noqa: F401 (qaboard.api.serialize_paths is used across qa)

qaboard_protocol = site_config('QABOARD_PROTOCOL', 'http')
qaboard_hostname = site_config('QABOARD_HOSTNAME')
qaboard_port = site_config('QABOARD_PORT')
qaboard_host = site_config('QABOARD_HOST')
# What gives the URL, e.g. "$QABOARD_URL", None for the default
qaboard_url, qaboard_url_source = default_server()
# Only when nothing says where the server is: QABOARD_URL=http://localhost:5151 is fine.
# `qa auth status` and `qa doctor` say it too.
# (`qa upload` doesn't guess: it says to set QABOARD_URL)
# Outside a CI, results then stay local, and `qa` says it in one line (qa.py, config.default_share)
if not qaboard_url_source and is_ci and sys.argv[1:2] not in (['auth'], ['runs']) and not is_doctor_command and not is_command_without_project:
  from .ui import warning
  warning(f"No QA-Board server is set: qa uses {qaboard_url}.",
          hint=["Set QABOARD_URL (e.g. https://qaboard.example.com), or QABOARD_HOST (e.g. qaboard-srv:443) with QABOARD_PROTOCOL.",
                "If your organization has a site package (qaboard-site-...), install it: it says where the server is."])

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
results_refused: dict[str, Any] | None = None


def project_name() -> str | None:
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
  fix = None if ingest and is_ci and refused['reason'] != 'missing_role' else fix_for(refused, qa_token_source, ci=is_ci, project=project_name(), server=qaboard_url)
  from .ui import warning
  warning(f"{message}: {refused['error']}", hint=fix)
  return True


# Why a server doesn't take the results of runs that would send it their files (backend/api/outputs.py)

from .conventions import UPLOAD_FIX, UPLOAD_REFUSALS  # noqa: E402 (shared with qaboard/active_run.py)


def print_upload_refusal(r) -> bool:
  """
  Without a storage shared with the server, runs send it their files (qaboard/upload.py): when it says that it
  doesn't take them, prints it with what to do, once. Returns whether it did. In CI, `exit_if_results_refused` fails.
  """
  global results_refused
  if r.status_code != 400:
    return False
  try:
    body = r.json()
  except ValueError:
    return False
  if not isinstance(body, dict) or body.get('reason') not in UPLOAD_REFUSALS:
    return False
  if results_refused is None:
    results_refused = {'reason': body['reason'], 'error': str(body.get('error') or '')}
  if first_time(f"{body['reason']}: {body.get('error')}"):
    from .ui import warning
    from .config import is_ci
    # in CI, exit_if_results_refused says what to do, at the end
    warning(f"QA-Board refused the results: {body.get('error')}", hint=None if is_ci else UPLOAD_FIX)
  return True


def exit_if_results_refused():
  """In CI, exits with an error if QA-Board refused results qa sent (e.g. the token expired): they were not saved."""
  from .config import is_ci
  if not is_ci or not results_refused:
    return
  env_name = qa_token_source if qa_token_source in ('QABOARD_TOKEN', 'QA_TOKEN') else 'QABOARD_TOKEN'
  project = project_name()
  if results_refused['reason'] in UPLOAD_REFUSALS:
    fix = UPLOAD_FIX
  elif results_refused['reason'] == 'missing_role':
    fix = f"The user of {env_name} must be a developer of {results_refused.get('project') or project or 'the project'}."
  else:
    fix = f"Set {env_name} to a valid token with the ingest scope{f' for {project}' if project else ''}."
  from .ui import fail
  fail(f"QA-Board refused the results ({results_refused['reason']}): they were not saved.", hint=fix)

def dir_to_url(path: Path) -> str:
  if not path.is_absolute():
    raise ValueError(f"{path} is not absolute")
  return quote(f"/s{path.as_posix()}")


def results_url(qa_context):
  """The web app's page with the commit's batch"""
  from .config import project, commit_id
  batch_label = qa_context["batch_label"]
  return f"{qaboard_url}/{project.as_posix()}/commit/{commit_id[:10] if commit_id else ''}{f'?batch={quote(batch_label)}' if batch_label != 'default' else ''}"


def print_url(ctx, status="starting"):
  if ctx.obj['offline']:
    return
  if os.environ.get('QA_BATCH'):
    return
  if '--list' in sys.argv:
    return
  from .config import is_ci
  batch_label = ctx.obj["batch_label"]
  commit_url = results_url(ctx.obj)
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




def _is_numpy(obj) -> bool:
  # we take care not to import numpy unless it's already loaded
  return 'numpy' in str(type(obj)) and hasattr(obj, 'tolist')


def makeNumpyEncoder():
  # We can't use requests' json serialization because it fails with numpy arrays
  import json
  class NumpyEncoder(json.JSONEncoder):
      """JSON encoder for numpy types"""
      def default(self, obj):
          if _is_numpy(obj):
            return obj.tolist()
          return super().default(obj)
  return NumpyEncoder


def json_ready(obj):
  """
  `obj` with what JSON can't say replaced: NaN and infinities by null, numpy arrays and numbers by lists and numbers,
  named tuples by objects, decimals by numbers (what simplejson did with `ignore_nan=True`).
  """
  if isinstance(obj, float):
    return obj if math.isfinite(obj) else None
  if isinstance(obj, (str, int, bool)) or obj is None:
    return obj
  if isinstance(obj, dict):
    return {k: json_ready(v) for k, v in obj.items()}
  if isinstance(obj, tuple) and hasattr(obj, '_asdict'):
    return json_ready(obj._asdict())
  if isinstance(obj, (list, tuple)):
    return [json_ready(v) for v in obj]
  if _is_numpy(obj):
    return json_ready(obj.tolist())
  if isinstance(obj, decimal.Decimal):
    return json_ready(float(obj))
  return obj



def _post_results(url: str, payload: str, ends: bool):
  """
  POSTs results. What ends a run, a batch or a commit is tried again when the server or the network may be back
  later: it's idempotent (the server only empties a run's folder when it starts), and when lost, so are the results.
  """
  import time
  import requests
  from .http_client import FINAL_RETRY_DELAYS, RETRY_DELAYS, TRANSIENT_STATUSES
  delays = list(FINAL_RETRY_DELAYS if ends else ())
  for tried, delay in enumerate((*delays, None)):
    try:
      r = requests.post(url, data=payload, headers=headers, verify=api_verify, timeout=api_timeout, hooks=LOG_HOOKS)
    except (requests.ConnectionError, requests.Timeout) as e:
      # nothing that answers there, e.g. no server: we don't wait long
      unreachable = isinstance(e, requests.ConnectionError) and not isinstance(e, requests.Timeout) and tried >= len(RETRY_DELAYS)
      if delay is None or unreachable or isinstance(e, requests.exceptions.SSLError):
        raise
    else:
      if delay is None or r.status_code not in TRANSIENT_STATUSES:
        return r
      r.close()
    from .ui import warning
    warning(f"QA-Board didn't take the results, trying again in {delay:.0f}s...")
    time.sleep(delay)


def notify_qa_database(object_type='output', **kwargs):
  """
  Updating the QA database.
  """
  from .config import is_ci, config, _metrics, run_context, commit_id, commit_data, uploads_files, repo_default_branch

  if kwargs.get('offline'):
    return

  # we only update QA-Board if we're in a CI run, or if the user used `qa --ci`
  if not (is_ci or kwargs['share']):
    return

  url = f"{api_prefix}/{object_type}/"
  # send all the data, with where it comes from and what describes its commit and project (qaboard/payloads.py)
  data = results_payload(kwargs, is_ci=is_ci, run_context=run_context(), commit_id=commit_id, commit=commit_data(), config=config, metrics_file=_metrics,
                         uploads_files=uploads_files, default_branch=repo_default_branch())
  if 'QA_VERBOSE' in os.environ:
    click.secho(url, fg='cyan', err=True)
    click.secho(str(data), fg='cyan', dim=True, err=True)

  try:
    payload = json.dumps(json_ready(data), cls=makeNumpyEncoder())
    r = _post_results(url, payload, ends=object_type == 'output' and not data.get('is_running') and not data.get('is_pending'))
    if 'QA_VERBOSE' in os.environ:
      click.secho(r.text, fg='cyan', dim=True, err=True)
    print_server_warning(r)
    if print_auth_error(r, "QA-Board refused the results", ingest=True):
      return None
    if print_upload_refusal(r):
      return None
    r.raise_for_status()
    try:
      return r.json()
    except Exception:
      from .ui import warning
      warning(f"Can't understand the answer of QA-Board ({url}): {r.text[:300]}")
  except Exception as e:
    from .ui import warning, verbose, request_problem, is_connection_error
    if is_connection_error(e):
      # said once: a batch would say it for each run
      if first_time(f"unreachable: {qaboard_url}"):
        warning(f"Could not reach QA-Board at {qaboard_url}: {request_problem(e)}. The results were not sent.",
                hint="Check that the server is up and that QABOARD_URL is right, or use `qa --offline`. `qa doctor` checks the connection.")
    else:
      try:
        answer = f"\nQA-Board answered {r.status_code}: {r.text[:500]}"
      except Exception:
        answer = ''  # e.g. the data could not be serialized: nothing was sent
      warning(f"Failed to update QA-Board ({url}): {e}{answer}",
              hint=None if verbose() else "`qa --verbose` shows what was sent.")
    if verbose():
      # what we sent (or failed to serialize), without the big fields
      data = {k: v for k, v in data.items() if k not in ['qaboard_config', 'qaboard_metrics', 'inputs_settings']}
      click.secho(str(data), fg='yellow', err=True)
      try:
        request_headers = {k: '<redacted>' if k.lower() == 'authorization' else v for k, v in r.request.headers.items()}
        click.secho(str(request_headers), fg='yellow', dim=True, err=True)
      except Exception:
        pass


def get_output(output_id):
  import requests
  url = f"{api_prefix}/output/{output_id}/"
  try:
    r = requests.get(url, headers=headers, verify=api_verify, timeout=api_timeout, hooks=LOG_HOOKS)
    if print_auth_error(r, f"Failed to get output {output_id} from QA-Board"):
      return None
    r.raise_for_status()
    return r.json()
  except Exception:
    from .ui import warning
    try:
      answer = f'{r.status_code}: {r.text[:300]}'
    except Exception:
      answer = None
    warning(f"Could not get the run {output_id} from QA-Board ({url}){f': {answer}' if answer else ''}")


class ResultsUnreadable(Exception):
  """QA-Board refused to read results (e.g. signing in is required): `response` says why"""
  def __init__(self, response):
    super().__init__(f"QA-Board refused to read results ({response.status_code})")
    self.response = response


def batch_info(reference, batch, is_branch=False, project=None, metrics: list[str] | None=None, ignore_errors=False):
  """Get data about a batch of outputs in the database. `ignore_errors` is for network errors and missing commits:
  refusals (e.g. signing in is required) raise ResultsUnreadable. `project` defaults to the current project."""
  import requests
  from .config import available_metrics
  if project is None:
    from .config import project
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
  r = requests.get(url, params=params, headers=headers, verify=api_verify, timeout=api_timeout, hooks=LOG_HOOKS)
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
    from .ui import error
    error(f'Failed to get info from QA-Board: {r.status_code} ({url} | {params})')
    raise e
  if 'batches' not in data:
    raise ValueError(f'We could not get the results for {batch} batch {reference}')
  batches = data["batches"]
  if batch not in batches:
    raise ValueError(f'We could not get the results for {batch} batch {reference}. Available: {list(b for b in batches)}')
  return batches[batch]


def get_outputs(qa_context: dict[str, Any] | None, ignore_errors=False) -> dict[int, Any]:
  if not qa_context:
    return {}
  from .config import is_ci, commit_id
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


@lru_cache
def aggregated_metrics(batch_label, metrics=None):
  from .config import commit_id
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


def matching_output(output_reference: RunContext, outputs: list[dict]):
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
