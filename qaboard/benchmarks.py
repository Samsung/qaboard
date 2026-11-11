"""
Benchmark files as QA-Board metrics: your run() runs the harness, which saves its file in the run's output directory,
and returns one metric per benchmark. The web app shows the same file against the reference run's (the benchmark
viewer, webapp/src/viewers/benchmarks/).

    from qaboard.benchmarks import benchmark_metrics

    def run(context):
      subprocess.run(["pytest", "benchmarks/", f"--benchmark-json={context.output_dir}/pytest.benchmarks.json"], check=True)
      return benchmark_metrics(context.output_dir / "pytest.benchmarks.json")

QA-Board doesn't run benchmarks, repeat them or aggregate runs: the numbers, and their spread (standard deviation,
IQR, rounds...), are those of the harness's file. We read:
- pytest-benchmark (--benchmark-json), Google Benchmark (--benchmark_format=json, --benchmark_out), hyperfine
  (--export-json), Criterion (cargo criterion --message-format=json, or a target/criterion directory), JMH (-rf json),
  `go test -bench` text output,
- and our own normalized format (*.benchmarks.json, qaboard/schemas/benchmarks.schema.json), that `write_benchmarks`
  writes, for harnesses we don't read, or files the web app can't read alone (a Criterion directory).

The web app parses the same formats into the same model (webapp/src/viewers/benchmarks/parse.js): both are tested on
tests/fixtures/benchmarks/, whose *.expected.benchmarks.json files are the expected result. Change one, change the other.

Times are in seconds (unit "s"). The headline `value` is the mean time per iteration (JMH's score, Go's ns/op), said
in `statistic`; files in our format can pick another statistic.
Docs: /docs/viewers#benchmarks
"""
import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple, Union

from .metrics import Metric, MAX_TEXT_LENGTH


FORMATS = ('pytest-benchmark', 'google-benchmark', 'hyperfine', 'criterion', 'jmh', 'go', 'qaboard')
VERSION = 1
SCHEMA = 'https://samsung.github.io/qaboard/benchmarks.schema.json'

# What `stats` may hold. Times are in the benchmark's unit, the others are counts or rates
TIME_STATS = ('mean', 'median', 'stddev', 'min', 'max', 'iqr', 'mad', 'error')
STATS = (*TIME_STATS, 'rounds', 'iterations', 'samples', 'ops', 'cpu_time', 'bytes_per_op', 'allocs_per_op')
COUNT_STATS = ('rounds', 'iterations', 'samples')
CONTEXT = ('machine', 'cpu', 'cpu_count', 'os', 'arch', 'date', 'harness')

# in seconds
TIME_UNITS = {'ns': 1e-9, 'us': 1e-6, 'µs': 1e-6, 'μs': 1e-6, 'ms': 1e-3, 's': 1.0}


@dataclass
class Benchmark:
  """
  One benchmark of a file.
  - name: unique in the file, and stable across commits: benchmarks are matched with the reference's by name.
  - group: the module, class, family or group of the benchmark, if any.
  - value, unit: the headline number, in seconds for times. `statistic` says which: mean, median...
  - smaller_is_better: False for throughputs (operations per second...).
  - stats: what the file says among mean, median, stddev, min, max, iqr, mad (median absolute deviation), error (a
    confidence interval's half-width, e.g. JMH's), rounds, iterations, samples, ops (operations per second)...
  - throughput: {"value": 1.2e9, "unit": "B/s"} when the harness computed one.
  """
  name: str
  value: float
  unit: str = 's'
  group: Optional[str] = None
  params: Dict[str, Any] = field(default_factory=dict)
  statistic: Optional[str] = None
  smaller_is_better: bool = True
  stats: Dict[str, float] = field(default_factory=dict)
  throughput: Optional[Dict[str, Any]] = None

  def to_dict(self) -> Dict[str, Any]:
    """As in the normalized format, without empty fields"""
    data: Dict[str, Any] = {'name': self.name}
    if self.group is not None:
      data['group'] = self.group
    if self.params:
      data['params'] = dict(self.params)
    data['value'] = self.value
    data['unit'] = self.unit
    if self.statistic:
      data['statistic'] = self.statistic
    if not self.smaller_is_better:
      data['smaller_is_better'] = False
    if self.stats:
      data['stats'] = {k: self.stats[k] for k in STATS if k in self.stats}
    if self.throughput:
      data['throughput'] = dict(self.throughput)
    return data


class Benchmarks(List[Benchmark]):
  """The benchmarks of a file, with the file's `source` (its format) and `context`: machine, cpu, cpu_count, os, date..."""
  def __init__(self, benchmarks: Iterable[Benchmark] = (), source: Optional[str] = None, context: Optional[Dict[str, Any]] = None):
    super().__init__(benchmarks)
    self.source = source
    self.context: Dict[str, Any] = context or {}

  def to_dict(self) -> Dict[str, Any]:
    data: Dict[str, Any] = {'$schema': SCHEMA, 'qaboard_benchmarks': VERSION}
    if self.source:
      data['source'] = self.source
    context = _context(self.context)
    if context:
      data['context'] = context
    data['benchmarks'] = [b.to_dict() for b in self]
    return data


def _number(value: Any) -> Optional[float]:
  """A finite number, else None (JMH writes "NaN" for errors it can't compute)"""
  if isinstance(value, bool) or not isinstance(value, (int, float)):
    return None
  return value if math.isfinite(value) else None


def _stats(**values: Any) -> Dict[str, float]:
  stats = {}
  for key, value in values.items():
    value = _number(value)
    if value is not None:
      stats[key] = int(round(value)) if key in COUNT_STATS else value
  return stats


def _scaled(stats: Dict[str, float], factor: float) -> Dict[str, float]:
  return {k: v * factor if k in TIME_STATS or k == 'cpu_time' else v for k, v in stats.items()}


def _param(value: Any) -> Any:
  if value is None or isinstance(value, (str, bool)) or _number(value) is not None:
    return value
  return json.dumps(value, separators=(',', ':'))


def _params(params: Any) -> Dict[str, Any]:
  if not isinstance(params, dict):
    return {}
  return {str(k): _param(v) for k, v in params.items()}


def _context(context: Dict[str, Any]) -> Dict[str, Any]:
  return {k: context[k] for k in CONTEXT if context.get(k) is not None and context.get(k) != ''}


def _unique(benchmarks: List[Benchmark]) -> List[Benchmark]:
  """Names are unique: the second benchmark called "x" becomes "x #2" """
  seen: Dict[str, int] = {}
  for b in benchmarks:
    if b.name in seen:
      seen[b.name] += 1
      b.name = f'{b.name} #{seen[b.name]}'
    else:
      seen[b.name] = 1
  return benchmarks


def _family(name: str, separator: str = '/') -> Optional[str]:
  return name.split(separator)[0] if separator in name else None


def parse_pytest_benchmark(data: Dict) -> Benchmarks:
  machine = data.get('machine_info') or {}
  cpu = machine.get('cpu') or {}
  system = ' '.join(str(machine[k]) for k in ('system', 'release') if machine.get(k))
  context = {
    'machine': machine.get('node'),
    'cpu': cpu.get('brand_raw') or cpu.get('brand'),
    'cpu_count': cpu.get('count'),
    'os': system or None,
    'arch': machine.get('machine'),
    'date': data.get('datetime'),
    'harness': f"pytest-benchmark {data['version']}" if data.get('version') else 'pytest-benchmark',
  }
  benchmarks = []
  for b in data.get('benchmarks') or []:
    stats = b.get('stats') or {}
    if _number(stats.get('mean')) is None:
      continue
    name = b.get('fullname') or b.get('name')
    benchmarks.append(Benchmark(
      name=name,
      group=b.get('group') or (name.split('::')[0] if '::' in name else None),
      params=_params(b.get('params')),
      value=stats['mean'],
      statistic='mean',
      stats=_stats(
        mean=stats.get('mean'), median=stats.get('median'), stddev=stats.get('stddev'), min=stats.get('min'),
        max=stats.get('max'), iqr=stats.get('iqr'), rounds=stats.get('rounds'), iterations=stats.get('iterations'),
        ops=stats.get('ops'),
      ),
    ))
  return Benchmarks(benchmarks, 'pytest-benchmark', context)


def _google_params(name: str) -> Dict[str, Any]:
  """BM_Route/size:1024/threads:4 => {"size": "1024", "threads": "4"}. Unnamed arguments stay in the name."""
  params = {}
  for part in name.split('/')[1:]:
    if ':' in part:
      key, value = part.split(':', 1)
      params[key] = value
  return params


def parse_google_benchmark(data: Dict) -> Benchmarks:
  info = data.get('context') or {}
  context = {
    'machine': info.get('host_name'),
    'cpu_count': info.get('num_cpus'),
    'date': info.get('date'),
    'harness': f"Google Benchmark {info['library_version']}" if info.get('library_version') else 'Google Benchmark',
  }
  # Rows are grouped by run_name: the iterations' rows, then with --benchmark_repetitions their aggregates
  runs: Dict[str, Dict[str, Any]] = {}
  for row in data.get('benchmarks') or []:
    if row.get('error_occurred'):
      continue
    name = row.get('run_name') or row.get('name')
    run = runs.setdefault(name, {'iterations': [], 'aggregates': {}})
    if row.get('run_type') == 'aggregate':
      # BigO and RMS fit a complexity over the family's sizes: not a time per iteration. cv is a percentage.
      if row.get('aggregate_unit', 'time') == 'time' and row.get('aggregate_name') not in ('BigO', 'RMS'):
        run['aggregates'].setdefault(row.get('aggregate_name'), row)
    else:
      run['iterations'].append(row)
  benchmarks = []
  for name, run in runs.items():
    aggregates, iterations = run['aggregates'], run['iterations']
    main = aggregates.get('mean') or (iterations[0] if iterations else None)
    if main is None or _number(main.get('real_time')) is None:
      continue
    factor = TIME_UNITS.get(main.get('time_unit', 'ns'), 1e-9)
    stats = _stats(
      mean=main.get('real_time'),
      median=(aggregates.get('median') or {}).get('real_time'),
      stddev=(aggregates.get('stddev') or {}).get('real_time'),
      min=(aggregates.get('min') or {}).get('real_time'),
      max=(aggregates.get('max') or {}).get('real_time'),
      cpu_time=main.get('cpu_time'),
    )
    stats = _scaled(stats, factor)
    if 'mean' in aggregates:
      stats['rounds'] = int(main.get('repetitions') or len(iterations))
    if iterations and _number(iterations[0].get('iterations')) is not None:
      stats['iterations'] = int(iterations[0]['iterations'])
    throughput = None
    for key, unit in (('bytes_per_second', 'B/s'), ('items_per_second', 'items/s')):
      if _number(main.get(key)) is not None:
        throughput = {'value': main[key], 'unit': unit}
        break
    benchmarks.append(Benchmark(
      name=name, group=_family(name), params=_google_params(name),
      value=stats['mean'], statistic='mean', stats=stats, throughput=throughput,
    ))
  return Benchmarks(benchmarks, 'google-benchmark', context)


def parse_hyperfine(data: Dict) -> Benchmarks:
  benchmarks = []
  for result in data.get('results') or []:
    if _number(result.get('mean')) is None:
      continue
    times = result.get('times')
    benchmarks.append(Benchmark(
      name=str(result.get('command')),
      params=_params(result.get('parameters')),
      value=result['mean'],
      statistic='mean',
      stats=_stats(
        mean=result.get('mean'), median=result.get('median'), stddev=result.get('stddev'), min=result.get('min'),
        max=result.get('max'), rounds=len(times) if isinstance(times, list) else None,
      ),
    ))
  return Benchmarks(benchmarks, 'hyperfine', {'harness': 'hyperfine'})


CRITERION_THROUGHPUT = {'bytes': 'B/s', 'bytes_decimal': 'B/s', 'elements': 'elements/s'}


def _criterion_throughput(per_iteration: Any, unit: str, mean_s: float) -> Optional[Dict[str, Any]]:
  per_iteration = _number(per_iteration)
  if per_iteration is None or not mean_s or unit not in CRITERION_THROUGHPUT:
    return None
  return {'value': per_iteration / mean_s, 'unit': CRITERION_THROUGHPUT[unit]}


def parse_criterion_messages(messages: List[Dict]) -> Benchmarks:
  """`cargo criterion --message-format=json`: one JSON message per line"""
  benchmarks = []
  for message in messages:
    if message.get('reason') != 'benchmark-complete':
      continue
    mean = message.get('mean') or {}
    if _number(mean.get('estimate')) is None:
      continue
    unit = mean.get('unit') or message.get('unit') or 'ns'
    factor = TIME_UNITS.get(unit)
    counts = message.get('iteration_count')
    stats = _stats(
      mean=mean.get('estimate'),
      median=(message.get('median') or {}).get('estimate'),
      mad=(message.get('median_abs_dev') or {}).get('estimate'),
    )
    if factor is not None:
      stats = _scaled(stats, factor)
    if isinstance(counts, list):
      stats.update(_stats(samples=len(counts), iterations=sum(c for c in counts if _number(c) is not None)))
    throughput = None
    for t in message.get('throughput') or []:
      throughput = _criterion_throughput(t.get('per_iteration'), t.get('unit'), stats['mean'] if factor else 0)
      if throughput:
        break
    name = str(message.get('id'))
    benchmarks.append(Benchmark(
      name=name, group=_family(name), value=stats['mean'], unit='s' if factor is not None else unit,
      statistic='mean', stats=stats, throughput=throughput,
    ))
  return Benchmarks(benchmarks, 'criterion', {'harness': 'Criterion'})


def read_criterion_directory(path: Path) -> Benchmarks:
  """target/criterion: each benchmark's latest results are in <its directory>/new/ (base/ has the previous ones)"""
  benchmarks = []
  for info_path in sorted(path.glob('**/new/benchmark.json')):
    estimates_path = info_path.parent / 'estimates.json'
    if not estimates_path.exists():
      continue
    info = json.loads(info_path.read_text())
    estimates = json.loads(estimates_path.read_text())
    point = lambda key: (estimates.get(key) or {}).get('point_estimate')  # noqa: E731
    if _number(point('mean')) is None:
      continue
    stats = _scaled(_stats(mean=point('mean'), median=point('median'), stddev=point('std_dev'), mad=point('median_abs_dev')), 1e-9)
    sample_path = info_path.parent / 'sample.json'
    if sample_path.exists():
      iters = json.loads(sample_path.read_text()).get('iters') or []
      stats.update(_stats(samples=len(iters), iterations=sum(iters)))
    throughput = None
    for kind, amount in (info.get('throughput') or {}).items():
      unit = {'Bytes': 'bytes', 'BytesDecimal': 'bytes_decimal', 'Elements': 'elements'}.get(kind, '')
      throughput = _criterion_throughput(amount, unit, stats['mean'])
    name = info.get('full_id') or info.get('title') or str(info_path.parent.parent.relative_to(path))
    group = info.get('group_id')
    benchmarks.append(Benchmark(
      name=name, group=group if group and group != name else None, value=stats['mean'], statistic='mean',
      stats=stats, throughput=throughput,
    ))
  if not benchmarks:
    raise ValueError(f'{path}: no Criterion results (*/new/benchmark.json and estimates.json)')
  return Benchmarks(benchmarks, 'criterion', {'harness': 'Criterion'})


JMH_TIME = re.compile(r'^(ns|us|µs|ms|s)/op$')
JMH_RATE = re.compile(r'^ops/(ns|us|µs|ms|s|min)$')


def parse_jmh(data: List[Dict]) -> Benchmarks:
  def base_name(entry):
    params = entry.get('params') or {}
    suffix = f"[{','.join(f'{k}={v}' for k, v in params.items())}]" if params else ''
    return f"{entry.get('benchmark')}{suffix}"
  # a benchmark run in several modes (-bm avgt,thrpt) has one entry per mode
  counts: Dict[str, int] = {}
  for entry in data:
    counts[base_name(entry)] = counts.get(base_name(entry), 0) + 1
  benchmarks = []
  context: Dict[str, Any] = {}
  for entry in data:
    if not isinstance(entry, dict):
      continue
    metric = entry.get('primaryMetric') or {}
    score = _number(metric.get('score'))
    if score is None:
      continue
    if not context:
      vm = ' '.join(str(entry[k]) for k in ('vmName', 'jdkVersion') if entry.get(k))
      context = {'harness': ' '.join(x for x in (f"JMH {entry.get('jmhVersion')}" if entry.get('jmhVersion') else 'JMH', f'({vm})' if vm else '') if x)}
    unit_text = metric.get('scoreUnit') or ''
    percentiles = metric.get('scorePercentiles') or {}
    raw = metric.get('rawData') or []
    stats = _stats(
      mean=score, error=metric.get('scoreError'), median=percentiles.get('50.0'), min=percentiles.get('0.0'),
      max=percentiles.get('100.0'), samples=sum(len(r) for r in raw if isinstance(r, list)) or None,
      rounds=(entry.get('forks') or 1) * entry['measurementIterations'] if _number(entry.get('measurementIterations')) else None,
    )
    time, rate = JMH_TIME.match(unit_text), JMH_RATE.match(unit_text)
    if time:
      unit, smaller_is_better = 's', True
      stats = _scaled(stats, TIME_UNITS[time.group(1)])
    elif rate:
      # operations per second, whatever the file's unit
      unit, smaller_is_better = 'ops/s', False
      per = 60.0 if rate.group(1) == 'min' else TIME_UNITS[rate.group(1)]
      stats = {k: v / per if k in TIME_STATS else v for k, v in stats.items()}
    else:
      unit, smaller_is_better = unit_text, entry.get('mode') not in ('avgt', 'sample', 'ss')
    name = base_name(entry)
    if counts[name] > 1 and entry.get('mode'):
      name = f"{name} ({entry['mode']})"
    benchmark = str(entry.get('benchmark'))
    benchmarks.append(Benchmark(
      name=name, group=benchmark.rsplit('.', 1)[0] if '.' in benchmark else None, params=_params(entry.get('params')),
      value=stats['mean'], unit=unit, statistic='mean', smaller_is_better=smaller_is_better, stats=stats,
    ))
  return Benchmarks(benchmarks, 'jmh', context)


GO_LINE = re.compile(r'^(Benchmark\S+?)(?:-(\d+))?\s+(\d+)\s+(.+)$')


def _sum(values: List[float]) -> float:
  # in order, like the web app: Python 3.12's sum() of floats is compensated, its last digits would differ
  total = 0.0
  for v in values:
    total += v
  return total


def _mean(values: List[float]) -> float:
  return _sum(values) / len(values)


def parse_go(text: str) -> Benchmarks:
  """`go test -bench`: with -count=N each benchmark has N lines, we show their mean and standard deviation."""
  context: Dict[str, Any] = {'harness': 'go test'}
  runs: Dict[str, Dict[str, Any]] = {}
  pkg = None
  for line in text.splitlines():
    line = line.strip()
    header = re.match(r'^(goos|goarch|pkg|cpu):\s*(.+)$', line)
    if header:
      key, value = header.groups()
      if key == 'pkg':
        pkg = value
      else:
        context.setdefault({'goos': 'os', 'goarch': 'arch', 'cpu': 'cpu'}[key], value)
      continue
    match = GO_LINE.match(line)
    if not match:
      continue
    bench, procs, iterations, rest = match.groups()
    tokens = rest.split()
    values = {}
    for i in range(0, len(tokens) - 1, 2):
      try:
        values[tokens[i + 1]] = float(tokens[i])
      except ValueError:
        break
    if 'ns/op' not in values:
      continue
    if procs and 'cpu_count' not in context:
      context['cpu_count'] = int(procs)
    name = f'{pkg}.{bench}' if pkg else bench
    run = runs.setdefault(name, {'group': pkg, 'rows': []})
    run['rows'].append({'iterations': int(iterations), **values})
  benchmarks = []
  for name, run in runs.items():
    rows = run['rows']
    times = [r['ns/op'] * 1e-9 for r in rows]
    mean = _mean(times)
    stats: Dict[str, float] = {'mean': mean}
    if len(rows) > 1:
      stats['stddev'] = math.sqrt(_sum([(t - mean) ** 2 for t in times]) / (len(times) - 1))
      stats['min'] = min(times)
      stats['max'] = max(times)
      stats['rounds'] = len(rows)
    else:
      stats['iterations'] = rows[0]['iterations']
    for unit, key in (('B/op', 'bytes_per_op'), ('allocs/op', 'allocs_per_op')):
      if all(unit in r for r in rows):
        stats[key] = _mean([r[unit] for r in rows])
    throughput = None
    if all('MB/s' in r for r in rows):
      throughput = {'value': _mean([r['MB/s'] for r in rows]) * 1e6, 'unit': 'B/s'}
    benchmarks.append(Benchmark(
      name=name, group=run['group'], value=mean, statistic='mean', stats=stats, throughput=throughput,
    ))
  return Benchmarks(benchmarks, 'go', context)


def parse_normalized(data: Dict) -> Benchmarks:
  """Our format: times in any of ns, us, ms, s are converted to seconds"""
  if data.get('qaboard_benchmarks') != VERSION:
    raise ValueError(f"unsupported version of the benchmarks format: {data.get('qaboard_benchmarks')!r}")
  benchmarks = []
  for i, b in enumerate(data.get('benchmarks') or []):
    if not isinstance(b, dict) or not isinstance(b.get('name'), str) or _number(b.get('value')) is None:
      raise ValueError(f'benchmarks[{i}]: needs a name and a numeric value')
    unit = b.get('unit') or 's'
    factor = TIME_UNITS.get(unit)
    stats = _stats(**{k: v for k, v in (b.get('stats') or {}).items() if k in STATS})
    value = b['value']
    if factor is not None:
      stats, value, unit = _scaled(stats, factor), value * factor, 's'
    throughput = b.get('throughput')
    benchmarks.append(Benchmark(
      name=b['name'], group=b.get('group'), params=_params(b.get('params')), value=value, unit=unit,
      statistic=b.get('statistic'), smaller_is_better=b.get('smaller_is_better', True) is not False, stats=stats,
      throughput=throughput if isinstance(throughput, dict) and _number(throughput.get('value')) is not None else None,
    ))
  context = data.get('context') if isinstance(data.get('context'), dict) else {}
  return Benchmarks(benchmarks, data.get('source'), context)


def detect_format(data: Any, text: str = '') -> Optional[str]:
  """The format of a file, from its parsed JSON (None if it isn't JSON) or else its text"""
  if isinstance(data, dict):
    if 'qaboard_benchmarks' in data:
      return 'qaboard'
    rows = data.get('benchmarks')
    if 'machine_info' in data or (isinstance(rows, list) and rows and isinstance(rows[0], dict) and 'fullname' in rows[0]):
      return 'pytest-benchmark'
    if isinstance(rows, list) and isinstance(data.get('context'), dict):
      return 'google-benchmark'
    results = data.get('results')
    if isinstance(results, list) and all(isinstance(r, dict) and 'command' in r for r in results):
      return 'hyperfine'
    if 'reason' in data:
      return 'criterion'
  if isinstance(data, list) and data and all(isinstance(e, dict) and 'primaryMetric' in e for e in data):
    return 'jmh'
  if data is None:
    first = text.lstrip()[:1]
    if first == '{' and '"reason"' in text:
      return 'criterion'
    if re.search(r'^Benchmark\S*\s+\d+\s+\S+ ns/op', text, re.MULTILINE):
      return 'go'
  return None


PARSERS: Dict[str, Callable[[Any], Benchmarks]] = {
  'pytest-benchmark': parse_pytest_benchmark,
  'google-benchmark': parse_google_benchmark,
  'hyperfine': parse_hyperfine,
  'jmh': parse_jmh,
  'qaboard': parse_normalized,
}


def parse_benchmarks(text: str, format: Optional[str] = None) -> Benchmarks:
  """The benchmarks of a file's content. Raises ValueError for unknown formats and malformed files."""
  if format is not None and format not in FORMATS:
    raise ValueError(f"unknown benchmark format {format!r}, expected one of {', '.join(FORMATS)}")
  try:
    data = json.loads(text)
  except ValueError:
    data = None
  format = format or detect_format(data, text)
  if format is None:
    raise ValueError(f"unknown benchmark file: expected one of {', '.join(FORMATS)}")
  if format == 'go':
    parsed = parse_go(text)
  elif format == 'criterion':
    messages = [data] if isinstance(data, dict) else [json.loads(line) for line in text.splitlines() if line.strip().startswith('{')]
    parsed = parse_criterion_messages(messages)
  else:
    if data is None:
      raise ValueError(f'not a {format} file: not JSON')
    if format == 'jmh' and not isinstance(data, list):
      raise ValueError('not a JMH file: expected a list')
    if format != 'jmh' and not isinstance(data, dict):
      raise ValueError(f'not a {format} file: expected an object')
    parsed = PARSERS[format](data)
  return Benchmarks(_unique(parsed), parsed.source, parsed.context)


def read_benchmarks(path: Union[str, Path], format: Optional[str] = None) -> Benchmarks:
  """
  The benchmarks of a harness's file (or of a target/criterion directory), normalized: a list of `Benchmark`, with
  the file's `source` and `context` (machine, CPU, date, harness version) as attributes.
  The format is detected from the content; `format=` forces it: one of FORMATS.
  """
  path = Path(path)
  if path.is_dir():
    parsed = read_criterion_directory(path)
    return Benchmarks(_unique(parsed), parsed.source, parsed.context)
  try:
    return parse_benchmarks(path.read_text(encoding='utf-8'), format)
  except ValueError as e:
    raise ValueError(f'{path}: {e}') from None


def write_benchmarks(path: Union[str, Path], benchmarks: Iterable[Union[Benchmark, Dict]], context: Optional[Dict[str, Any]] = None, source: Optional[str] = None) -> Path:
  """
  Writes benchmarks in QA-Board's format, that the web app shows: name the file *.benchmarks.json.
  Use it for harnesses QA-Board doesn't read, with a list of dicts {name, value, unit, stats...}, or to show a
  Criterion directory: write_benchmarks(output_dir / "criterion.benchmarks.json", read_benchmarks("target/criterion"))
  """
  items = list(benchmarks)
  normalized = Benchmarks(
    [b if isinstance(b, Benchmark) else parse_normalized({'qaboard_benchmarks': VERSION, 'benchmarks': [b]})[0] for b in items],
    source=source or getattr(benchmarks, 'source', None),
    context={**getattr(benchmarks, 'context', {}), **(context or {})},
  )
  _unique(normalized)
  path = Path(path)
  path.write_text(json.dumps(normalized.to_dict(), indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
  return path


# How to show times, from the suite's typical one: (unit, suffix, scale from seconds)
DISPLAY_UNITS = {'ns': (' ns', 1e9), 'us': (' µs', 1e6), 'µs': (' µs', 1e6), 'ms': (' ms', 1e3), 's': (' s', 1.0)}
MAX_KEY_LENGTH = 200  # backend/backend/metrics_definitions.py
FORBIDDEN_KEYS = {'__proto__', 'constructor', 'prototype'}


def _display_unit(seconds: List[float]) -> str:
  if not seconds:
    return 's'
  typical = sorted(seconds)[len(seconds) // 2]
  for unit, limit in (('ns', 1e-6), ('us', 1e-3), ('ms', 1.0)):
    if typical < limit:
      return unit
  return 's'


def _hash(name: str) -> str:
  return hashlib.sha1(name.encode('utf-8')).hexdigest()[:8]


def metric_keys(names: List[str], prefix: str = '') -> Dict[str, str]:
  """
  Metric keys for benchmark names: lowercase snake_case, stable across commits. When names would share a key, or the
  key is too long or reserved, a hash of the name tells them apart.
  """
  slugs = {name: prefix + re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_') for name in names}
  counts: Dict[str, int] = {}
  for slug in slugs.values():
    counts[slug] = counts.get(slug, 0) + 1
  keys = {}
  for name, slug in slugs.items():
    if counts[slug] > 1 or slug in FORBIDDEN_KEYS or slug == prefix or len(slug) > MAX_KEY_LENGTH:
      slug = f'{slug[:MAX_KEY_LENGTH - 9].rstrip("_")}_{_hash(name)}'
    keys[name] = slug
  return keys


def short_name(benchmark: Benchmark) -> str:
  """The name without its group, or its module for pytest's: what the viewer shows (shortName in the web app)"""
  group, name = benchmark.group, benchmark.name
  if group and name.startswith(group) and len(name) > len(group):
    rest = name[len(group):].lstrip('/.: ')
    if rest and rest != name[len(group):]:
      return rest
  if '::' in name:
    return name.rsplit('::', 1)[1] or name
  return name


def benchmark_metrics(path_or_benchmarks: Union[str, Path, Iterable[Benchmark]], statistic: Optional[str] = None, prefix: str = '', unit: Optional[str] = None) -> Dict[str, Metric]:
  """
  Metrics to return from run(), one per benchmark: {key: Metric(value, label=..., suffix=..., smaller_is_better=...)}.
  - path_or_benchmarks: a harness's file (see read_benchmarks), or benchmarks you read.
  - statistic: what to return, among the benchmark's stats (mean, median, min...). By default, its headline value.
    Benchmarks without it are left out.
  - prefix: for the keys, e.g. "bench_" or "codec_" when a run returns several suites.
  - unit: how to show times, ns, us, ms or s. By default, the unit of the suite's median time.
  Times are returned in seconds, whatever the unit they are shown in (with the metric's `scale`): values stay
  comparable across commits, even if the suite's typical unit changes.
  """
  if isinstance(path_or_benchmarks, (str, Path)):
    benchmarks: List[Benchmark] = read_benchmarks(path_or_benchmarks)
  else:
    benchmarks = list(path_or_benchmarks)
  if unit is not None and unit not in DISPLAY_UNITS:
    raise ValueError(f"unknown unit {unit!r}, expected one of ns, us, ms, s")
  values: Dict[str, Tuple[Benchmark, float]] = {}
  for b in benchmarks:
    value = _number(b.value if statistic is None else b.stats.get(statistic))
    if value is not None:
      values[b.name] = (b, value)
  times = [v for b, v in values.values() if b.unit == 's']
  suffix, scale = DISPLAY_UNITS[unit or _display_unit(times)]
  keys = metric_keys(list(values), prefix)
  metrics = {}
  for name, (b, value) in values.items():
    label = name if len(name) <= MAX_TEXT_LENGTH else name[:MAX_TEXT_LENGTH - 1] + '…'
    short_label = short_name(b)[:MAX_TEXT_LENGTH]
    if b.unit == 's':
      metrics[keys[name]] = Metric(value, label=label, short_label=short_label, suffix=suffix, scale=scale, smaller_is_better=b.smaller_is_better)
    else:
      metrics[keys[name]] = Metric(value, label=label, short_label=short_label, suffix=f' {b.unit}'[:MAX_TEXT_LENGTH], smaller_is_better=b.smaller_is_better)
  return metrics
