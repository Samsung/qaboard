"""
Flame graphs from what profilers write, for QA-Board's flame graph viewer (webapp/src/viewers/flame-graph.jsx).

The viewer reads folded stacks, speedscope and Chrome's .cpuprofile files as profilers write them: a run can save
them in its output directory with no conversion. This module is for the rest, what browsers can't reasonably read:
- `perf script`'s text, often hundreds of MB, collapsed into folded stacks like Brendan Gregg's stackcollapse-perf.pl,
- pprof's gzipped protobuf (Go, and many other profilers), read with a small decoder of profile.proto,
- stacks your own code collected, a {"outer;...;inner": value} dict,
and to say the values' unit, or to rescale them, so that runs of different lengths compare:

    from qaboard.flamegraphs import save_flame_graph
    save_flame_graph(output_dir / 'cpu.folded', 'perf.script.txt')
    save_flame_graph(output_dir / 'cpu.folded', 'cpu.pb.gz')
    # values in µs of CPU per 1,000 requests, rather than samples
    save_flame_graph(output_dir / 'cpu.folded', output_dir / 'cpu.folded', total=cpu_us / requests * 1000,
                     unit='microseconds of CPU per 1,000 requests')

Folded stacks are one line per stack, outermost frame first, then its value: `main;parse;read 12`. We write the unit
in a comment line, `# unit: microseconds`, that other tools skip (flamegraph.pl, inferno and speedscope ignore lines
that don't end with a number). Only the standard library: it's imported from projects' `run()`.
"""
import gzip
import io
import os
import re
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, NamedTuple, Optional, Tuple, Union

# What the viewer knows how to show, besides any other word ("allocations", "cycles"), shown as is.
# Extra words after the unit describe it: "microseconds of CPU per 1,000 requests".
UNITS = ('samples', 'nanoseconds', 'microseconds', 'milliseconds', 'seconds', 'bytes', 'count')

Source = Union[str, os.PathLike, bytes, Dict[str, float], 'Profile']


class Profile(NamedTuple):
  """Stacks ("outer;...;inner" -> value) and the unit of their values"""
  stacks: Dict[str, float]
  unit: str = 'samples'

  @property
  def total(self) -> float:
    return sum(self.stacks.values())

  def share(self, pattern: str) -> float:
    """The share of the total in stacks with a frame that matches the regular expression, e.g. to return as a metric"""
    regex = re.compile(pattern)
    total = self.total
    matching = sum(v for stack, v in self.stacks.items() if any(regex.search(f) for f in stack.split(';')))
    return matching / total if total else 0.0

  def scaled(self, factor: float, unit: Optional[str] = None) -> 'Profile':
    return Profile({stack: v * factor for stack, v in self.stacks.items()}, unit or self.unit)

  def folded(self) -> str:
    """The folded stacks' text, with the unit in a comment line"""
    lines = [f'# unit: {self.unit}'] if self.unit else []
    lines += [f'{stack} {_number(v)}' for stack, v in sorted(self.stacks.items()) if v]
    return '\n'.join(lines) + '\n'


def _number(value: float) -> str:
  if float(value).is_integer():
    return str(int(value))
  return f'{value:.3f}'.rstrip('0').rstrip('.')


def _integers(profile: Profile) -> Profile:
  """Rounded to integers, what most tools read, unless that loses more than 1% of the total (small values)"""
  rounded: Dict[str, float] = {stack: round(v) for stack, v in profile.stacks.items()}
  rounded = {stack: v for stack, v in rounded.items() if v}
  total = profile.total
  if total and abs(sum(rounded.values()) - total) > 0.01 * abs(total):
    return profile
  return Profile(rounded, profile.unit)


# ---------------------------------------------------------------------------- folded stacks

def read_folded(text: str, unit: Optional[str] = None) -> Profile:
  """Folded stacks: `frame;frame;frame value` per line. Lines that don't end with a number are skipped."""
  stacks: Dict[str, float] = {}
  for line in text.splitlines():
    if line.startswith('#'):
      match = re.match(r'#\s*unit:\s*(.+?)\s*$', line)
      if match and not unit:
        unit = match.group(1)
      continue
    stack, _, count = line.rstrip().rpartition(' ')
    if not stack:
      continue
    try:
      value = float(count) if '.' in count or 'e' in count else int(count)
    except ValueError:
      continue
    stack = stack.rstrip()
    stacks[stack] = stacks.get(stack, 0) + value
  return Profile(stacks, unit or 'samples')


# ---------------------------------------------------------------------------- perf script

# "java 25607 4794564.109216: 1 cycles:", "java 12688 [002] 6544038.708352: 10309278 cpu-clock:",
# "V8 WorkerThread 24636/25607 [000] 94564.109216: 100 cycles:": the command can have spaces, then pid/tid or tid
_PERF_HEADER = re.compile(r'^(\S.*?)\s+(\d+)(?:/(\d+))?(?:\s|$)')
_PERF_EVENT = re.compile(r':\s*(\d+)?\s+(\S+?):?\s*$')
# "\tffffffff8105f6c4 native_write_msr_safe+0x4 ([kernel.kallsyms])": address, function, module. The module is the
# last parenthesis: C++ functions can have " (" in them (`std::function<void (int)>::operator()`,
# `f<int, (anonymous namespace)::T>`), and modules can end with " (deleted)".
_PERF_MODULE = r'\(((?:[^()]|\([^()]*\))*)\)'
_PERF_FRAME = re.compile(r'^\s+([0-9a-fA-F]+)\s+(.+)\s+' + _PERF_MODULE + r'\s*$')
_PERF_FRAME_NO_ADDRESS = re.compile(r'^\s+(.+)\s+' + _PERF_MODULE + r'\s*$')


def _tidy(function: str, module: str, annotate: bool) -> str:
  function = re.sub(r'\+0x[0-9a-fA-F]+$', '', function)
  if function == '[unknown]' and module and module != '[unknown]':
    # the module is better than nothing: [libc.so.6]
    function = f'[{os.path.basename(module)}]'
  # ';' separates frames. C++ arguments make names long and break the matching between runs if they change
  function = function.replace(';', ':').replace('"', '').replace("'", '')
  if '(anonymous namespace)' not in function and not function.startswith('['):
    function = re.sub(r'\(.*', '', function).rstrip() or function
  if function.startswith('L') and '/' in function:  # Java: Ljava/util/HashMap;::get
    function = function[1:]
  if annotate:
    if 'kernel.kallsyms' in module or os.path.basename(module).startswith('vmlinux'):
      function += '_[k]'
    elif re.search(r'/tmp/perf-\d+\.map', module):
      function += '_[j]'
  return function


def collapse_perf_script(lines: Union[str, Iterable[str]], pid: bool = False, tid: bool = False,
                         annotate: bool = False, event: Optional[str] = None, period: bool = False) -> Profile:
  """
  Folded stacks from `perf script`'s output, like stackcollapse-perf.pl: one stack per sample, the command first
  (spaces become `_`), then the frames from the outermost; offsets (`+0x1c`) and C++ arguments are removed, unknown
  functions show their module (`[libc.so.6]`).
  - pid, tid: add the process or thread id to the command (`java-1234/1240`); they change from run to run, so the
    diff against the reference can't match them.
  - annotate: suffix kernel frames with `_[k]`, JIT frames with `_[j]`.
  - event: when the file has several events, the one to keep (default: the first one seen).
  - period: weigh samples by their period rather than counting them (`cpu-clock` periods are nanoseconds).
  """
  if isinstance(lines, str):
    lines = lines.splitlines()
  stacks: Dict[str, float] = {}
  unit = 'samples'
  header: Optional[Tuple[str, float]] = None
  frames: List[str] = []
  keep = True

  def flush():
    if header and keep:
      command, weight = header
      stack = ';'.join([command, *reversed(frames)])
      stacks[stack] = stacks.get(stack, 0) + weight

  for line in lines:
    line = line.rstrip('\n')
    if not line.strip():
      flush()
      header, frames = None, []
      continue
    if line.startswith('#'):
      continue
    if not line[0].isspace():
      flush()
      frames = []
      match = _PERF_HEADER.match(line)
      if not match:
        header = None
        continue
      command, first, second = match.groups()
      command = command.replace(' ', '_')
      process, thread = (first, second) if second else ('?', first)
      if pid and tid:
        command = f'{command}-{process}/{thread}'
      elif pid:
        command = f'{command}-{process}'
      elif tid:
        command = f'{command}-{thread}'
      weight: float = 1
      event_match = _PERF_EVENT.search(line[match.end(0) - 1:])
      if event_match:
        sample_event = event_match.group(2)
        if event is None:
          event = sample_event
        keep = sample_event == event
        if period and event_match.group(1):
          weight = int(event_match.group(1))
          if event.split(':')[0] in ('cpu-clock', 'task-clock'):
            unit = 'nanoseconds'
          else:
            unit = event
      header = (command, weight)
      continue
    if header is None:
      continue
    match = _PERF_FRAME.match(line)
    if match:
      _, function, module = match.groups()
    else:
      match = _PERF_FRAME_NO_ADDRESS.match(line)
      if not match:
        continue
      function, module = match.groups()
    frames.append(_tidy(function, module, annotate))
  flush()
  return Profile(stacks, unit)


# ---------------------------------------------------------------------------- pprof
# A decoder of the parts of profile.proto we need: https://github.com/google/pprof/blob/main/proto/profile.proto
#   Profile: 1 sample_type (ValueType), 2 sample, 4 location, 5 function, 6 string_table, 3 mapping,
#            11 period_type, 12 period, 14 default_sample_type
#   ValueType: 1 type, 2 unit (indexes in string_table)    Sample: 1 location_id (packed), 2 value (packed)
#   Location: 1 id, 2 mapping_id, 3 address, 4 line        Line: 1 function_id, 2 line
#   Function: 1 id, 2 name, 3 system_name, 4 filename      Mapping: 1 id, 5 filename

def _varint(data: bytes, i: int) -> Tuple[int, int]:
  result = shift = 0
  while True:
    byte = data[i]
    i += 1
    result |= (byte & 0x7f) << shift
    if byte < 0x80:
      return result, i
    shift += 7


def _fields(data: bytes) -> Iterator[Tuple[int, int, Union[int, bytes]]]:
  """(field number, wire type, value): an int for varints and fixed sizes, bytes for length-delimited fields"""
  i, end = 0, len(data)
  while i < end:
    key, i = _varint(data, i)
    number, wire = key >> 3, key & 7
    value: Union[int, bytes]
    if wire == 0:
      value, i = _varint(data, i)
    elif wire == 2:
      length, i = _varint(data, i)
      value, i = data[i:i + length], i + length
    elif wire == 1:
      value, i = int.from_bytes(data[i:i + 8], 'little'), i + 8
    elif wire == 5:
      value, i = int.from_bytes(data[i:i + 4], 'little'), i + 4
    else:
      raise ValueError(f'not a pprof profile: wire type {wire} at byte {i}')
    yield number, wire, value


def _signed(value: int) -> int:
  return value - (1 << 64) if value >= 1 << 63 else value


def _ints(wire: int, value: Union[int, bytes]) -> List[int]:
  """A repeated integer field: packed (length-delimited) or not"""
  if wire != 2:
    return [value]  # type: ignore
  assert isinstance(value, bytes)
  out, i = [], 0
  while i < len(value):
    v, i = _varint(value, i)
    out.append(v)
  return out


def read_pprof(data: bytes, sample_type: Union[None, int, str] = None) -> Profile:
  """
  Folded stacks from a pprof profile (gzipped or not). Frames are function names, inlined functions included;
  locations without symbols show their module (`[libc.so.6]`) or address.
  - sample_type: which value to use, by index or name: Go's CPU profiles have `samples` and `cpu` (nanoseconds,
    the default), heap profiles `alloc_objects`, `alloc_space`, `inuse_objects` and `inuse_space` (bytes, the default).
    The default is the profile's default_sample_type, else its last, like `go tool pprof`.
  """
  if data[:2] == b'\x1f\x8b':
    data = gzip.decompress(data)
  strings: List[str] = []
  sample_types: List[Tuple[int, int]] = []
  samples: List[Tuple[List[int], List[int]]] = []
  locations: Dict[int, Tuple[int, int, List[int]]] = {}  # id -> mapping id, address, function ids (innermost first)
  functions: Dict[int, int] = {}  # id -> name
  mappings: Dict[int, int] = {}  # id -> filename
  default_sample_type = 0
  for number, wire, value in _fields(data):
    if number == 6:
      assert isinstance(value, bytes)
      strings.append(value.decode('utf-8', errors='replace'))
    elif number == 1:
      assert isinstance(value, bytes)
      fields = {n: v for n, _, v in _fields(value)}
      sample_types.append((int(fields.get(1, 0)), int(fields.get(2, 0))))  # type: ignore
    elif number == 2:
      assert isinstance(value, bytes)
      location_ids: List[int] = []
      values: List[int] = []
      for n, w, v in _fields(value):
        if n == 1:
          location_ids += _ints(w, v)
        elif n == 2:
          values += [_signed(x) for x in _ints(w, v)]
      samples.append((location_ids, values))
    elif number == 4:
      assert isinstance(value, bytes)
      location_id = mapping_id = address = 0
      function_ids: List[int] = []
      for n, _, v in _fields(value):
        if n == 1:
          location_id = int(v)  # type: ignore
        elif n == 2:
          mapping_id = int(v)  # type: ignore
        elif n == 3:
          address = int(v)  # type: ignore
        elif n == 4:
          assert isinstance(v, bytes)
          line = {ln: lv for ln, _, lv in _fields(v)}
          function_ids.append(int(line.get(1, 0)))  # type: ignore
      locations[location_id] = (mapping_id, address, function_ids)
    elif number == 5:
      assert isinstance(value, bytes)
      fields = {n: v for n, _, v in _fields(value)}
      functions[int(fields.get(1, 0))] = int(fields.get(2, 0))  # type: ignore
    elif number == 3:
      assert isinstance(value, bytes)
      fields = {n: v for n, _, v in _fields(value)}
      mappings[int(fields.get(1, 0))] = int(fields.get(5, 0))  # type: ignore
    elif number == 14:
      default_sample_type = int(value)  # type: ignore

  def string(index: int) -> str:
    return strings[index] if 0 <= index < len(strings) else ''

  if not sample_types:
    raise ValueError('not a pprof profile: no sample types')
  names = [string(t) for t, _ in sample_types]
  if sample_type is None:
    index = names.index(string(default_sample_type)) if default_sample_type and string(default_sample_type) in names else len(names) - 1
  elif isinstance(sample_type, int):
    index = sample_type
  elif sample_type in names:
    index = names.index(sample_type)
  else:
    raise ValueError(f'no sample type {sample_type!r} in the profile: {", ".join(names)}')
  type_name, unit = names[index], string(sample_types[index][1])
  if unit == 'count':
    unit = 'samples' if type_name == 'samples' else type_name

  cache: Dict[int, List[str]] = {}

  def frames(location_id: int) -> List[str]:
    # outermost first: a location's lines list the inlined functions first, the function they're inlined in last
    if location_id not in cache:
      mapping_id, address, function_ids = locations.get(location_id, (0, 0, []))
      names = [string(functions.get(f, 0)).replace(';', ':') for f in reversed(function_ids)]
      names = [n for n in names if n]
      if not names:
        module = os.path.basename(string(mappings.get(mapping_id, 0)))
        names = [f'[{module}]' if module else f'0x{address:x}']
      cache[location_id] = names
    return cache[location_id]

  stacks: Dict[str, float] = {}
  for location_ids, values in samples:
    if index >= len(values) or not values[index]:
      continue
    stack = ';'.join(f for location_id in reversed(location_ids) for f in frames(location_id))
    stacks[stack] = stacks.get(stack, 0) + values[index]
  return Profile(stacks, unit or 'samples')


# ---------------------------------------------------------------------------- reading and saving

# Formats the viewer reads by itself
_VIEWER_FORMATS = ('speedscope', 'cpuprofile', 'json')


def detect_format(data: bytes, name: str = '') -> str:
  """'folded', 'perf-script', 'pprof', or what the viewer reads by itself: 'speedscope', 'cpuprofile', 'json'"""
  name = name.lower()
  if data[:2] == b'\x1f\x8b':
    head = gzip.GzipFile(fileobj=io.BytesIO(data)).read(4096)
    # pprof's first field is usually its sample types (field 1, length-delimited: 0x0a)
    if name.endswith(('.pb.gz', '.pprof', '.pprof.gz')) or head[:1] == b'\x0a':
      return 'pprof'
    return detect_format(head, name[:-3] if name.endswith('.gz') else name)
  if name.endswith(('.pb', '.pprof')):
    return 'pprof'
  text = data[:65536].decode('utf-8', errors='replace')
  stripped = text.lstrip()
  # folded stacks can start with a bracket: "[unknown];main 3", "[kernel.kallsyms];do_syscall_64 1"
  folded_bracket = re.match(r'\[[^\s",[\]{}]+\](;|\s+[\d.e+]+\s*$)', stripped.split('\n', 1)[0])
  if stripped.startswith(('{', '[')) and not folded_bracket:
    if 'speedscope' in text[:2000] or '"shared"' in text:
      return 'speedscope'
    if '"callFrame"' in text:
      return 'cpuprofile'
    return 'json'
  lines = [line for line in text.splitlines()[:-1] if line.strip() and not line.startswith('#')]
  if any(_PERF_FRAME.match(line) for line in lines[:200]) and any(_PERF_HEADER.match(line) for line in lines[:200]):
    return 'perf-script'
  return 'folded'


def read_profile(source: Source, format: Optional[str] = None, **options) -> Profile:
  """
  A profile from a file (path), its content (bytes), stacks ({"outer;...;inner": value}) or a Profile.
  format: 'folded', 'perf-script' or 'pprof', detected from the content (and the file name) by default.
  options: those of collapse_perf_script or read_pprof.
  """
  if isinstance(source, Profile):
    return source
  if isinstance(source, dict):
    return Profile(dict(source), options.get('unit', 'samples'))
  name = ''
  if isinstance(source, (str, os.PathLike)):
    name = str(source)
    data = Path(source).read_bytes()
  else:
    data = source
  format = format or detect_format(data, name)
  if format == 'pprof':
    return read_pprof(data, sample_type=options.get('sample_type'))
  if data[:2] == b'\x1f\x8b':
    data = gzip.decompress(data)
  text = data.decode('utf-8', errors='replace')
  if format == 'perf-script':
    keys = ('pid', 'tid', 'annotate', 'event', 'period')
    return collapse_perf_script(text, **{k: v for k, v in options.items() if k in keys})
  if format == 'folded':
    return read_folded(text)
  if format in _VIEWER_FORMATS:
    raise ValueError(f'{name or "the profile"} is {format}: the flame graph viewer reads it as it is, save the file '
                     'itself (see the docs: Viewers > Flame graphs)')
  raise ValueError(f'unknown profile format: {format}')


def save_flame_graph(path: Union[str, os.PathLike], source: Source, format: Optional[str] = None,
                     unit: Optional[str] = None, total: Optional[float] = None, scale: Optional[float] = None,
                     **options) -> Profile:
  """
  Saves a profile as folded stacks for the flame graph viewer, and returns it (e.g. for `profile.share('lock')`).
  - source: a file (`perf script` output, pprof, folded stacks), its bytes, a {"outer;...;inner": value} dict.
    It can be `path` itself, to rescale a file in place.
  - unit: the values' unit, e.g. 'samples', 'nanoseconds', 'bytes', 'microseconds of CPU per 1,000 requests'.
    By default the source's (folded stacks are samples, unless they say otherwise).
  - total: rescale the values so that they add up to it, e.g. the CPU time per request: runs that took a different
    number of samples then compare in absolute values.
  - scale: multiply the values (e.g. by the sampling period).
  Values are written as integers, what most tools read, unless rounding loses more than 1% of the total.
  """
  profile = read_profile(source, format=format, **options)
  if scale is not None:
    profile = profile.scaled(scale)
  if total is not None:
    profile = profile.scaled(total / profile.total if profile.total else 0)
  if unit:
    profile = Profile(profile.stacks, unit)
  profile = _integers(profile)
  path = Path(path)
  path.parent.mkdir(parents=True, exist_ok=True)
  if path.name.endswith('.gz'):
    path.write_bytes(gzip.compress(profile.folded().encode('utf-8'), mtime=0))
  else:
    path.write_text(profile.folded(), encoding='utf-8')
  return profile


__all__: List[str] = ['Profile', 'UNITS', 'collapse_perf_script', 'detect_format', 'read_folded', 'read_pprof',
                      'read_profile', 'save_flame_graph']

