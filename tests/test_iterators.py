"""
TODO: Write more tests.
https://docs.python.org/3/library/unittest.html
"""
import unittest
from pathlib import Path
import yaml

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
    self.assertEqual(batches[0].configurations, ['base-1'])
    self.assertEqual(batches[1].configurations, ['base-2'])
    self.assertEqual(batches[2].configurations, ['base-1', 'delta'])
    self.assertEqual(batches[3].configurations, ['base-2', 'delta'])

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

"""
sample_batches_yaml = sample_batches_yaml.replace("qaboard/sample_project", str(root_dir / Path("qaboard/sample_project")))


if __name__ == '__main__':
  unittest.main()
