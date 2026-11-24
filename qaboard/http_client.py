"""
How qa talks to the QA-Board server: one request, tried again when it may work later, and errors that say why.

    from .http_client import request, request_json, download, ResultsError
    answer = request_json(server, f"output/{run_id}/metrics", method='PATCH', json=payload, retries=RETRY_DELAYS)
    download(server, "/s/path/of/run/manifest.outputs.json", file, sha256=expected, retries=RETRY_DELAYS)

- Paths without a leading "/" are API paths, under /api/v1/. Paths with one are the server's own URLs, like the
  `/s/...` of runs' files the API gives (`output_dir_url`).
- The token is the one given, else the one qa is signed in with for that server (`results._token_for`). TLS
  verification follows QABOARD_API_VERIFY (qaboard/site_config.py), proxies the usual environment variables.
- `retries`: how long to wait before each new try, e.g. (1, 4) for 3 tries. Only for what may work later
  (`ResultsError.is_transient`): network errors and timeouts, 408, 429, 500, 502, 503, 504, and the 520-524 of
  cloud load balancers. FINAL_RETRY_DELAYS (about 2 minutes) is for requests whose failure loses results. The server's
  Retry-After is waited for, up to MAX_RETRY_AFTER. None by default: requests that aren't idempotent (appending to
  a log at an offset, creating a run) decide themselves what to do when an answer is lost.
- Errors are `ResultsError`: `status` (None when the server didn't answer), `reason` (the server's reason code, for
  programs: qaboard/conventions.py `Reason`), `body` (its JSON answer), and a message for people.
"""
import email.utils
import hashlib
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Sequence, Tuple, Union

from .conventions import Reason
from .site_config import site_config, as_requests_verify


# (connect, read) timeouts: commits with thousands of runs take a while to serialize
REQUEST_TIMEOUT = (30.0, 600.0)
# For files: we connect faster, a slow read is a large file
FILE_TIMEOUT = (10.0, 600.0)
# How long we wait before trying a request again: 3 tries
RETRY_DELAYS = (1.0, 4.0)
# For idempotent requests whose failure loses results (a run's end, its last files): longer than a server's restart
FINAL_RETRY_DELAYS = (1.0, 4.0, 15.0, 30.0, 60.0)
# What may work later: a busy, restarting or overloaded server, or a proxy in front of it (520-524: Cloudflare's)
TRANSIENT_STATUSES = (408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524)
# answered with one of those statuses, but the same request won't work later
FINAL_REASONS = (Reason.PROXY_MISCONFIGURED,)
# We wait for the server's Retry-After up to this, in seconds: longer, we'd rather fail and say so
MAX_RETRY_AFTER = 60.0
# Refusals of the token: signing in again, or another token, fixes them
# (backend/backend/actor.py; invalid_token: older servers)
TOKEN_REASONS = ('sign_in_required', 'login_required', 'ingest_token_required', 'missing_scope', 'token_invalid', 'token_expired',
                 'token_idle_expired', 'token_revoked', 'invalid_token')
CHUNK = 1024 * 1024

logger = logging.getLogger(__name__)

Timeout = Tuple[float, float]
# A request's body: bytes, a file, or what gives one for each try (a file is closed after)
Body = Union[None, bytes, Any, Callable[[], Any]]


class ResultsError(Exception):
  """
  The server didn't do what we asked: unknown project or commit, refused request, network error...
  `status` is its HTTP status when it answered, `reason` why it refused the request (e.g. "missing_role",
  "uploads_disabled": qaboard/conventions.py `Reason`), `body` its JSON answer.
  """
  def __init__(self, message: str, status: Optional[int] = None, reason: Optional[str] = None, body: Optional[Dict[str, Any]] = None,
               transient: Optional[bool] = None, retry_after: Optional[float] = None):
    super().__init__(message)
    self.status = status
    self.reason = reason
    # the server's answer to requests it didn't accept, e.g. {"reason": "offset_mismatch", "size": 120}
    self.body: Dict[str, Any] = body or {}
    self._transient = transient
    # how long the server asked us to wait before trying again, in seconds
    self.retry_after = retry_after
    # we couldn't connect at all
    self.unreachable = False

  @property
  def is_transient(self) -> bool:
    """A network error, or a busy or restarting server: the same request may work later"""
    if self._transient is not None:
      return self._transient
    return self.status is None or self.status in TRANSIENT_STATUSES

  @property
  def is_refusal(self) -> bool:
    """The server refused who we are: no token, an expired one, a missing role..."""
    return self.status in (401, 403)


class DigestMismatch(ResultsError):
  """What we downloaded doesn't have the SHA-256 we expected: the file changed meanwhile? Tried again."""
  def __init__(self, message: str):
    super().__init__(message, transient=True)


def url_for(server: str, path: str) -> str:
  """An API path ("output/1/files/a.txt") or a path on the server ("/s/...") as a URL"""
  server = server.rstrip('/')
  return f"{server}{path}" if path.startswith('/') else f"{server}/api/v1/{path}"


def _retry_after(r) -> Optional[float]:
  value = getattr(r, 'headers', {}).get('Retry-After')
  if not isinstance(value, str) or not value.strip():
    return None
  try:
    return max(0.0, float(value))
  except ValueError:
    pass
  try:
    when = email.utils.parsedate_to_datetime(value)
    return max(0.0, when.timestamp() - time.time())
  except (TypeError, ValueError, IndexError, OverflowError):
    return None


def error_for(r, server: str, path: str, method: str = 'GET', params: Optional[Dict[str, Any]] = None) -> ResultsError:
  """The error for an answer >= 400: the server's sentence when it gave one, its reason, its JSON"""
  from .credentials import refusal
  retry_after = _retry_after(r) if r.status_code in TRANSIENT_STATUSES else None
  refused = refusal(r)
  if refused:
    scope = 'ingest' if method != 'GET' else 'read'
    hint = (f"Sign in with `qa auth login {server}`, or set QABOARD_TOKEN to a token with the {scope} scope."
            if refused.get('reason') in TOKEN_REASONS else "Ask the project's owners for access.")
    return ResultsError(f"{refused['error']} ({refused.get('reason')}). {hint}", status=r.status_code, reason=refused.get('reason') or 'refused',
                        body=_json_dict(r), retry_after=retry_after)
  body = _json_dict(r)
  message = body.get('error') if isinstance(body.get('error'), str) and body.get('error') else _text(r)
  reason = body.get('reason') if isinstance(body.get('reason'), str) and body.get('reason') else None
  where = f"{path}{f' ({params})' if params else ''}"
  # a proxy that doesn't check tokens won't start to: not worth trying again
  final = reason in FINAL_REASONS
  return ResultsError(f"{server} answered {r.status_code} to {where}: {message}", status=r.status_code, reason=reason,
                      body=body or None, transient=False if final else None, retry_after=None if final else retry_after)


def _json_dict(r) -> Dict[str, Any]:
  try:
    body = r.json()
  except (ValueError, AttributeError, TypeError):
    return {}
  return body if isinstance(body, dict) else {}


def _text(r) -> str:
  text = getattr(r, 'text', '')
  return text if isinstance(text, str) else str(text)


_sessions = threading.local()


def _session():
  """This thread's requests.Session: connections are reused (the uploader sends from several threads). Not across a fork"""
  import requests
  session = getattr(_sessions, 'session', None)
  if session is None or _sessions.pid != os.getpid():
    from . import __version__
    session = requests.Session()
    session.headers['User-Agent'] = f"qaboard/{__version__}"
    _sessions.session, _sessions.pid = session, os.getpid()
  return session


def log_response(r, *args, **kwargs) -> None:
  """Logs a request and its answer at debug level: method, URL, status, duration. Never the headers (tokens)"""
  if logger.isEnabledFor(logging.DEBUG):
    from .log_setup import scrub
    elapsed = getattr(r, 'elapsed', None)
    logger.debug("%s %s => %s in %.0fms", getattr(r.request, 'method', '?'), scrub(str(r.url)), r.status_code,
                 elapsed.total_seconds() * 1000 if elapsed is not None else -1)


# for requests that don't go through request(): requests.get(..., hooks=LOG_HOOKS)
LOG_HOOKS = {'response': log_response}


def _once(server: str, path: str, *, method: str, params, json, data: Body, headers: Optional[Dict[str, str]], token: Optional[str],
          timeout: Timeout, stream: bool):
  import requests
  from .results import _token_for
  token = _token_for(server, token)
  headers = {**(headers or {}), **({'Authorization': f"Bearer {token}"} if token else {})}
  verify = as_requests_verify(site_config('QABOARD_API_VERIFY'))
  body = data() if callable(data) else data
  started = time.monotonic()
  try:
    r = _session().request(method, url_for(server, path), params=params, json=json, data=body, headers=headers, verify=verify, timeout=timeout, stream=stream)
  except (requests.exceptions.InvalidURL, requests.exceptions.MissingSchema, requests.exceptions.InvalidSchema, requests.exceptions.InvalidHeader) as e:
    _log_failure(method, server, path, started, e)
    # the same again won't work: QABOARD_URL, a header...
    raise ResultsError(f"Could not reach {server}: {e}", transient=False) from e
  except requests.RequestException as e:
    _log_failure(method, server, path, started, e)
    # a certificate we don't trust won't be trusted on the next try either (QABOARD_API_VERIFY). Other TLS errors can pass
    untrusted = isinstance(e, requests.exceptions.SSLError) and 'CERTIFICATE_VERIFY_FAILED' in str(e)
    from .ui import request_problem, verbose
    # requests' own message is long: with --verbose
    error = ResultsError(f"Could not reach QA-Board at {server}: {request_problem(e)}" + (f" ({e})" if verbose() else ''), transient=False if untrusted else None)
    # nothing answers there (no server, a wrong port): not worth the longest retries
    error.unreachable = isinstance(e, requests.ConnectionError) and not isinstance(e, requests.Timeout)
    raise error from e
  finally:
    close = getattr(body, 'close', None)
    if callable(data) and callable(close):
      close()
  log_response(r)
  if r.status_code >= 400:
    error = error_for(r, server, path, method, params)
    r.close()
    raise error
  return r


def _log_failure(method: str, server: str, path: str, started: float, error: Exception) -> None:
  if logger.isEnabledFor(logging.DEBUG):
    from .log_setup import scrub
    logger.debug("%s %s failed after %.0fms: %s", method, scrub(url_for(server, path)), (time.monotonic() - started) * 1000, scrub(str(error)))


def retried(attempt: Callable[[], Any], retries: Sequence[float] = (), give_up: Optional[Callable[[], bool]] = None) -> Any:
  """`attempt()`, tried again after each delay of `retries` when it raised a transient ResultsError (unless `give_up()`)"""
  for tried, delay in enumerate((*retries, None)):
    try:
      return attempt()
    except ResultsError as e:
      if delay is None or not e.is_transient or (give_up is not None and give_up()):
        raise
      if e.unreachable and tried >= len(RETRY_DELAYS):
        raise
      if e.retry_after is not None and e.retry_after > MAX_RETRY_AFTER:
        raise
      wait = max(delay, e.retry_after or 0.0)
      logger.info("trying again in %.0fs (%d/%d): %s", wait, tried + 1, len(retries), e)
      time.sleep(wait)


def request(server: str, path: str, *, method: str = 'GET', params: Optional[Dict[str, Any]] = None, json: Any = None,
            data: Body = None, headers: Optional[Dict[str, str]] = None, token: Optional[str] = None,
            timeout: Optional[Timeout] = None, retries: Sequence[float] = (), give_up: Optional[Callable[[], bool]] = None,
            stream: bool = False):
  """
  The server's answer (a `requests.Response`, status < 400), else raises ResultsError.
  `data`: a body that isn't JSON, e.g. a file's content. With `retries`, give a callable that gives it for each try.
  `give_up()`: checked before trying again, e.g. another thread learned the server refuses everything.
  `stream`: the caller reads the answer as it comes, and closes it.
  """
  if retries and data is not None and not callable(data) and not isinstance(data, (bytes, bytearray, str)):
    raise ValueError("A file sent with retries must be given as a callable that opens it: each try reads it again")
  return retried(lambda: _once(server, path, method=method, params=params, json=json, data=data, headers=headers, token=token,
                               timeout=timeout or REQUEST_TIMEOUT, stream=stream), retries, give_up)


def request_json(server: str, path: str, **kwargs) -> Dict[str, Any]:
  """`request()`, for the API's JSON answers"""
  r = request(server, path, **kwargs)
  try:
    answer = r.json()
  except ValueError as e:
    raise ResultsError(f"Can't understand the answer of {url_for(server, path)}: {_text(r)[:200]}", status=r.status_code, transient=False) from e
  return answer


def download(server: str, path: str, file: Path, *, sha256: Optional[str] = None, token: Optional[str] = None,
             timeout: Optional[Timeout] = None, retries: Sequence[float] = ()) -> str:
  """
  Saves what the server serves at `path` (e.g. a run's file, "/s/...") in `file`, as it comes. Returns its SHA-256.
  With `sha256`, a download that doesn't have it raises DigestMismatch, tried again like a network error.
  """
  import requests

  def attempt() -> str:
    digest = hashlib.sha256()
    with request(server, path, token=token, timeout=timeout or FILE_TIMEOUT, stream=True) as r:
      try:
        with open(file, 'wb') as f:
          for chunk in r.iter_content(CHUNK):
            f.write(chunk)
            digest.update(chunk)
      except requests.RequestException as e:  # the connection was lost while reading
        raise ResultsError(f"Could not download {url_for(server, path)}: {e}") from e
    if sha256 is not None and digest.hexdigest() != sha256:
      raise DigestMismatch(f"{path} doesn't have the SHA-256 the server listed: it was replaced while we fetched it? Try again.")
    return digest.hexdigest()
  return retried(attempt, retries)
