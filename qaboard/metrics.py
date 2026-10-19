"""
Metrics declared where they are computed, instead of in a metrics file.

Return values with their definition:
    from qaboard import Metric
    def run(context):
      return {"latency": Metric(12.3, suffix=" ms", smaller_is_better=True, target=15)}

Or declare them once, e.g. next to the code that computes them:
    from qaboard import define_metric
    define_metric("psnr", label="PSNR", suffix=" dB", smaller_is_better=False)

Or, from any language, write next to metrics.json a metrics_definitions.json:
    {"latency": {"suffix": " ms", "smaller_is_better": true}}

At the end of each run, `qa` merges them (define_metric < metrics_definitions.json < Metric), keeps those of the metrics
the run returned, and sends them to QA-Board with the run. It doesn't write metrics_definitions.json: that file is the
run's, `qa postprocess` and `qa sync` read it again.
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
  Declares how QA-Board shows a metric. Call it at import time, e.g. at the top of the module that computes the metric.
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
  """The definitions a run wrote in its output directory, in metrics_definitions.json"""
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


def run_definitions(metrics: Dict[str, Any], inline: Dict[str, Dict[str, Any]], output_dir: Path,
                    metrics_file: Optional[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
  """
  The definitions of the metrics a run returned: define_metric < metrics_definitions.json < Metric.
  Those of metrics that are not in the metrics file (`metrics_file`, its available_metrics) and don't say which way
  is better get smaller_is_better: null: in metrics files, leaving it out means "smaller is better".
  Invalid fields are left out, with a warning.
  """
  metrics_file = metrics_file or {}
  from_file = read_definitions_file(output_dir)
  definitions = {}
  for key in metrics:
    definition, invalid = clean_definition({**_declared.get(key, {}), **from_file.get(key, {}), **inline.get(key, {})})
    if invalid:
      import click
      click.secho(f'WARNING: invalid or unknown fields in the definition of the metric {key}, ignored: {", ".join(sorted(invalid))}', fg='yellow', err=True)
    if not definition:
      continue
    if key not in metrics_file and 'smaller_is_better' not in definition:
      definition['smaller_is_better'] = None
    definitions[key] = definition
  return definitions
