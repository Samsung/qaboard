"""
The backend's logs: on stderr, what `docker compose logs backend` (or `kubectl logs`) shows. Stdlib logging.

- Code logs to `logger = logging.getLogger(__name__)` ("backend.*"). configure() sets the handler, once per process:
  the web server's workers (backend/__init__.py), `qaboard-admin` and its jobs worker, the migrations (alembic/env.py).
- $QABOARD_LOG_LEVEL (default INFO): the level of QA-Board's loggers. Other libraries log warnings, alembic its steps.
- $QABOARD_LOG_FORMAT: `text` (default), or `json`: one object per line, with the records' fields, for log collectors.
- API requests: one line each (logger "backend.requests", register_requests()): method, path (without the query
  string: tokens can be there), status, duration, user, project. Health checks and nginx's file authorizations are
  debug lines. Records logged while handling a request carry its `request_id`: the proxy's X-Request-ID, else a new
  one, sent back in the response's X-Request-ID.
- No secrets: no headers, cookies, query strings or bodies. Usernames are fine.
"""
import datetime
import json
import logging
import os
import sys
import time
import uuid
from typing import Mapping, Optional

LEVEL_VARIABLE = 'QABOARD_LOG_LEVEL'
FORMAT_VARIABLE = 'QABOARD_LOG_FORMAT'
# Requests logged at debug level, unless they fail: the healthchecks, and nginx asking whether users can read a file
QUIET_ENDPOINTS = {'health', 'authorize_files'}
REQUEST_ID_HEADER = 'X-Request-ID'

# the attributes of every LogRecord: the others are the `extra` fields we add to JSON lines
_STANDARD = set(vars(logging.LogRecord('', 0, '', 0, '', (), None))) | {'message', 'asctime', 'request_id'}
_OURS = '_qaboard_handler'


def level_from(env: Mapping[str, str]) -> int:
  value = (env.get(LEVEL_VARIABLE) or '').strip()
  if value.isdigit():
    return int(value)
  level = logging.getLevelName(value.upper()) if value else logging.INFO
  return level if isinstance(level, int) else logging.INFO


def request_id() -> Optional[str]:
  """The id of the request being handled, if any"""
  try:
    from flask import g, has_request_context
  except ImportError:
    return None
  return g.get('request_id') if has_request_context() else None


class RequestId(logging.Filter):
  """Adds `request_id` to the records logged while handling a request"""
  def filter(self, record: logging.LogRecord) -> bool:
    if not hasattr(record, 'request_id'):
      record.request_id = request_id()
    return True


class TextFormatter(logging.Formatter):
  """2026-11-24 10:00:01,234 INFO backend.requests [3f2a...] GET /api/v1/... 200 12ms user=alice"""
  def __init__(self):
    super().__init__('%(asctime)s %(levelname)s %(name)s%(_request)s %(message)s')

  def format(self, record: logging.LogRecord) -> str:
    rid = getattr(record, 'request_id', None)
    record._request = f" [{rid}]" if rid else ''
    return super().format(record)


class JsonFormatter(logging.Formatter):
  """{"time": ..., "level": "INFO", "logger": ..., "message": ..., "request_id": ..., <extra fields>, "exception": ...}"""
  def format(self, record: logging.LogRecord) -> str:
    line = {
      "time": datetime.datetime.fromtimestamp(record.created, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
      "level": record.levelname,
      "logger": record.name,
      "message": record.getMessage(),
    }
    if getattr(record, 'request_id', None):
      line['request_id'] = record.request_id
    for key, value in vars(record).items():
      if key not in _STANDARD and not key.startswith('_'):
        line[key] = value
    if record.exc_info:
      line['exception'] = self.formatException(record.exc_info)
    elif record.exc_text:
      line['exception'] = record.exc_text
    if record.stack_info:
      line['stack'] = self.formatStack(record.stack_info)
    return json.dumps(line, default=str, ensure_ascii=False)


def formatter_for(env: Mapping[str, str]) -> logging.Formatter:
  kind = (env.get(FORMAT_VARIABLE) or 'text').strip().lower()
  return JsonFormatter() if kind == 'json' else TextFormatter()


def configure(env: Optional[Mapping[str, str]] = None) -> None:
  """The process's logging: one handler on stderr, on the root logger. Can be called again (it replaces ours)"""
  env = os.environ if env is None else env
  root = logging.getLogger()
  for handler in list(root.handlers):
    if getattr(handler, _OURS, False):
      root.removeHandler(handler)
  handler = logging.StreamHandler(sys.stderr)
  handler.setFormatter(formatter_for(env))
  handler.addFilter(RequestId())
  setattr(handler, _OURS, True)
  root.addHandler(handler)
  root.setLevel(logging.WARNING)
  logging.getLogger('backend').setLevel(level_from(env))
  # the migrations it runs
  logging.getLogger('alembic').setLevel(logging.INFO)


def register_requests(app) -> None:
  """One log line per API request, and the requests' ids. Register it first: it then times the other hooks too"""
  from flask import g, request
  logger = logging.getLogger('backend.requests')

  @app.before_request
  def start_request():
    g.request_started = time.perf_counter()
    given = request.headers.get(REQUEST_ID_HEADER, '')
    g.request_id = given[:64] if given and given.isprintable() else uuid.uuid4().hex[:16]

  @app.after_request
  def log_request(response):
    rid = g.get('request_id')
    if rid:
      response.headers.setdefault(REQUEST_ID_HEADER, rid)
    started = g.get('request_started')
    duration_ms = round((time.perf_counter() - started) * 1000, 1) if started is not None else None
    status = response.status_code
    if status >= 500:
      level = logging.WARNING  # the error itself is logged (and sent to Sentry) where it happened
    elif request.endpoint in QUIET_ENDPOINTS:
      level = logging.DEBUG
    else:
      level = logging.INFO
    if not logger.isEnabledFor(level):
      return response
    user = None
    actor = g.get('actor')
    if actor is not None and getattr(actor, 'user', None) is not None:
      user = getattr(actor.user, 'user_name', None)
    project = request.args.get('project') or (request.view_args or {}).get('project')
    logger.log(level, "%s %s %s %sms%s%s", request.method, request.path, status, duration_ms if duration_ms is not None else '?',
               f" user={user}" if user else '', f" project={project}" if project else '',
               extra={"method": request.method, "path": request.path, "status": status, "duration_ms": duration_ms,
                      "endpoint": request.endpoint, "user": user, "project": project})
    return response
