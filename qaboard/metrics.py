"""
How QA-Board shows a run's metrics (label, unit, target, which way is better), declared in code.

Three ways, for the metrics a run returns:
    from qaboard import Metric, define_metric
    return {"latency": Metric(12.3, suffix=" ms", smaller_is_better=True)}   # with the value
    define_metric("psnr", label="PSNR", suffix=" dB", smaller_is_better=False)  # once, e.g. at a module's top
    output_dir/metrics_definitions.json, written by a program in any language: {"latency": {"suffix": " ms"}}

When things happen:
1. `define_metric` only records, in memory, how to show a metric *if a run returns it*. It writes and sends nothing:
   a metric that no run returns has no definition anywhere, so declaring more than a run returns is harmless.
2. run() and postprocess() return values, plain or as `Metric`.
3. At the end of the run, `qa` keeps the metrics the run returned and their definitions, field by field:
   metrics_definitions.json < define_metric < Metric (like metrics.json, which run()'s values override: code wins).
   It writes the values in metrics.json and the definitions in metrics_definitions.json, and sends both to QA-Board.

The run's folder then says how to show its metrics, even those declared with `Metric`: `qa sync`, and `qa postprocess`
which doesn't call run(), read the definitions from it.
The fields are those of the metrics file (qaboard/schemas/metrics.schema.json), checked by `clean_definition`, which
the server uses too. Docs: /docs/computing-quantitative-metrics
"""
import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEFINITIONS_FILE = 'metrics_definitions.json'

FIELDS = (
  'label', 'short_label', 'description', 'smaller_is_better', 'target', 'target_passfail',
  'scale', 'suffix', 'precision', 'plot_scale',
)


# Definitions are small: longer texts are likely mistakes
MAX_TEXT_LENGTH = 200
MAX_DESCRIPTION_LENGTH = 2000


def _plain(value: Any) -> Any:
  """numpy scalars as Python numbers"""
  if not isinstance(value, (str, bytes, bool, int, float)) and hasattr(value, 'item'):
    try:
      return value.item()
    except Exception:
      return value
  return value


def _is_number(value: Any) -> bool:
  return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _clean_field(field: str, value: Any) -> Tuple[bool, Any]:
  """(is the value valid, the value to keep)"""
  value = _plain(value)
  if field == 'smaller_is_better':
    if value is None or isinstance(value, bool):
      return True, value
    if isinstance(value, str) and value.lower() in ('true', 'false'):
      return True, value.lower() == 'true'
    return False, None
  if field in ('target', 'scale'):
    return _is_number(value), value
  if field == 'precision':
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 20, value
  if field == 'target_passfail':
    return isinstance(value, bool), value
  if field == 'plot_scale':
    return value in ('log', 'linear'), value
  if field == 'description':
    return isinstance(value, str) and len(value) <= MAX_DESCRIPTION_LENGTH, value
  if field in ('label', 'short_label', 'suffix'):
    return isinstance(value, str) and len(value) <= MAX_TEXT_LENGTH, value
  return False, None


def clean_definition(definition: Any) -> Tuple[Dict[str, Any], List[str]]:
  """The valid fields of a metric's definition, with normalized values, and the names of the invalid fields"""
  if not isinstance(definition, dict):
    return {}, ['(not an object)']
  cleaned, invalid = {}, []
  for field, value in definition.items():
    ok, value = _clean_field(str(field), value)
    if ok:
      cleaned[str(field)] = value
    else:
      invalid.append(str(field))
  return cleaned, invalid


class _Unset:
  def __repr__(self):
    return 'unset'
UNSET: Any = _Unset()


def _definition(**fields) -> Dict[str, Any]:
  """The fields that were given: smaller_is_better=None is given, and says there is no better direction"""
  return {k: v for k, v in fields.items() if v is not UNSET}


_declared: Dict[str, Dict[str, Any]] = {}


def define_metric(key: str, *, label: str = UNSET, short_label: str = UNSET, description: str = UNSET,
                  smaller_is_better: Optional[bool] = UNSET, target: float = UNSET, target_passfail: bool = UNSET,
                  scale: float = UNSET, suffix: str = UNSET, precision: int = UNSET, plot_scale: str = UNSET) -> None:
  """
  Says how QA-Board shows a metric, for the runs that return it. Call it anywhere before the run ends, usually at the
  top of the module that computes the metric. It only records the definition: nothing is written or sent for metrics
  a run doesn't return.
  - smaller_is_better: which way is better (True, False). Leave it out, or None, when neither is.
  - target: the value to reach. Results are colored by how they compare to it.
  - suffix, scale, precision: how values are shown, e.g. suffix="%", scale=100.
  """
  _declared[key] = {**_declared.get(key, {}), **_definition(
    label=label, short_label=short_label, description=description, smaller_is_better=smaller_is_better,
    target=target, target_passfail=target_passfail, scale=scale, suffix=suffix, precision=precision, plot_scale=plot_scale,
  )}


def declared_metrics() -> Dict[str, Dict[str, Any]]:
  """The metrics declared with define_metric"""
  return {k: dict(v) for k, v in _declared.items()}


class Metric(float):
  """
  A metric's value, with how QA-Board shows it. It behaves like a float: e.g. arithmetic gives floats.
      return {"latency": Metric(12.3, suffix=" ms", smaller_is_better=True)}
  The arguments are those of define_metric.
  """
  definition: Dict[str, Any]

  def __new__(cls, value: float, *, label: str = UNSET, short_label: str = UNSET, description: str = UNSET,
              smaller_is_better: Optional[bool] = UNSET, target: float = UNSET, target_passfail: bool = UNSET,
              scale: float = UNSET, suffix: str = UNSET, precision: int = UNSET, plot_scale: str = UNSET):
    metric = super().__new__(cls, value)
    metric.definition = _definition(
      label=label, short_label=short_label, description=description, smaller_is_better=smaller_is_better,
      target=target, target_passfail=target_passfail, scale=scale, suffix=suffix, precision=precision, plot_scale=plot_scale,
    )
    return metric

  def __repr__(self):
    fields = ''.join(f', {k}={v!r}' for k, v in self.definition.items())
    return f'Metric({float(self)!r}{fields})'

  # pickling, e.g. with multiprocessing
  def __reduce__(self):
    return (_metric, (float(self), self.definition))


def _metric(value, definition):
  return Metric(value, **definition)


def split_metrics(metrics: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Dict[str, Any]]]:
  """The metrics as plain values, and the definitions of those returned as Metric"""
  values, definitions = {}, {}
  for key, value in metrics.items():
    if isinstance(value, Metric):
      definitions[key] = dict(value.definition)
      value = float(value)
    values[key] = value
  return values, definitions


def read_definitions_file(output_dir: Path) -> Dict[str, Dict[str, Any]]:
  """The definitions in the run's metrics_definitions.json, written by its code or by `qa` at the end of the run"""
  path = Path(output_dir) / DEFINITIONS_FILE
  if not path.exists():
    return {}
  try:
    definitions = json.loads(path.read_text())
  except Exception as e:
    import click
    click.secho(f'WARNING: Could not read {path}: {e}', fg='yellow', err=True)
    return {}
  if not isinstance(definitions, dict):
    return {}
  return {str(k): v for k, v in definitions.items() if isinstance(v, dict)}


def resolve_definitions(metrics: Dict[str, Any], inline: Dict[str, Dict[str, Any]], output_dir: Path) -> Dict[str, Dict[str, Any]]:
  """
  The definitions of the metrics a run returned, field by field: metrics_definitions.json < define_metric < Metric
  (`inline`). Metrics the run didn't return are left out, whoever declared them. Invalid fields too, with a warning.
  """
  from_file = read_definitions_file(output_dir)
  definitions = {}
  for key in metrics:
    definition, invalid = clean_definition({**from_file.get(key, {}), **_declared.get(key, {}), **inline.get(key, {})})
    if invalid:
      import click
      click.secho(f'WARNING: invalid or unknown fields in the definition of the metric {key}, ignored: {", ".join(sorted(invalid))}', fg='yellow', err=True)
    if definition:
      definitions[key] = definition
  return definitions


def write_definitions_file(output_dir: Path, definitions: Dict[str, Dict[str, Any]]) -> None:
  """
  Saves the run's definitions next to its metrics.json, so that the run's folder says how to show its metrics.
  Runs that declare nothing get no file.
  """
  path = Path(output_dir) / DEFINITIONS_FILE
  if definitions or path.exists():
    path.write_text(json.dumps(definitions, sort_keys=True, indent=2, separators=(',', ': ')))


def with_default_direction(definitions: Dict[str, Dict[str, Any]], metrics_file: Optional[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
  """
  The definitions to send to QA-Board. Those of metrics that are not in the metrics file (`metrics_file`, its
  available_metrics) and don't say which way is better get smaller_is_better: null, because in metrics files, leaving
  it out means "smaller is better". It's not written in metrics_definitions.json: the metrics file can change.
  """
  metrics_file = metrics_file or {}
  return {
    key: {**definition, 'smaller_is_better': None} if key not in metrics_file and 'smaller_is_better' not in definition else dict(definition)
    for key, definition in definitions.items()
  }
