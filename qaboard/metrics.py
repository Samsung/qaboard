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
the server uses too. Besides how to show a value, `group`, `aggregation`, `part_of` and `intent` say how to chart
metrics over commits without configuration, e.g. a test report's counts (qaboard/junit.py):
    Metric(12, group="Tests", aggregation="sum", part_of="tests", intent="danger")
Docs: /docs/computing-quantitative-metrics
"""
import json
import math
from pathlib import Path
from typing import Any, Literal, get_args

DEFINITIONS_FILE = 'metrics_definitions.json'

FIELDS = (
  'label', 'short_label', 'description', 'smaller_is_better', 'target', 'target_passfail',
  'scale', 'suffix', 'precision', 'plot_scale',
  'group', 'aggregation', 'part_of', 'intent',
)
Aggregation = Literal['sum', 'average', 'median']
Intent = Literal['success', 'warning', 'danger', 'none']
AGGREGATIONS = get_args(Aggregation)
INTENTS = get_args(Intent)


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


def _clean_group(value: Any) -> tuple[bool, Any]:
  """"Benchmarks / codec" is kept as "Benchmarks/codec": the web app splits groups on "/" into levels"""
  if not isinstance(value, str):
    return False, None
  segments = [segment.strip() for segment in value.split('/')]
  group = '/'.join(segments)
  if not all(segments) or len(group) > MAX_TEXT_LENGTH:
    return False, None
  return True, group


def _clean_field(field: str, value: Any) -> tuple[bool, Any]:
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
  if field == 'group':
    return _clean_group(value)
  if field == 'aggregation':
    return value in AGGREGATIONS, value
  if field == 'intent':
    return value in INTENTS, value
  if field == 'part_of':
    # a metric's key, as it is
    return isinstance(value, str) and 0 < len(value.strip()) and len(value) <= MAX_TEXT_LENGTH, value
  if field == 'description':
    return isinstance(value, str) and len(value) <= MAX_DESCRIPTION_LENGTH, value
  if field in ('label', 'short_label', 'suffix'):
    return isinstance(value, str) and len(value) <= MAX_TEXT_LENGTH, value
  return False, None


def clean_definition(definition: Any) -> tuple[dict[str, Any], list[str]]:
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


def _definition(**fields) -> dict[str, Any]:
  """The fields that were given: smaller_is_better=None is given, and says there is no better direction"""
  return {k: v for k, v in fields.items() if v is not UNSET}


# process-wide: reset for tests by qaboard/_testing.py reset_process_state()
_declared: dict[str, dict[str, Any]] = {}


def define_metric(key: str, *, label: str = UNSET, short_label: str = UNSET, description: str = UNSET,
                  smaller_is_better: bool | None = UNSET, target: float = UNSET, target_passfail: bool = UNSET,
                  scale: float = UNSET, suffix: str = UNSET, precision: int = UNSET, plot_scale: str = UNSET,
                  group: str = UNSET, aggregation: Aggregation = UNSET, part_of: str = UNSET, intent: Intent = UNSET) -> None:
  """
  Says how QA-Board shows a metric, for the runs that return it. Call it anywhere before the run ends, usually at the
  top of the module that computes the metric. It only records the definition: nothing is written or sent for metrics
  a run doesn't return.
  - smaller_is_better: which way is better (True, False). Leave it out, or None, when neither is.
  - target: the value to reach. Results are colored by how they compare to it.
  - suffix, scale, precision: how values are shown, e.g. suffix="%", scale=100.
  How the web app charts the metric over commits, without configuration:
  - group: metrics shown together, a path of levels separated by "/", e.g. "Tests" or "Benchmarks/codec/encode".
  - aggregation: how a commit's value comes from its runs' values: "sum" (counts, e.g. tests), "average" or
    "median" (the default).
  - part_of: the key of the metric this one is a part of, e.g. "passed" is part of "tests": parts are stacked.
  - intent: the color of a part in those stacks: "success", "warning", "danger" or "none".
  """
  _declared[key] = {**_declared.get(key, {}), **_definition(
    label=label, short_label=short_label, description=description, smaller_is_better=smaller_is_better,
    target=target, target_passfail=target_passfail, scale=scale, suffix=suffix, precision=precision, plot_scale=plot_scale,
    group=group, aggregation=aggregation, part_of=part_of, intent=intent,
  )}


def declared_metrics() -> dict[str, dict[str, Any]]:
  """The metrics declared with define_metric"""
  return {k: dict(v) for k, v in _declared.items()}


class Metric(float):
  """
  A metric's value, with how QA-Board shows it. It behaves like a float: e.g. arithmetic gives floats.
      return {"latency": Metric(12.3, suffix=" ms", smaller_is_better=True)}
      return {"failed": Metric(3, group="Tests", aggregation="sum", part_of="tests", intent="danger")}
  The arguments are those of define_metric.
  """
  definition: dict[str, Any]

  def __new__(cls, value: float, *, label: str = UNSET, short_label: str = UNSET, description: str = UNSET,
              smaller_is_better: bool | None = UNSET, target: float = UNSET, target_passfail: bool = UNSET,
              scale: float = UNSET, suffix: str = UNSET, precision: int = UNSET, plot_scale: str = UNSET,
              group: str = UNSET, aggregation: Aggregation = UNSET, part_of: str = UNSET, intent: Intent = UNSET):
    metric = super().__new__(cls, value)
    metric.definition = _definition(
      label=label, short_label=short_label, description=description, smaller_is_better=smaller_is_better,
      target=target, target_passfail=target_passfail, scale=scale, suffix=suffix, precision=precision, plot_scale=plot_scale,
      group=group, aggregation=aggregation, part_of=part_of, intent=intent,
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


def split_metrics(metrics: dict[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
  """The metrics as plain values, and the definitions of those returned as Metric"""
  values, definitions = {}, {}
  for key, value in metrics.items():
    if isinstance(value, Metric):
      definitions[key] = dict(value.definition)
      value = float(value)
    values[key] = value
  return values, definitions


def read_definitions_file(output_dir: Path) -> dict[str, dict[str, Any]]:
  """The definitions in the run's metrics_definitions.json, written by its code or by `qa` at the end of the run"""
  path = Path(output_dir) / DEFINITIONS_FILE
  if not path.exists():
    return {}
  try:
    definitions = json.loads(path.read_text(encoding='utf-8'))
  except Exception as e:
    from .ui import warning
    warning(f"Could not read {path}: {e}")
    return {}
  if not isinstance(definitions, dict):
    return {}
  return {str(k): v for k, v in definitions.items() if isinstance(v, dict)}


def resolve_definitions(metrics: dict[str, Any], inline: dict[str, dict[str, Any]], output_dir: Path) -> dict[str, dict[str, Any]]:
  """
  The definitions of the metrics a run returned, field by field: metrics_definitions.json < define_metric < Metric
  (`inline`). Metrics the run didn't return are left out, whoever declared them. Invalid fields too, with a warning.
  """
  from_file = read_definitions_file(output_dir)
  definitions = {}
  for key in metrics:
    definition, invalid = clean_definition({**from_file.get(key, {}), **_declared.get(key, {}), **inline.get(key, {})})
    if invalid:
      from .ui import warning
      warning(f'Invalid or unknown fields in the definition of the metric {key}, ignored: {", ".join(sorted(invalid))}')
    if definition:
      definitions[key] = definition
  return definitions


def write_definitions_file(output_dir: Path, definitions: dict[str, dict[str, Any]]) -> None:
  """
  Saves the run's definitions next to its metrics.json, so that the run's folder says how to show its metrics.
  Runs that declare nothing get no file.
  """
  path = Path(output_dir) / DEFINITIONS_FILE
  if definitions or path.exists():
    path.write_text(json.dumps(definitions, sort_keys=True, indent=2, separators=(',', ': ')), encoding='utf-8')


def with_default_direction(definitions: dict[str, dict[str, Any]], metrics_file: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
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
