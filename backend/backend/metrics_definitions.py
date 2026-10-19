"""
Metrics declared in code, next to those of the metrics file (outputs.metrics in qaboard.yaml).

The CLI sends with each run the definitions of the metrics its code declared (`qaboard.Metric`, `qaboard.define_metric`,
or a metrics_definitions.json the run wrote): `metrics_definitions` in POST /api/v1/output, e.g.
  {"latency": {"suffix": "ms", "smaller_is_better": true}, "frames": {"smaller_is_better": null}}
They are kept in the commit's data, and in the project's for commits on the reference branch (the project's are
what lists of commits use), under `metrics_definitions`: they never replace the metrics file's `qatools_metrics`.
Readers merge both, field by field, the code winning (`available_metrics` below, `merge_metrics_definitions` in
`webapp/src/utils.js`).
"""
from typing import Any, Dict, Optional

from sqlalchemy.orm.attributes import flag_modified


# a run declaring more is likely a bug: we don't let it bloat the commit
MAX_DEFINITIONS = 5000


def clean_definitions(definitions: Any) -> Dict[str, Dict]:
  """The definitions we keep: a mapping of metric keys to objects"""
  if not isinstance(definitions, dict):
    return {}
  cleaned = {str(k): v for k, v in definitions.items() if isinstance(v, dict)}
  if len(cleaned) > MAX_DEFINITIONS:
    return {}
  return cleaned


def merged_definitions(known: Optional[Dict], new: Dict) -> Optional[Dict]:
  """The known definitions updated with new ones, each replaced as a whole. None when nothing changes."""
  known = known or {}
  changed = {key: definition for key, definition in new.items() if known.get(key) != definition}
  if not changed:
    return None
  return {**known, **changed}


def available_metrics(qatools_metrics: Optional[Dict], definitions: Optional[Dict]) -> Dict[str, Dict]:
  """The metrics file's available_metrics, with the definitions from code merged in, field by field"""
  metrics = dict((qatools_metrics or {}).get('available_metrics') or {})
  for key, definition in (definitions or {}).items():
    metrics[key] = {**(metrics.get(key) or {}), **definition}
  return metrics


def _save(session, obj, definitions: Dict) -> bool:
  """Merges the definitions into obj.data, locking its row so that concurrent runs don't lose each other's"""
  if merged_definitions((obj.data or {}).get('metrics_definitions'), definitions) is None:
    return False
  session.refresh(obj, with_for_update=True)
  if obj.data is None:
    obj.data = {}
  updated = merged_definitions(obj.data.get('metrics_definitions'), definitions)
  if updated is not None:
    obj.data['metrics_definitions'] = updated
    flag_modified(obj, 'data')
  session.commit()
  return updated is not None


def save_metrics_definitions(session, ci_commit, data: Dict) -> None:
  """
  Saves the metrics a run declared in its commit, and in its project if the commit is on the reference branch
  (or if the project doesn't know any). Most runs declare what's already saved: then we don't write anything.
  One transaction per row, so that we never hold both locks.
  """
  definitions = clean_definitions(data.get('metrics_definitions'))
  if not definitions:
    return
  _save(session, ci_commit, definitions)

  project = ci_commit.project
  project_config = (data.get('qaboard_config') or {}).get('project') or {}
  is_reference = data.get('commit_branch') == project_config.get('reference_branch', 'master')
  if is_reference or not (project.data or {}).get('metrics_definitions'):
    _save(session, project, definitions)
