"""
What a project's owners set from its Admin pages (docs/rfcs/project-admin.md), kept in models/ProjectSettings.

The quality gate's settings are stored as written, in qaboard.yaml's format, and validated with the CLI's parser:
one vocabulary, one validation. `qa gate` gets them with the numbers it compares (api/compare.py), and checks the
project's rules on top of the commit's own: a commit can't change them.
"""
import json
from typing import Any, Dict, Optional, Tuple

from qaboard.gate import parse_config, GateConfigError, Rule, ON_LOOSER_RULES, PROJECT_GATE_KEYS as GATE_KEYS

# GATE_KEYS: what a project's gate settings can have, as `qa gate` reads them. `expect_batches`: the batches that
# must have runs, on top of those the commit's qaboard.yaml expects. ON_LOOSER_RULES: when a commit's own rules
# are looser than the reference's, say so (warn), or fail the gate.
MAX_RULES = 200
# `qa gate` gets them with each comparison, the page with the project's settings: they stay small
MAX_GATE_BYTES = 64 * 1024


class SettingsError(ValueError):
  pass


def clean_gate(gate: Any) -> Optional[Dict[str, Any]]:
  """
  The gate settings to save, from what the web app sent. None removes them. Raises SettingsError with what to fix.
  """
  if gate is None:
    return None
  if not isinstance(gate, dict):
    raise SettingsError("gate: expected an object with `rules`, `max_failed_runs`, `require_bit_accuracy`, `on_looser_rules`, `expect_batches`")
  unknown = set(gate) - set(GATE_KEYS)
  if unknown:
    raise SettingsError(f"gate: unknown keys {', '.join(sorted(unknown))}. Use: {', '.join(GATE_KEYS)}")
  rules = gate.get('rules') or []
  if isinstance(rules, list) and len(rules) > MAX_RULES:
    raise SettingsError(f"gate.rules: at most {MAX_RULES} rules")
  on_looser_rules = gate.get('on_looser_rules') or 'warn'
  if on_looser_rules not in ON_LOOSER_RULES:
    raise SettingsError(f"gate.on_looser_rules: expected one of {', '.join(ON_LOOSER_RULES)}, got {on_looser_rules!r}")
  cleaned = {
    'rules': rules,
    # unlike in qaboard.yaml, no value means no limit from the project: the commit's own applies
    'max_failed_runs': gate.get('max_failed_runs'),
    'require_bit_accuracy': gate.get('require_bit_accuracy') or False,
  }
  # Only when set: settings saved before it existed, and older `qa`, don't have it. A list, or a list per label.
  expect_batches = gate.get('expect_batches')
  if expect_batches not in (None, [], {}):
    cleaned['expect_batches'] = expect_batches
  try:
    parse_config({'gate': cleaned})
  except GateConfigError as e:
    raise SettingsError(str(e))
  cleaned = {**cleaned, 'on_looser_rules': on_looser_rules}
  if len(json.dumps(cleaned)) > MAX_GATE_BYTES:
    raise SettingsError(f"gate: too long, at most {MAX_GATE_BYTES // 1024} KB: fewer rules, or shorter names and patterns")
  return cleaned


def rule_row(rule: Rule) -> Dict[str, Any]:
  """A limit of a rule, and which runs it checks: `batch` and `label` are names or patterns, None for all"""
  return {'metric': rule.metric, 'kind': rule.kind, 'limit': rule.limit, 'aggregate': rule.aggregate, 'batch': rule.batch, 'label': rule.label}


def describe_yaml_gate(config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
  """
  The `gate:` section of a qaboard.yaml, as the Quality gate page shows it: one row per limit, as `qa gate` reads them.
  `has_config`: whether we have a configuration at all (projects that never sent results don't).
  """
  # `batches`: the labels checked, by their older name. `expect_batches`: {label or pattern, '*' for all: [batches]}
  empty = {'rules': [], 'max_failed_runs': None, 'require_bit_accuracy': False, 'reference': None, 'labels': [], 'batches': [],
           'expect_batches': {}, 'error': None}
  if not isinstance(config, dict):
    return {'has_config': False, 'has_gate': False, **empty}
  gate = config.get('gate')
  described: Dict[str, Any] = {'has_config': True, 'has_gate': isinstance(gate, dict) and bool(gate), **empty}
  try:
    parsed = parse_config({'gate': gate, 'project': config.get('project') if isinstance(config.get('project'), dict) else {}})
  except GateConfigError as e:
    described['error'] = str(e)
    return described
  described.update(
    rules=[rule_row(rule) for rule in parsed.rules],
    max_failed_runs=parsed.max_failed_runs if described['has_gate'] else None,
    require_bit_accuracy=parsed.require_bit_accuracy,
    reference=parsed.reference,
    labels=parsed.labels,
    batches=parsed.labels,
    expect_batches=parsed.expect_batches,
  )
  return described


def get_settings(session, project_id: str):
  from .models import ProjectSettings
  return session.get(ProjectSettings, project_id)


def gate_settings(session, project_id: str) -> Optional[Dict[str, Any]]:
  """The project's gate settings, None if its owners set none"""
  settings = get_settings(session, project_id)
  gate = (settings.data or {}).get('gate') if settings is not None else None
  return gate if isinstance(gate, dict) else None


def save_gate(session, project_id: str, gate: Optional[Dict[str, Any]], user=None, now=None) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
  """Saves the cleaned gate settings (None removes them). Returns (before, after). The caller audits and commits."""
  import datetime
  from sqlalchemy.orm.attributes import flag_modified
  from .models import ProjectSettings
  now = now or datetime.datetime.utcnow()
  settings = get_settings(session, project_id)
  if settings is None:
    settings = ProjectSettings(project_id=project_id, data={}, updated={})
    session.add(settings)
  before = (settings.data or {}).get('gate')
  data, updated = dict(settings.data or {}), dict(settings.updated or {})
  if gate is None:
    data.pop('gate', None)
  else:
    data['gate'] = gate
  updated['gate'] = {'at': now.isoformat() + 'Z', 'by': getattr(user, 'user_name', None), 'by_id': getattr(user, 'id', None)}
  settings.data, settings.updated = data, updated
  settings.updated_by_id = getattr(user, 'id', None)
  settings.updated_at = now
  flag_modified(settings, 'data')
  flag_modified(settings, 'updated')
  return before, gate


def gate_changes(before: Optional[Dict[str, Any]], after: Optional[Dict[str, Any]]) -> Dict[str, Any]:
  """For the audit log: {field: {from, to}} for what changed"""
  before, after = before or {}, after or {}
  return {key: {'from': before.get(key), 'to': after.get(key)} for key in GATE_KEYS if before.get(key) != after.get(key)}
