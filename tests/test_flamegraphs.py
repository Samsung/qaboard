"""
qaboard/flamegraphs.py: what profilers write -> the folded stacks the flame graph viewer reads.
The fixtures in tests/fixtures/flamegraphs/ are real profiles (py-spy, Go's runtime/pprof, node --cpu-prof), but
perf.script.txt, written like `perf script` prints. The web app's tests read them too (webapp/src/viewers/flamegraph/).
"""
import gzip
import os
import tempfile
import unittest
from pathlib import Path

from qaboard.flamegraphs import (Profile, collapse_perf_script, detect_format, read_folded, read_pprof, read_profile,
                                 save_flame_graph)

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'flamegraphs'


# A minimal protobuf encoder, to write pprof profiles with what Go's runtime doesn't (unsymbolized locations)
def _varint(value: int) -> bytes:
  value &= (1 << 64) - 1
  out = b''
  while True:
    byte = value & 0x7f
    value >>= 7
    if value:
      out += bytes([byte | 0x80])
    else:
      return out + bytes([byte])

def _field(number: int, value) -> bytes:
  if isinstance(value, int):
    return _varint(number << 3) + _varint(value)
  if isinstance(value, str):
    value = value.encode()
  return _varint(number << 3 | 2) + _varint(len(value)) + value

def _packed(number: int, values) -> bytes:
  return _field(number, b''.join(_varint(v) for v in values))


class TestPerfScript(unittest.TestCase):
  def setUp(self):
    self.text = (FIXTURES / 'perf.script.txt').read_text()

  def test_collapses_like_stackcollapse_perf(self):
    profile = collapse_perf_script(self.text)
    self.assertEqual(profile.stacks, {
      'gateway-bench;start_thread;gateway::gateway::worker;gateway::model::dense_int8;gateway::model::dot_i8': 2,
      # the command's spaces become _, C++ arguments and offsets go, the kernel's frames are the innermost
      'gateway_worker;gateway::gateway::worker;<gateway::cache::Shared>::respond;std::sync::Mutex<T>::lock;'
      '__lll_lock_wake;futex_wake;_raw_spin_unlock_irqrestore': 1,
      # unknown functions show their module
      'gateway_worker;gateway::gateway::worker;<gateway::cache::Shared>::respond;[libc.so.6]': 1,
      'swapper;do_idle;default_idle': 1,
      'gateway-bench;gateway::gateway::worker;[unknown]': 1,
      # the page-faults sample is another event: only the first one seen is kept
    })
    self.assertEqual(profile.unit, 'samples')

  def test_options(self):
    profile = collapse_perf_script(self.text, pid=True, tid=True, annotate=True)
    self.assertIn('gateway_worker-31204/31207;gateway::gateway::worker;<gateway::cache::Shared>::respond;'
                  'std::sync::Mutex<T>::lock;__lll_lock_wake;futex_wake_[k];_raw_spin_unlock_irqrestore_[k]', profile.stacks)
    self.assertIn('swapper-?/0;do_idle_[k];default_idle_[k]', profile.stacks)
    self.assertIn('gateway-bench-31204;gateway::gateway::worker', collapse_perf_script(self.text, tid=True, event='page-faults').stacks)
    # periods of cpu-clock are nanoseconds
    timed = collapse_perf_script(self.text, period=True)
    self.assertEqual(timed.unit, 'nanoseconds')
    self.assertEqual(timed.total, 6 * 10101010)

  def test_minimal_fields(self):
    # perf script -F comm,tid,ip,sym,dso
    text = 'python3 812\n\t7f00aa10 PyEval_EvalFrameDefault (/usr/bin/python3.11)\n\t7f00aa00 main (/usr/bin/python3.11)\n'
    self.assertEqual(collapse_perf_script(text).stacks, {'python3;main;PyEval_EvalFrameDefault': 1})

  def test_cpp_functions_with_parentheses(self):
    # the module is the last parenthesis: C++ names can have " (" in them, modules can be "(deleted)"
    text = ('app 812 1.0: 1 cycles:\n'
            '\t7f00aa30 std::_Function_handler<void (int), Task>::_M_invoke+0x10 (/usr/bin/app)\n'
            '\t7f00aa20 void run<int, (anonymous namespace)::Job>(int) (/usr/bin/app)\n'
            '\t7f00aa10 work (/tmp/app (deleted))\n'
            '\t7f00aa00 main (/usr/bin/app)\n')
    stacks = collapse_perf_script(text).stacks
    self.assertEqual(list(stacks), ['app;main;work;void run<int, (anonymous namespace)::Job>(int);std::_Function_handler<void'])

  def test_detected(self):
    self.assertEqual(detect_format(self.text.encode(), 'perf.script.txt'), 'perf-script')
    self.assertEqual(read_profile(FIXTURES / 'perf.script.txt').total, 6)


class TestPprof(unittest.TestCase):
  def test_go_cpu_profile(self):
    # go tool pprof -traces tests/fixtures/flamegraphs/go-cpu.pb.gz: "Total samples = 720ms", 370ms in main.parse (flat)
    profile = read_profile(FIXTURES / 'go-cpu.pb.gz')
    self.assertEqual(profile.unit, 'nanoseconds')
    self.assertEqual(profile.total, 720_000_000)
    self.assertEqual(profile.stacks['runtime.main;main.main;main.handle;main.parse'], 370_000_000)
    # inlined functions are frames, outermost first
    self.assertTrue(any(s.endswith('main.render;strings.(*Builder).WriteByte;strings.(*Builder).copyCheck') for s in profile.stacks))
    samples = read_profile(FIXTURES / 'go-cpu.pb.gz', sample_type='samples')
    self.assertEqual((samples.unit, samples.total), ('samples', 72))
    with self.assertRaises(ValueError):
      read_profile(FIXTURES / 'go-cpu.pb.gz', sample_type='alloc_space')

  def test_unsymbolized_and_heap(self):
    strings = ['', 'alloc_space', 'bytes', 'inuse_space', 'main', 'decode', '/usr/lib/libz.so.1', 'samples', 'count']
    data = b''.join([
      _field(1, _field(1, 7) + _field(2, 8)),  # samples/count
      _field(1, _field(1, 1) + _field(2, 2)),  # alloc_space/bytes
      _field(1, _field(1, 3) + _field(2, 2)),  # inuse_space/bytes
      _field(2, _packed(1, [3, 2, 1]) + _packed(2, [1, 4096, 1024])),
      _field(2, _field(1, 2) + _field(1, 1) + _field(2, 2) + _field(2, 2048) + _field(2, 0)),  # not packed
      _field(2, _packed(1, [4, 1]) + _packed(2, [1, -5, 0])),
      _field(3, _field(1, 1) + _field(5, 6)),
      _field(4, _field(1, 1) + _field(4, _field(1, 1))),
      _field(4, _field(1, 2) + _field(4, _field(1, 2))),
      _field(4, _field(1, 3) + _field(2, 1) + _field(3, 0x7f12)),
      _field(4, _field(1, 4) + _field(3, 0xbeef)),
      _field(5, _field(1, 1) + _field(2, 4)),
      _field(5, _field(1, 2) + _field(2, 5)),
      *[_field(6, s) for s in strings],
    ])
    profile = read_pprof(gzip.compress(data), sample_type='alloc_space')
    self.assertEqual(profile.unit, 'bytes')
    self.assertEqual(profile.stacks, {'main;decode;[libz.so.1]': 4096, 'main;decode': 2048, 'main;0xbeef': -5})
    # the default is the last sample type, like go tool pprof
    self.assertEqual(read_pprof(data).stacks, {'main;decode;[libz.so.1]': 1024})
    self.assertEqual(detect_format(gzip.compress(data)), 'pprof')


class TestFolded(unittest.TestCase):
  def test_reads_folded_stacks(self):
    profile = read_profile(FIXTURES / 'py-spy.folded')
    self.assertEqual(detect_format((FIXTURES / 'py-spy.folded').read_bytes()), 'folded')
    self.assertEqual(profile.total, 196)
    profile = read_folded('# unit: bytes\na;b 1.5\na;b 2\n\nnot a stack\nc 3\n')
    self.assertEqual(profile, Profile({'a;b': 3.5, 'c': 3}, 'bytes'))

  def test_share(self):
    profile = read_folded('main;lock_contended 30\nmain;model 50\nmain 20\n')
    self.assertAlmostEqual(profile.share('lock'), 0.3)
    self.assertAlmostEqual(profile.share('^main$'), 1.0)

  def test_folded_stacks_that_start_with_a_bracket(self):
    data = b'[unknown];main;parse 3\n[unknown];main 1\n'
    self.assertEqual(detect_format(data, 'cpu.folded'), 'folded')
    self.assertEqual(read_profile(data).total, 4)
    self.assertEqual(detect_format(b'[{"name": "all"}]', 'x.json'), 'json')

  def test_formats_the_viewer_reads(self):
    self.assertEqual(detect_format((FIXTURES / 'py-spy.speedscope.json').read_bytes()), 'speedscope')
    self.assertEqual(detect_format((FIXTURES / 'node.cpuprofile').read_bytes()), 'cpuprofile')
    with self.assertRaisesRegex(ValueError, 'reads it as it is'):
      read_profile(FIXTURES / 'node.cpuprofile')


class TestSave(unittest.TestCase):
  def test_saves_folded_stacks_with_their_unit(self):
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'out' / 'cpu.folded'
      save_flame_graph(path, FIXTURES / 'go-cpu.pb.gz')
      text = path.read_text()
      self.assertTrue(text.startswith('# unit: nanoseconds\n'))
      self.assertIn('runtime.main;main.main;main.handle;main.parse 370000000\n', text)
      self.assertEqual(read_profile(path).total, 720_000_000)

  def test_rescales_in_place(self):
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'cpu.folded'
      path.write_text('worker;model 600\nworker;respond 300\ningress 100\n')
      profile = save_flame_graph(path, path, total=2500, unit='microseconds of CPU per 1,000 requests')
      self.assertEqual(profile.stacks, {'worker;model': 1500, 'worker;respond': 750, 'ingress': 250})
      self.assertEqual(path.read_text(), '# unit: microseconds of CPU per 1,000 requests\n'
                                         'ingress 250\nworker;model 1500\nworker;respond 750\n')
      # small values keep decimals, rather than rounding to nothing
      profile = save_flame_graph(path, {'a': 1, 'b': 2}, total=0.3, unit='seconds')
      self.assertEqual(path.read_text(), '# unit: seconds\na 0.1\nb 0.2\n')

  def test_gzipped(self):
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'cpu.folded.gz'
      save_flame_graph(path, FIXTURES / 'perf.script.txt', scale=10)
      self.assertEqual(read_profile(path).total, 60)
      self.assertEqual(detect_format(path.read_bytes(), path.name), 'folded')


def imported_modules(path: Path):
  """The modules a file imports, relative imports as '.name'"""
  import ast
  names = set()
  for node in ast.walk(ast.parse(path.read_text())):
    if isinstance(node, ast.Import):
      names.update(alias.name for alias in node.names)
    elif isinstance(node, ast.ImportFrom):
      names.add('.' * node.level + (node.module or ''))
  return names


def loaded_by_the_cli():
  """The qaboard modules `import qaboard` and the `qa` CLI's module load, in a fresh interpreter"""
  import subprocess
  import sys
  import tempfile
  code = "import sys, qaboard, qaboard.qa; print(' '.join(m for m in sys.modules if m.startswith('qaboard')))"
  with tempfile.TemporaryDirectory() as tmp:
    process = subprocess.run([sys.executable, '-c', code], cwd=tmp, capture_output=True, text=True, check=True,
                             env={**os.environ, 'QA_NO_CHECK_FOR_UPDATES': '1'})
  return set(process.stdout.split())


class TestIsolation(unittest.TestCase):
  """Projects import qaboard.flamegraphs from their run(): it doesn't weigh on `import qaboard` or the `qa` CLI, and needs
  only the standard library."""
  def test_imports_only_the_standard_library(self):
    import sys
    path = Path(__file__).resolve().parent.parent / 'qaboard' / 'flamegraphs.py'
    allowed = set(sys.stdlib_module_names)
    for name in imported_modules(path):
      self.assertTrue((name if name.startswith('.') else name.split('.')[0]) in allowed, f'flamegraphs.py imports {name}')

  def test_not_loaded_by_import_qaboard_or_the_cli(self):
    self.assertNotIn('qaboard.flamegraphs', loaded_by_the_cli())
