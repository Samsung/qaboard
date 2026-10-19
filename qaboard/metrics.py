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
the run returned, saves them in the run's metrics_definitions.json, and sends them to QA-Board with the run.
The fields are those of the metrics file (qaboard/schemas/metrics.schema.json). Docs: /docs/computing-quantitative-metrics
"""
import json
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

DEFINITIONS_FILE = 'metrics_definitions.json'

FIELDS = (
  'label', 'short_label', 'description', 'smaller_is_better', 'target', 'target_passfail',
  'scale', 'suffix', 'precision', 'plot_scale',
)


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
                    metrics_file: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
  """
  The definitions of the metrics a run returned: define_metric < metrics_definitions.json < Metric.
  Those of metrics that are not in the metrics file (`metrics_file`, its available_metrics) and don't say which way
  is better get smaller_is_better: null: in metrics files, leaving it out means "smaller is better".
  """
  from_file = read_definitions_file(output_dir)
  definitions = {}
  for key in metrics:
    definition = {**_declared.get(key, {}), **from_file.get(key, {}), **inline.get(key, {})}
    if not definition:
      continue
    unknown = set(definition) - set(FIELDS)
    if unknown:
      import click
      click.secho(f'WARNING: unknown fields in the definition of the metric {key}: {", ".join(sorted(unknown))}', fg='yellow', err=True)
    if key not in metrics_file and 'smaller_is_better' not in definition:
      definition['smaller_is_better'] = None
    definitions[key] = definition
  return definitions


def write_definitions_file(output_dir: Path, definitions: Dict[str, Dict[str, Any]]) -> None:
  with (Path(output_dir) / DEFINITIONS_FILE).open('w') as f:
    json.dump(definitions, f, sort_keys=True, indent=2, separators=(',', ': '))
