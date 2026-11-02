"""
Compares the runs of two batches with the same numbers as the web app's views:
- **Summary** (`webapp/src/components/metrics.jsx`): the median of each metric over the runs, the change vs the
  reference, and the share of runs that meet the metric's target;
- **Metrics Diff** (`webapp/src/components/tables.jsx`): each run next to its reference run, matched like the web app
  does (`matching_output` in `webapp/src/utils.js`).
The web app's own helpers are in `webapp/src/utils/compare.js`. Both are tested against the same fixture,
`tests/fixtures/metrics-compare.json`: change one, change the other.

Outputs are dicts like `Output.to_dict()`, the API's representation of runs, without any database access here.
"""
import re
import json
import math
import fnmatch
import statistics
from typing import Any, Dict, List, Optional, Tuple

from qaboard.matching import config_distance


# ---------------------------------------------------------------------------- matching runs, like the web app

def js_stringify(value) -> str:
  """JSON.stringify(): no spaces, and objects list their integer-like keys first, in ascending order"""
  if isinstance(value, dict):
    integer_like = sorted((k for k in value if re.fullmatch(r'0|[1-9][0-9]*', str(k))), key=int)
    others = [k for k in value if k not in integer_like]
    items = (f'{json.dumps(str(k), ensure_ascii=False)}:{js_stringify(value[k])}' for k in [*integer_like, *others])
    return '{' + ','.join(items) + '}'
  if isinstance(value, (list, tuple)):
    return '[' + ','.join('null' if v is None else js_stringify(v) for v in value) + ']'
  return json.dumps(value, ensure_ascii=False)


def prepare_output(output: Dict) -> Dict:
  """The fields the web app adds to each run when it receives it (`preprocess_output` in `webapp/src/reducers`)"""
  o = dict(output)
  run_params = (o.get('data') or {}).get('params')
  if run_params is not None:
    o['extra_parameters'] = {**(o.get('extra_parameters') or {}), **run_params}
  # JS's replace() with a string only replaces the first occurrence
  o['input_path'] = f"{o.get('test_input_database')}/{o.get('test_input_path')}".replace('//', '/', 1)
  o['configurations_str'] = js_stringify(o.get('configurations'))
  o['extra_parameters_str'] = js_stringify(o.get('extra_parameters'))
  o['test_input_metadata'] = o.get('test_input_metadata') or {}
  return o


def matching_output(output: Dict, ref_outputs: List[Dict]) -> Tuple[Optional[Dict], Optional[Dict]]:
  """
  The reference run that matches a run best, and how they differ (None if they're the same test).
  Both must have gone through prepare_output(), and ref_outputs be sorted by id (the web app's order).
  """
  output_id = output['test_input_metadata'].get('id')
  candidates = [
    o for o in ref_outputs
    if not o.get('is_pending') and (
      o['input_path'] == output['input_path'] or
      o.get('test_input_path') == output.get('test_input_path') or
      (output_id and o['test_input_metadata'].get('id') and o['test_input_metadata'].get('id') == output_id)
    )
  ]
  def sort_key(o):
    same_input = o['input_path'] == output['input_path'] or o.get('test_input_path') == output.get('test_input_path')
    return (
      0 if same_input else 1,
      config_distance(o.get('configurations'), output.get('configurations')),
      config_distance(o.get('extra_parameters'), output.get('extra_parameters')),
      0 if o.get('platform') == output.get('platform') else 1,
    )
  candidates.sort(key=sort_key)  # stable: ties keep the order of the ids
  if not candidates:
    return None, None
  ref = candidates[0]
  differs = {
    'test_input_path': ref['input_path'] != output['input_path'],
    'configurations': ref['configurations_str'] != output['configurations_str'],
    'platform': ref.get('platform') != output.get('platform'),
    'extra_parameters': ref['extra_parameters_str'] != output['extra_parameters_str'],
  }
  if not any(differs.values()):
    return ref, None
  return ref, {key: (ref.get(key) if is_different else None) for key, is_different in differs.items()}


# ---------------------------------------------------------------------------- numbers

def is_number(value) -> bool:
  """Metrics that are numbers. Not booleans like is_failed: failed runs have their own counts."""
  if isinstance(value, bool) or not isinstance(value, (int, float)):
    return False
  return math.isfinite(value)


def finite(value: Optional[float]) -> Optional[float]:
  """JSON has no NaN or Infinity: the web app shows them, the API returns null"""
  if value is None or not math.isfinite(value):
    return None
  return value


def median(values: List[float]) -> Optional[float]:
  return statistics.median(values) if values else None


def pass_rate(values: List[float], metric: Dict) -> Optional[float]:
  """The share of runs that meet the metric's target, like the Summary's success bar"""
  target = metric.get('target')
  if not is_number(target) or not values or metric['smaller_is_better'] is None:
    return None
  if metric['smaller_is_better']:
    return sum(1 for v in values if v <= target) / len(values)
  return sum(1 for v in values if v >= target) / len(values)


def relative_change(new: Optional[float], ref: Optional[float]) -> Optional[float]:
  """(new - ref) / |ref|, None when it's not a number (no values, or a reference of 0 with a change)"""
  if new is None or ref is None:
    return None
  delta = new - ref
  if ref == 0:
    return 0.0 if delta == 0 else None
  return delta / abs(ref)


def diff_cell(new, ref) -> Optional[Dict]:
  """A Metrics Diff cell: the change between a run and its reference run"""
  if not is_number(new) or not is_number(ref):
    return None
  delta = new - ref
  return {
    'new': new,
    'ref': ref,
    'delta': delta,
    # the web app divides by |ref| + 0.00001
    'delta_relative': delta / (abs(ref) + 0.00001),
  }


def smaller_is_better(definition: Optional[Dict]) -> Optional[bool]:
  """
  Whether smaller values of a metric are better, from its definition (`metrics_fill_defaults` in `webapp/src/utils.js`).
  Definitions without `smaller_is_better` mean True, as metrics files always did. `null` means QA-Board doesn't know:
  code that declares metrics (`qaboard.Metric`, metrics_definitions.json) says null when it doesn't tell.
  """
  definition = definition or {}
  if 'smaller_is_better' not in definition:
    return True
  value = definition['smaller_is_better']
  if value is None:
    return None
  if isinstance(value, str):
    return value.lower() != 'false'
  return bool(value)


def metrics_info(available_metrics: Optional[Dict], keys) -> Dict[str, Dict]:
  """
  The metrics' definitions, with the web app's defaults (`metrics_fill_defaults` in `webapp/src/utils.js`).
  Metrics that were not declared are shown too: `smaller_is_better` is None, QA-Board doesn't know which way is better.
  """
  available_metrics = available_metrics or {}
  info = {}
  for key in keys:
    declared = key in available_metrics
    m = available_metrics.get(key) or {}
    label = m.get('label') or key
    info[key] = {
      'label': label,
      'short_label': m.get('short_label') or label,
      'suffix': m.get('suffix') or '',
      'scale': m.get('scale') or 1.0,
      'smaller_is_better': smaller_is_better(m) if declared else None,
      'target': m.get('target'),
      'declared': declared,
    }
  return info


# ---------------------------------------------------------------------------- the comparison

def summary_outputs(new_outputs: List[Dict], ref_outputs: List[Dict]) -> Tuple[List[Dict], List[Dict]]:
  """The runs the Summary aggregates: finished runs, and the reference's runs on the same inputs"""
  new = [o for o in new_outputs if not o.get('is_pending') and o.get('output_type') != 'optim_iteration']
  new_inputs = {o.get('test_input_path') for o in new}
  ref = [o for o in ref_outputs if not o.get('is_pending') and o.get('test_input_path') in new_inputs]
  return new, ref


def compare_outputs(new_outputs: List[Dict], ref_outputs: List[Dict], available_metrics: Optional[Dict] = None, metrics: Optional[List[str]] = None) -> Dict[str, Any]:
  """
  Per metric, the Summary's numbers: {median, count, pass_rate} of the new and reference runs, and the change.
  Per run, the Metrics Diff's: its reference run, how they differ, and the change of each metric.
  `metrics` restricts the metrics, by default all those with numbers in the new runs.
  """
  new_all = sorted((prepare_output(o) for o in new_outputs), key=lambda o: o['id'])
  ref_all = sorted((prepare_output(o) for o in ref_outputs), key=lambda o: o['id'])
  new, ref = summary_outputs(new_all, ref_all)

  if metrics is None:
    keys = []
    for o in new:
      keys.extend(k for k, v in (o.get('metrics') or {}).items() if is_number(v) and k not in keys)
  else:
    keys = list(metrics)
  info = metrics_info(available_metrics, keys)

  summary = {}
  for key in keys:
    m = info[key]
    new_values = [o['metrics'][key] for o in new if is_number((o.get('metrics') or {}).get(key))]
    ref_values = [o['metrics'][key] for o in ref if is_number((o.get('metrics') or {}).get(key))]
    new_median, ref_median = median(new_values), median(ref_values)
    summary[key] = {
      **m,
      'new': {'median': new_median, 'count': len(new_values), 'pass_rate': pass_rate(new_values, m)},
      'ref': {'median': ref_median, 'count': len(ref_values), 'pass_rate': pass_rate(ref_values, m)},
      'delta': finite(new_median - ref_median) if new_median is not None and ref_median is not None else None,
      'delta_relative': finite(relative_change(new_median, ref_median)),
    }

  tests = []
  for o in new:
    output_ref, mismatch = matching_output(o, ref_all)
    ref_metrics = (output_ref or {}).get('metrics') or {}
    cells = {}
    for key in keys:
      new_value = (o.get('metrics') or {}).get(key)
      cell = diff_cell(new_value, ref_metrics.get(key))
      if cell:
        cells[key] = cell
      elif is_number(new_value):
        cells[key] = {'new': new_value, 'ref': None, 'delta': None, 'delta_relative': None}
    tests.append({
      'id': o['id'],
      'reference_id': output_ref['id'] if output_ref else None,
      'reference_mismatch': mismatch,
      'test_input_path': o.get('test_input_path'),
      'test_input_database': o.get('test_input_database'),
      'label': o['test_input_metadata'].get('label'),
      'platform': o.get('platform'),
      'configurations': o.get('configurations'),
      'extra_parameters': o.get('extra_parameters'),
      'is_failed': bool(o.get('is_failed')),
      'metrics': cells,
      # filled in by compare_bit_accuracy()
      'bit_accurate': None,
    })
  return {'metrics': summary, 'tests': tests}


def run_counts(outputs: List[Dict]) -> Dict[str, int]:
  counts = {'total': 0, 'valid': 0, 'failed': 0, 'pending': 0, 'running': 0}
  for o in outputs:
    counts['total'] += 1
    if o.get('is_pending'):
      counts['pending'] += 1
      if o.get('is_running'):
        counts['running'] += 1
    elif o.get('is_failed'):
      counts['failed'] += 1
    else:
      counts['valid'] += 1
  return counts


# ---------------------------------------------------------------------------- bit accuracy, like `qa check-bit-accuracy`

# files that change from run to run, always ignored (see `is_bit_accurate` in qaboard/bit_accuracy.py)
IGNORED_FILES = ['manifest.inputs.json', 'run.json', 'log.txt', 'log.lsf.txt', 'metrics.json', 'metrics_definitions.json', '.nfs000*']
CHECKED_CDE_ATTRS = ["width", "height", "format", "imageType", "md5_data"]


def is_same_content(filename: str, meta_1: Dict, meta_2: Dict) -> bool:
  if filename.endswith('.hex'):
    return all(meta_1[a] == meta_2[a] for a in CHECKED_CDE_ATTRS if a in meta_1 and a in meta_2)
  if filename.endswith('.raw'):
    return meta_1.get('md5') == meta_2.get('md5') and all(meta_1[a] == meta_2[a] for a in CHECKED_CDE_ATTRS if a in meta_1 and a in meta_2)
  return meta_1.get('md5') == meta_2.get('md5')


def manifests_mismatch(manifest_new: Dict, manifest_ref: Dict, bit_accuracy_config: Optional[Dict] = None) -> List[str]:
  """The files that differ between two output manifests. Files in only one of them are not compared."""
  config = bit_accuracy_config or {}
  patterns = config.get('patterns') or ['*']
  patterns = patterns if isinstance(patterns, (list, tuple)) else [patterns]
  ignore = config.get('ignore') or []
  ignore = [*(ignore if isinstance(ignore, (list, tuple)) else [ignore]), *IGNORED_FILES]
  mismatch = set()
  for pattern in patterns:
    for filename, meta in manifest_new.items():
      if not fnmatch.fnmatch(filename, f'*{pattern}') or any(fnmatch.fnmatch(filename, f'{i}*') for i in ignore):
        continue
      if filename in manifest_ref and not is_same_content(filename, meta, manifest_ref[filename]):
        mismatch.add(filename)
  return sorted(mismatch)
