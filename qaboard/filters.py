"""
The web app's filter box, in Python: which runs a filter like "night -crash status:success" keeps.

It's a port of `filter_batch` and `match_query` (webapp/src/utils.js), so that `qaboard.runs(url)`, the CLI and the
server keep exactly the runs the web app shows. Both are tested against tests/fixtures/filters.json: change one,
change the other.

A filter is a list of words. A run matches when its description contains every word (as a regular expression), and
none of those starting with "-". The description is the input's path, the configurations, the input's metadata, the
tuning parameters, the batch of qaboard.yaml it comes from, "fail crash status:failed" when it failed, "pending running"
when it hasn't finished, "status:success" when it succeeded, the platform and "id:<run id>". Everything is lowercase,
and "key=value" or "key: value" count as "key:value". "id:12" is run 12, not 123.
"""
import re
from typing import Any, Callable, Dict, Iterable, List, Optional

from .matching import js_stringify


def _safe_regex(token: str) -> "re.Pattern[str]":
  """Filters are typed by people: an invalid regular expression matches literally, like in the web app."""
  try:
    return re.compile(token)
  except re.error:
    return re.compile(re.sub(r'\W', '.', token))


def _token_regex(token: str) -> "re.Pattern[str]":
  """A word of a filter as a regular expression: "id:12" is run 12, not 123."""
  if re.fullmatch(r'id:\d+', token):
    return re.compile(rf'{token}(?!\d)')
  return _safe_regex(token)


def match_query(pattern: Optional[str]) -> Callable[[str], bool]:
  """A predicate on a run's description (see `searched_text`) for a filter like the web app's filter box."""
  if pattern is None:
    return lambda searched: True
  tokens = (pattern.strip().lower()
            .replace('"', '')
            # "key=value" and "key: value" are "key:value"
            )
  tokens = re.sub(r'(=+|: )', ':', tokens)
  # Some hardware teams have pipes in register names: the web app is accommodating too
  for ext in ('sim', 'def', 'eco'):
    tokens = tokens.replace(f'.{ext}|', f'.{ext}.')
  words = tokens.split(' ')
  negative = [t[1:] for t in words if t.startswith('-') and len(t) > 1]
  positive = [t for t in words if not t.startswith('-')]
  positive_regexes = [_token_regex(t) for t in positive]
  negative_ids = [_token_regex(t) for t in negative if re.fullmatch(r'id:\d+', t)]
  negative = [t for t in negative if not re.fullmatch(r'id:\d+', t)]

  def matches(searched: str) -> bool:
    searched = re.sub(r'(=+|: )', ':', searched.lower()).replace('"', '')
    if any(token in searched for token in negative) or any(r.search(searched) for r in negative_ids):
      return False
    # "" (from an empty filter, or spaces) matches everything, like in the web app
    return all(r.search(searched) for r in positive_regexes)
  return matches


def run_params(configurations: Optional[List[Any]], extra_parameters: Optional[Dict[str, Any]]) -> Dict[str, Any]:
  """Every parameter of a run, as the web app shows them: the keys of its configurations' objects, then the tuning parameters."""
  params: Dict[str, Any] = {}
  for c in [*(configurations or []), extra_parameters]:
    if isinstance(c, dict):
      params.update(c)
  return params


def searched_text(*, id: Any, test_input_path: str, platform: Optional[str], configurations: Optional[List[Any]],
                  extra_parameters: Optional[Dict[str, Any]], test_input_metadata: Optional[Dict[str, Any]] = None,
                  batch: Optional[str] = None, is_failed: bool = False, is_pending: bool = False, is_running: bool = False) -> str:
  """
  What a filter is matched against, for one run: the same text as the web app's `filter_batch`, so the same runs match.
  `batch` is the batch of qaboard.yaml the run comes from (`data.batch`), not the batch label.
  """
  metadata = js_stringify(test_input_metadata) if test_input_metadata else ''
  failed = 'fail crash status:failed' if is_failed else ''
  pending = 'pending running' if is_pending else ''
  status = 'status:success' if not (is_failed or is_pending or is_running) else ''
  # JavaScript prints a missing batch as "undefined": nobody filters on it, we keep the texts identical
  batch_text = batch if batch is not None else 'undefined'
  params = js_stringify(run_params(configurations, extra_parameters))
  return f"{test_input_path} {js_stringify(configurations)} {metadata} {params} {batch_text} {failed} {pending} {status} {platform} id:{id}"


def searched_text_of(output: Dict[str, Any]) -> str:
  """`searched_text` for a run as the API gives it (an "output" of /api/v1/commit/<id>)."""
  data: Dict[str, Any] = output['data'] if isinstance(output.get('data'), dict) else {}
  extra_parameters: Dict[str, Any] = output.get('extra_parameters') or {}
  # runs can send their effective parameters, the web app shows them over the tuning parameters
  if isinstance(data.get('params'), dict):
    extra_parameters = {**extra_parameters, **data['params']}
  return searched_text(
    id=output.get('id'),
    test_input_path=str(output.get('test_input_path', '')),
    platform=output.get('platform'),
    configurations=output.get('configurations'),
    extra_parameters=extra_parameters,
    test_input_metadata=output.get('test_input_metadata'),
    batch=data.get('batch'),
    is_failed=bool(output.get('is_failed')),
    is_pending=bool(output.get('is_pending')),
    is_running=bool(output.get('is_running')),
  )


def filter_runs(pattern: Optional[str], outputs: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
  """The runs (as the API gives them) a filter keeps, in order."""
  if not pattern or not pattern.strip():
    return list(outputs)
  matches = match_query(pattern)
  return [o for o in outputs if matches(searched_text_of(o))]
