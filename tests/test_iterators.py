"""
TODO: Write more tests.
https://docs.python.org/3/library/unittest.html
"""
import unittest
from pathlib import Path

# TODO: test support for inputs types


root_dir = Path(__file__).parent.parent.resolve()

class TestIterators(unittest.TestCase):
  def test_flatten(self):
    from qaboard.iterators import flatten
    self.assertEqual(list(flatten([])), [])
    self.assertEqual(list(flatten([1])), [1])
    self.assertEqual(list(flatten([1, [2]])), [1, 2])
    self.assertEqual(list(flatten([1, [2], [3, 4, [5], [6, [7]]] ])), [1, 2, 3, 4, 5, 6, 7])
    self.assertEqual(list(flatten([1, {"cde": [2, 3]} ])), [1, {"cde": [2, 3]}])

  def test_resolve_aliases(self):
    from qaboard.iterators import resolve_aliases
    self.assertEqual(
        list(resolve_aliases(["a", "b"], {"c": ["d", "e"], "f": ["g", "h"]})),
        ['a', 'b']
    )
    self.assertEqual(
        list(resolve_aliases(["ci", "xxxxx"], {"ci": ["a", "b"], "b": ["e", "f"]})),
        ['a', 'e', 'f', 'xxxxx']
    )
    self.assertEqual(
        list(resolve_aliases(["branch-specific"],  {'chain': ['remosaic', 'hdr3', 'hdr-2'], 'branch-specific': ['small-group']})),
        ['small-group']
    )
    self.assertEqual(
        list(resolve_aliases(["self-referential"],  {'chain': ['self-referential']})),
        ['self-referential']
    )

  def test_interpolation(self):
    from qaboard.iterators import deep_interpolate
    self.assertEqual(
      deep_interpolate("hello ${alice}", "alice", "bob"),
      "hello bob"
    )
    self.assertEqual(
      deep_interpolate("hello ${alice}", "bob", "charly"),
      "hello ${alice}"
    )
    self.assertEqual(
      deep_interpolate("hello {alice}", "alice", "bob"),
      "hello {alice}"
    )
    self.assertEqual(
      deep_interpolate("tuple ${tuple}", "tuple", (0, 1)),
      "tuple (0, 1)"
    )
    self.assertEqual(
      deep_interpolate("tuple ${tuple[0]}", "tuple", (0, 1)),
      "tuple 0"
    )
    self.assertEqual(
      deep_interpolate("string ${string[0]}", "string", "abcdef"),
      "string a"
    )
    self.assertEqual(
      deep_interpolate("object ${object[test]}", "object", {"test": "abcdef"}),
      "object abcdef"
    )
    self.assertEqual(
      deep_interpolate("object ${object[a]} ${object[c]}", "object", {"a": "b", "c": "d"}),
      "object b d"
    )
    self.assertEqual(
      deep_interpolate("object ${matrix[test]}", "matrix", {"test": "abcdef"}),
      "object abcdef"
    )
    self.assertEqual(
      deep_interpolate("object ${matrix.test}", "matrix", {"test": "abcdef"}),
      "object abcdef"
    )

  def test_match(self):
    from qaboard.iterators import match
    metadata = {"Sensor": "HM4"}
    # exact match
    self.assertEqual(match(metadata, {"Sensor": "HM4"}), True)
    self.assertEqual(match(metadata, {"Sensor": "HM2"}), False)
    # array of options
    self.assertEqual(match(metadata, {"Sensor": ["HM2", "HM4"]}), True)
    # wildcards
    self.assertEqual(match(metadata, {"Sensor": "HM*"}), True)
    # case insensitive
    self.assertEqual(match(metadata, {"Sensor": "hm4"}), True)
    # multiple filters
    self.assertEqual(match(metadata, {"Sensor": "HM4", "Binning": "4"}), False)
    metadata = {"Sensor": "HM4", "Binning": "4"}
    self.assertEqual(match(metadata, {"Sensor": "HM4", "Binning": "4"}), True)
    # booleans
    metadata = {"Binning": False}
    self.assertEqual(match(metadata, {"Binning": False}), True)
    # numbers
    metadata = {"Distance": 5}
    self.assertEqual(match(metadata, {"Distance": 3}), False)
    self.assertEqual(match(metadata, {"Distance": 5}), True)
    self.assertEqual(match(metadata, {"Distance": ">=5"}), True)
    # exclude 
    metadata = {"_filter": 'tv_HP7_A40_8SUM_12M_DCG_DSG_RSS'}
    self.assertEqual(match(metadata, {"_filter": '*8SUM*'}), True)
    self.assertEqual(match(metadata, {"_filter": "hello"}), False)
    self.assertEqual(match(metadata, {"Distance": "*hello*"}), False) 
    # only 
    metadata = {"_changed": True}
    self.assertEqual(match(metadata, {"_changed": True}), True)
    self.assertEqual(match(metadata, {"_changed": False}), False)
    



  def test_iter_inputs(self):
    from qaboard.iterators import iter_inputs
    with Path('iter.batches.yaml').open('w') as f:
      f.write(sample_batches_yaml)
    def get_batch(batch):
      database = root_dir / Path("qaboard/sample_project/cli_tests")
      return list(iter_inputs(
        [batch],
        [Path('iter.batches.yaml')],
        default_database=database,
        default_configurations=[],
        default_platform='linux',
        default_job_configuration={"type": "local"},
        qatools_config={
          "project": {"entrypoint": root_dir / "qaboard/sample_project/qa/main.py"},
          "inputs": {
            "globs": '*.txt',
            "database": {"linux": database, "windows": database},
          }
        },
        default_inputs_settings=None,
        # debug=True,
      ))

    batches = get_batch('my-batch')
    self.assertEqual(len(batches), 2)
    self.assertEqual(batches[0].configurations, [])

    batches = get_batch('you-can-override-the-default-database')
    self.assertEqual(len(batches), 3)

    batches = get_batch('you-can-override-runner-config')
    self.assertEqual(batches[0].job_options['param'], 'value')

    batches = get_batch('using-a-custom-configuration')
    self.assertEqual(batches[0].configurations, ['base'])

    batches = get_batch('multiple-configurations')
    self.assertEqual(batches[0].configurations, ['base', 'low-light'])

    batches = get_batch('configurations-can-be-complex-objects')
    self.assertEqual(batches[0].configurations, ['base', 'low-light', {"cde": ["-w 9920", "-h 2448", "-it BAYER10"]}])

    batches = get_batch('each-input-can-have-its-own-configuration')
    self.assertEqual(batches[0].configurations, ['base'])
    self.assertEqual(batches[1].configurations, ['base', 'low-light', {"cde": ["-DD"]}])

    batches = get_batch('each-input-can-have-its-own-configuration-and-appear-twice')
    self.assertEqual(batches[0].configurations, ['base', {"crop": "A"}])
    self.assertEqual(batches[1].configurations, ['base', {"crop": "B"}])
    self.assertEqual(batches[2].configurations, ['base', {"crop": "C"}])

    batches = get_batch('you-can-override-globs')
    self.assertEqual(len(batches), 1)

    batches = get_batch('my-alias')
    self.assertEqual(len(batches), 3)

    # wildcard support
    batches = get_batch('my-*')
    self.assertEqual(len(batches), 2)

    batches = get_batch('expand-lists-to-work-well-with-aliases')
    self.assertEqual(batches[0].configurations, ['base', 'delta1', 'delta2'])

    # batches-can-be-paths
    batches = get_batch('../cli_tests/dir')
    self.assertEqual(len(batches), 1)

    # matrices
    batches = get_batch('matrix-configurations')
    self.assertEqual(len(batches), 2)
    self.assertEqual(batches[0].configurations, ['base'])
    self.assertEqual(batches[1].configurations, ['base', 'delta'])

    batches = get_batch('matrix-configurations-and-per-input')
    self.assertEqual(len(batches), 1)
    self.assertEqual(batches[0].configurations, ['base', 'calibration'])

    batches = get_batch('matrix-configurations-and-per-input-with-base')
    self.assertEqual(len(batches), 2)
    self.assertEqual(batches[0].configurations, ['basebase', 'base'])
    self.assertEqual(batches[1].configurations, ['basebase', 'base', 'delta'])

    batches = get_batch('matrix-many')
    self.assertEqual(len(batches), 8)

    batches = get_batch('matrix-interpolation')
    self.assertEqual(len(batches), 4)
    configs = [b.configurations for b in batches]
    self.assertIn(['base-1'], configs)
    self.assertIn(['base-2'], configs)
    self.assertIn(['base-1', 'delta'], configs)
    self.assertIn(['base-2', 'delta'], configs)

    batches = get_batch('matrix-keep-type')
    self.assertEqual(len(batches), 2)
    self.assertEqual(batches[0].configurations, ['base', {"param": 1}])
    self.assertEqual(batches[1].configurations, ['base', {"param": 2}])
    batches = get_batch('matrix-interpolate')
    self.assertEqual(len(batches), 2)
    self.assertEqual(batches[0].configurations, ['base', 'config-v1', {"version": "v1"}])
    self.assertEqual(batches[1].configurations, ['base', 'config-v2', {"version": "v2"}])
    batches = get_batch('matrix-interpolate-2')
    self.assertEqual(len(batches), 4)

  def test_globbed_inputs_are_sorted(self):
    """Batches list their runs in the same order on every machine, whatever order the filesystem lists files in"""
    import tempfile
    from unittest import mock
    from qaboard.iterators import iter_inputs_at_path
    with tempfile.TemporaryDirectory() as tmp:
      database = Path(tmp)
      for name in ['charts/b.png', 'charts/a.png', 'charts/c/d.png', 'photos/z.png', 'photos/y.png']:
        (database / name).parent.mkdir(parents=True, exist_ok=True)
        (database / name).write_text('')
      # the filesystem lists them in reverse order
      glob, rglob = Path.glob, Path.rglob
      with mock.patch.object(Path, 'glob', lambda self, pattern, **kw: reversed(sorted(glob(self, pattern, **kw)))), \
           mock.patch.object(Path, 'rglob', lambda self, pattern, **kw: reversed(sorted(rglob(self, pattern, **kw)))):
        def inputs(path):
          found = iter_inputs_at_path(path, database, ['*.png'], False, {})
          return [i.relative_to(database).as_posix() for i, _ in found]
        self.assertEqual(inputs('charts'), ['charts/a.png', 'charts/b.png', 'charts/c/d.png'])
        self.assertEqual(inputs('*'), ['charts/a.png', 'charts/b.png', 'charts/c/d.png', 'photos/y.png', 'photos/z.png'])
        self.assertEqual(inputs('charts/*.png'), ['charts/a.png', 'charts/b.png'])

  def test_recording_missing_inputs(self):
    """The server can tell where the inputs it didn't find were looked for"""
    import tempfile
    from qaboard.iterators import iter_inputs_at_path, recording_missing_inputs
    with tempfile.TemporaryDirectory() as tmp:
      database = Path(tmp)
      (database / 'charts').mkdir()
      (database / 'charts' / 'a.png').write_text('')
      with recording_missing_inputs() as missing:
        self.assertEqual(len(list(iter_inputs_at_path('charts', database, ['*.png'], False, {}))), 1)
        list(iter_inputs_at_path('photos', database, ['*.png'], False, {}))
        list(iter_inputs_at_path('charts', database, ['*.jpg'], False, {}))
      self.assertEqual(missing, [
        {"input": "photos", "database": str(database)},
        {"input": "charts", "database": str(database), "globs": ["*.jpg"]},
      ])
      # nothing is recorded outside
      list(iter_inputs_at_path('photos', database, ['*.png'], False, {}))
      self.assertEqual(len(missing), 2)

  def test_metadata_gets_the_run_context(self):
    """metadata(context) gets the RunContext, and the old metadata(absolute_input_path, database, input_path) still works"""
    import tempfile
    from qaboard.iterators import iter_inputs
    from qaboard.utils import input_metadata
    from qaboard.run import RunContext
    with tempfile.TemporaryDirectory() as tmp:
      database = Path(tmp)
      for name in ['a.txt', 'b.txt']:
        (database / name).write_text('')
      batches_file = database / 'batches.yaml'
      batches_file.write_text('\n'.join([
        'my-batch:',
        '  configurations: [{gain: 2}]',
        '  inputs: ["*.txt"]',
        '  only: {gain: 2, name: a}',
      ]))
      (database / 'new.py').write_text('def metadata(context):\n  return {"gain": context.params.get("gain"), "name": context.input_path.stem, "batch": context.batch}\n')
      (database / 'old.py').write_text('def metadata(absolute_input_path, database, input_path):\n  return {"gain": 2, "name": input_path.stem, "database": str(database)}\n')
      for entrypoint in ['new.py', 'old.py']:
        config = {"project": {"entrypoint": str(database / entrypoint)}}
        runs = list(iter_inputs(['my-batch'], [batches_file], database, [], 'linux', {"type": "local"}, config, {"type": "default", "globs": "*.txt"}))
        self.assertEqual([run.rel_input_path.as_posix() for run in runs], ['a.txt'], entrypoint)

        context = RunContext(type='default', input_path=database / 'a.txt', database=database, platform='linux', configurations=[{"gain": 2}], batch='my-batch')
        expected = {"gain": 2, "name": "a", "input_path": str(database / 'a.txt'), "rel_input_path": "a.txt"}
        expected.update({"batch": "my-batch"} if entrypoint == 'new.py' else {"database": str(database)})
        self.assertEqual(input_metadata(context, config), expected)
        # callers of the old input_metadata(absolute_input_path, database, input_path, config)
        self.assertEqual(input_metadata(database / 'a.txt', database, Path('a.txt'), config)["name"], "a")

  def test_always_get_metadata(self):
    """QA_BATCH_ALWAYS_GET_METADATA calls metadata() for every input, even without only/exclude"""
    import os
    import tempfile
    from unittest import mock
    from qaboard.iterators import iter_inputs_at_path
    with tempfile.TemporaryDirectory() as tmp:
      database = Path(tmp)
      for name in ['a.txt', 'b.txt']:
        (database / name).write_text('')
      calls = database / 'calls.log'
      (database / 'side_effects.py').write_text(f'def metadata(context):\n  open({str(calls)!r}, "a").write(context.input_path.name + "\\n")\n')
      config = {"project": {"entrypoint": str(database / 'side_effects.py')}}
      with mock.patch.dict(os.environ):
        os.environ.pop('QA_BATCH_ALWAYS_GET_METADATA', None)
        self.assertEqual(len(list(iter_inputs_at_path('*.txt', database, ['*.txt'], False, config))), 2)
        self.assertFalse(calls.exists())
        os.environ['QA_BATCH_ALWAYS_GET_METADATA'] = '1'
        self.assertEqual(len(list(iter_inputs_at_path('*.txt', database, ['*.txt'], False, config))), 2)
        self.assertEqual(calls.read_text().split(), ['a.txt', 'b.txt'])

  def test_metadata_signatures(self):
    from qaboard.utils import _metadata_takes_context
    self.assertTrue(_metadata_takes_context(lambda context: None))
    self.assertTrue(_metadata_takes_context(lambda context, verbose=False: None))
    self.assertFalse(_metadata_takes_context(lambda absolute_input_path, database, input_path: None))
    self.assertFalse(_metadata_takes_context(lambda absolute_input_path, database, input_path=None: None))
    self.assertFalse(_metadata_takes_context(lambda *args: None))

  def test_batch_errors_say_where(self):
    """Batches qa can't use say which input is wrong, in which file and at which line"""
    import tempfile
    from qaboard.iterators import iter_inputs, BatchError
    with tempfile.TemporaryDirectory() as tmp:
      batches_file = Path(tmp) / 'batches.yaml'
      batches_file.write_text('\n'.join([
        'ok:',              # 1
        '  inputs: a',      # 2: a single input is fine
        'empty-item:',      # 3
        '  inputs:',        # 4
        '  - a',            # 5
        '  - b',            # 6
        '  -',              # 7
        'number:',          # 8
        '  inputs: [20260223]', # 9
        'listed: [a, b]',   # 10
        'not-a-list:',      # 11
        '  inputs: 3',      # 12
      ]))
      def batch(name):
        return list(iter_inputs([name], [batches_file], Path(tmp), [], 'linux', {"type": "local"}, {}))
      self.assertEqual(batch('ok'), [])  # no input "a" in the database
      with self.assertRaises(BatchError) as error:
        batch('empty-item')
      self.assertEqual(str(error.exception), f'{batches_file}:7: The batch "empty-item" has an empty input, after "b": a "-" with nothing after it. Remove the "-", or write the input after it.')
      # existing callers expect ValueErrors
      self.assertIsInstance(error.exception, ValueError)
      with self.assertRaises(BatchError) as error:
        batch('number')
      self.assertEqual(str(error.exception), f'{batches_file}:9: The batch "number" has an input that YAML reads as a number, not a path: 20260223 (the first one). Write it in quotes.')
      with self.assertRaises(BatchError) as error:
        batch('listed')
      self.assertTrue(str(error.exception).startswith(f'{batches_file}: The batch "listed" must be a mapping'))
      with self.assertRaises(BatchError) as error:
        batch('not-a-list')
      self.assertIn('must be a list of paths, not: 3', str(error.exception))
      # also with patterns
      with self.assertRaises(BatchError) as error:
        batch('empty-*')
      self.assertIn(':7: The batch "empty-item"', str(error.exception))

  def test_platforms_of_batches_and_inputs(self):
    """Batches and inputs with their own settings can set their platform"""
    import tempfile
    from qaboard.iterators import iter_inputs
    with tempfile.TemporaryDirectory() as tmp:
      database = Path(tmp)
      for name in ['a.txt', 'b.txt']:
        (database / name).write_text('')
      batches_file = database / 'batches.yaml'
      batches_file.write_text('\n'.join([
        'batch-platform:',
        '  platform: hw',
        '  inputs:',
        '  - a.txt: {local: {timeout: 10}}',
        '  - b.txt',
        'input-platform:',
        '  platform: hw',
        '  inputs:',
        '  - a.txt: {platform: sim, crop: A}',
        '  - b.txt',
      ]))
      def platforms(batch):
        runs = iter_inputs([batch], [batches_file], database, [], 'linux', {"type": "local"}, {"inputs": {"globs": "*.txt"}})
        return [(run.rel_input_path.as_posix(), run.platform, run.configurations) for run in runs]
      self.assertEqual(platforms('batch-platform'), [('a.txt', 'hw', []), ('b.txt', 'hw', [])])
      self.assertEqual(platforms('input-platform'), [('a.txt', 'sim', [{'crop': 'A'}]), ('b.txt', 'hw', [])])

  def test_runner_settings_of_inputs(self):
    """Inputs can have their own runner settings, but the command line options win"""
    import tempfile
    from qaboard.iterators import iter_inputs
    with tempfile.TemporaryDirectory() as tmp:
      database = Path(tmp)
      for name in ['a.txt', 'b.txt']:
        (database / name).write_text('')
      batches_file = database / 'batches.yaml'
      batches_file.write_text('\n'.join([
        'my-batch:',
        '  local: {concurrency: 2}',
        '  inputs:',
        '  - a.txt: {local: {concurrency: 1}}',
        '  - b.txt',
      ]))
      def concurrency(cli_runner_overrides=None):
        runs = iter_inputs(['my-batch'], [batches_file], database, [], 'linux', {"type": "local", "concurrency": 4}, {"inputs": {"globs": "*.txt"}}, cli_runner_overrides=cli_runner_overrides)
        return [run.job_options['concurrency'] for run in runs]
      self.assertEqual(concurrency(), [1, 2])
      self.assertEqual(concurrency({"type": "local"}), [1, 2])
      self.assertEqual(concurrency({"type": "local", "concurrency": 8}), [8, 8])
      # --runner=local uses the batch's local settings, even if the default runner is another one
      runs = iter_inputs(['my-batch'], [batches_file], database, [], 'linux', {"type": "lsf"}, {"inputs": {"globs": "*.txt"}}, cli_runner_overrides={"type": "local"})
      self.assertEqual([(run.job_options['type'], run.job_options.get('concurrency')) for run in runs], [('local', 1), ('local', 2)])

  def test_wildcards_match_batches_not_aliases(self):
    import tempfile
    from qaboard.iterators import iter_inputs
    with tempfile.TemporaryDirectory() as tmp:
      database = Path(tmp)
      for name in ['a.txt', 'b.txt']:
        (database / name).write_text('')
      batches_file = database / 'batches.yaml'
      batches_file.write_text('\n'.join([
        'only-a:',
        '  inputs: [a.txt]',
        'aliases:',
        '  all: [only-a]',
      ]))
      runs = list(iter_inputs(['*'], [batches_file], database, [], 'linux', {"type": "local"}, {"inputs": {"globs": "*.txt"}}))
      self.assertEqual([(run.batch, run.rel_input_path.as_posix()) for run in runs], [('only-a', 'a.txt')])

  def test_input_type_runner_settings(self):
    """Test that input types can specify runner settings"""
    from qaboard.iterators import iter_inputs
    with Path('iter.batches.yaml').open('w') as f:
      f.write(sample_batches_yaml)
    
    database = root_dir / Path("qaboard/sample_project/cli_tests")
    
    # Test batch with explicit input type that has runner settings
    batches = list(iter_inputs(
      ['test-vector-batch'],
      [Path('iter.batches.yaml')],
      default_database=database,
      default_configurations=[],
      default_platform='linux',
      default_job_configuration={"type": "local"},
      qatools_config={
        "project": {"entrypoint": root_dir / "qaboard/sample_project/qa/main.py"},
        "inputs": {
          "types": {
            "test-vector": {
              "globs": "*.txt",
              "database": {"linux": database, "windows": database},
              "runners": {
                "default": "local",
                "lsf": {
                  "queue": "test_queue"
                }
              }
            }
          },
          "globs": '*.txt',
          "database": {"linux": database, "windows": database},
        }
      },
      default_inputs_settings=None,
    ))
    
    self.assertEqual(len(batches), 1)
    # Should inherit runner settings from input type
    self.assertEqual(batches[0].job_options['type'], 'local')
    # LSF queue should not be applied since we're using local runner
    self.assertNotIn('queue', batches[0].job_options)

    # Test batch with LSF runner specified that gets config from input type
    batches = list(iter_inputs(
      ['test-vector-batch-lsf'],
      [Path('iter.batches.yaml')],
      default_database=database,
      default_configurations=[],
      default_platform='linux',
      default_job_configuration={"type": "local"},
      qatools_config={
        "project": {"entrypoint": root_dir / "qaboard/sample_project/qa/main.py"},
        "inputs": {
          "types": {
            "test-vector": {
              "globs": "*.txt",
              "database": {"linux": database, "windows": database},
              "runners": {
                "default": "local",
                "lsf": {
                  "queue": "test_queue"
                }
              }
            }
          },
          "globs": '*.txt',
          "database": {"linux": database, "windows": database},
        }
      },
      default_inputs_settings=None,
    ))
    
    self.assertEqual(len(batches), 1)
    # Should use LSF runner as specified in batch
    self.assertEqual(batches[0].job_options['type'], 'lsf')
    # Should get queue setting from input type configuration
    self.assertEqual(batches[0].job_options['queue'], 'test_queue')

  def test_cli_runner_overrides_precedence(self):
    """Test that CLI flags have highest precedence over input type and batch settings"""
    from qaboard.iterators import iter_inputs
    with Path('iter.batches.yaml').open('w') as f:
      f.write(sample_batches_yaml)
    
    database = root_dir / Path("qaboard/sample_project/cli_tests")
    
    # Test CLI overrides with input type that specifies different queue
    batches = list(iter_inputs(
      ['test-vector-batch-lsf'],
      [Path('iter.batches.yaml')],
      default_database=database,
      default_configurations=[],
      default_platform='linux',
      default_job_configuration={"type": "local"},  # base config
      qatools_config={
        "project": {"entrypoint": root_dir / "qaboard/sample_project/qa/main.py"},
        "inputs": {
          "types": {
            "test-vector": {
              "globs": "*.txt",
              "database": {"linux": database, "windows": database},
              "runners": {
                "default": "local",
                "lsf": {
                  "queue": "input_type_queue",  # input type setting
                  "priority": 5
                }
              }
            }
          },
          "globs": '*.txt',
          "database": {"linux": database, "windows": database},
        }
      },
      default_inputs_settings=None,
      cli_runner_overrides={  # CLI overrides should have highest priority
        "type": "lsf",
        "queue": "cli_queue",
        "max_memory": 8000
      }
    ))
    
    self.assertEqual(len(batches), 1)
    # Should use LSF runner from CLI override
    self.assertEqual(batches[0].job_options['type'], 'lsf')
    # CLI queue should override input type queue
    self.assertEqual(batches[0].job_options['queue'], 'cli_queue')
    # Should get priority from input type (not overridden by CLI)
    self.assertEqual(batches[0].job_options['priority'], 5)
    # Should get max_memory from CLI
    self.assertEqual(batches[0].job_options['max_memory'], 8000)


  def test_iter_parameters_defaults_to_a_grid(self):
    from qaboard.iterators import iter_parameters
    search = {'parameter_search': {'a': [1, 2], 'b': ['x']}}
    expected = [({'a': 1, 'b': 'x'}, '{"a": 1, "b": "x"}'), ({'a': 2, 'b': 'x'}, '{"a": 2, "b": "x"}')]
    self.assertEqual([p[:2] for p in iter_parameters(search)], expected)
    self.assertEqual([p[:2] for p in iter_parameters({**search, 'search_type': 'grid'})], expected)
    with self.assertRaises(ValueError):
      list(iter_parameters({**search, 'search_type': 'random'}))


class TestRunsFile(unittest.TestCase):
  defaults = {"type": "dask", "command_id": "new", "batch_dir": "/new/batch", "concurrency": 10, "lsf": {"queue": "q"}}

  def test_rerun_job_options(self):
    from qaboard.iterators import rerun_job_options
    started_with = {"type": "dask", "command_id": "old", "batch_dir": "/old/batch", "concurrency": 3, "cluster": {"cores": 4}}
    self.assertEqual(rerun_job_options(started_with, self.defaults), {
      # how the runs were started...
      "type": "dask", "concurrency": 3, "cluster": {"cores": 4},
      # ...but not for which command or where
      "command_id": "new", "batch_dir": "/new/batch",
      # and the defaults for the rest
      "lsf": {"queue": "q"},
    })
    # the options we were explicitly given win
    self.assertEqual(rerun_job_options(started_with, self.defaults, {"concurrency": 5})['concurrency'], 5)
    # runs that QA-Board didn't save options for use the defaults
    self.assertEqual(rerun_job_options(None, self.defaults), self.defaults)
    # options from another runner are not used
    lsf_defaults = {"type": "lsf", "command_id": "new", "concurrency": 0}
    self.assertEqual(rerun_job_options(started_with, lsf_defaults, {"type": "lsf"}), {"type": "lsf", "command_id": "new", "concurrency": 0})

  def test_iter_runs(self):
    from qaboard.iterators import iter_runs
    runs = [
      {"input_path": "a/b.jpg", "database": "/database/../data", "type": "image", "platform": "windows", "configurations": ["base", {"x": 1}],
       "extra_parameters": {"p": 1}, "batch": "my-batch", "job_options": {"type": "dask", "concurrency": 3}},
      {"input_path": "c.jpg", "database": "relative"},
    ]
    first, second = list(iter_runs(runs, default_type="default", default_platform="linux", default_job_options=self.defaults))
    self.assertEqual(first.input_path, Path("/data/a/b.jpg"))
    self.assertEqual(first.database, Path("/data"))
    self.assertEqual(first.rel_input_path, Path("a/b.jpg"))
    self.assertEqual((first.type, first.platform, first.batch), ("image", "windows", "my-batch"))
    self.assertEqual(first.configurations, ["base", {"x": 1}])
    self.assertEqual(first.extra_parameters, {"p": 1})
    self.assertEqual(first.job_options['concurrency'], 3)
    self.assertEqual(second.rel_input_path, Path("c.jpg"))
    self.assertEqual((second.type, second.platform, second.configurations, second.extra_parameters), ("default", "linux", [], {}))
    self.assertEqual(second.job_options, self.defaults)

  def test_load_runs_file(self):
    import json
    import click
    import tempfile
    from qaboard.iterators import load_runs_file
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'runs.json'
      runs = [{"input_path": "a.jpg", "database": "/data"}]
      path.write_text(json.dumps({"runs": runs}))
      self.assertEqual(load_runs_file(path), runs)
      for invalid in ['not json', '[]', '{"runs": [{"input_path": "a.jpg"}]}', '{"runs": [{"input_path": "a.jpg", "database": "/", "job_options": "lsf"}]}']:
        path.write_text(invalid)
        with self.assertRaises(click.UsageError):
          load_runs_file(path)
      with self.assertRaises(click.UsageError):
        load_runs_file(Path(tmp) / 'missing.json')



sample_batches_yaml = """
my-batch:
 inputs:
   - a.txt
   - b.txt

you-can-override-the-default-database:
  database:
    linux: qaboard/sample_project
    windows: qaboard/sample_project
  inputs:
  - cli_tests

you-can-override-runner-config:
  local:
    param: value
  inputs:
   - a.txt

you-can-override-globs:
  globs: a.txt
  inputs:
   - a.txt
   - b.txt

using-a-custom-configuration:
  configurations:
  - base
  inputs:
  - a.txt

multiple-configurations:
  configurations:
    - base
    - low-light
  inputs:
  - a.txt

configurations-can-be-complex-objects:
  configurations:
    - base
    - low-light
    - cde:
      - "-w 9920"
      - "-h 2448"
      - "-it BAYER10"
  inputs:
  - a.txt

each-input-can-have-its-own-configuration:
  configurations:
    - base
  inputs:
  - a.txt:
    #=> configurations == ["base"]
  - b.txt:
      - low-light
      - cde:
        - "-DD"
    #=> configurations == ["base", "low-light", {"cde": ["-DD"]}]

each-input-can-have-its-own-configuration-and-appear-twice:
  configurations:
    - base
  inputs:
  - a.txt: {crop: A}
    #=> configurations == ["base", {"crop": ["A"]}]
  - a.txt: {crop: B}
    #=> configurations == ["base", {"crop": ["B"]}]
  - [a.txt, {crop: C}]
    #=> configurations == ["base", {"crop": ["C"]}]


expand-lists-to-work-well-with-aliases:
  configurations:
    - base
    - [delta1, delta2]
  inputs:
  - a.txt:

aliases:
  my-alias:
  - my-batch
  - using-a-custom-configuration

matrix-configurations:
  inputs:
  - a.txt
  matrix:
    configurations:
      -
          - base
      -
          - base
          - delta

matrix-configurations-and-per-input:
  inputs:
    a.txt: calibration
  matrix:
    configurations: [[base]]

matrix-configurations-and-per-input-with-base:
  configs:
  - basebase
  inputs:
  - a.txt
  matrix:
    configurations:
    - 
        - base
    -
         - base
         - delta


matrix-many:
  inputs:
  - a.txt
  matrix:
    platform: [linux, windows]
    parameter: [1, 2]
    configurations: [[base], [base, delta]]

matrix-interpolation:
  inputs:
  - a.txt
  matrix:
    x: [1, 2]
    configurations: [["base-${matrix.x}"], ["base-${matrix.x}", delta]]


matrix-keep-type:
  inputs:
  - a.txt
  matrix:
    param: [1, 2]
  configurations:
    - base
    - param: ${matrix.param}

matrix-interpolate:
  inputs:
  - a.txt
  matrix:
    version: [1, 2]
  configurations:
    - base
    - config-v${matrix.version}
    - version: v${matrix.version}

matrix-interpolate-2:
  inputs:
  - a.txt
  matrix:
    version:
    - {major: 1}
    - {major: 2}
    param: [3, 4]
  configurations:
    - base
    - param-v${matrix.param}
    - version: v${matrix.version[major]}

test-vector-batch:
  type: test-vector
  inputs:
  - a.txt

test-vector-batch-lsf:
  type: test-vector
  runner: lsf
  inputs:
  - a.txt

"""
sample_batches_yaml = sample_batches_yaml.replace("qaboard/sample_project", str(root_dir / Path("qaboard/sample_project")))


if __name__ == '__main__':
  unittest.main()
