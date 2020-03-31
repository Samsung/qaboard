"""
TODO: Write more tests.
https://docs.python.org/3/library/unittest.html
"""
import unittest
from pathlib import Path
import yaml

# TODO: test support for inputs types

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
      database = Path(__file__).parent.parent.resolve() / Path("qaboard/sample_project/cli_tests")
      return list(iter_inputs(
        [batch],
        [Path('iter.batches.yaml')],
        database=database,
        default_configurations=[],
        default_platform='linux',
        default_job_configuration={"type": "local"},
        qatools_config={
          "project": {"entrypoint": Path("qaboard/sample_project/qa/main.py")},
          "inputs": {
            "globs": '*.txt',
            "database": Path("qaboard/sample_project/cli_tests"),
          }
        },
        inputs_settings=None,
        # debug=True,
      ))

    batches = get_batch('my-batch')
    assert len(batches) == 2
    assert batches[0].configurations == []

    batches = get_batch('you-can-override-the-default-database')
    assert len(batches) == 3

    batches = get_batch('you-can-override-runner-config')
    assert batches[0].job_options['param'] == 'value'

    batches = get_batch('using-a-custom-configuration')
    assert batches[0].configurations == ['base']

    batches = get_batch('multiple-configurations')
    assert batches[0].configurations == ['base', 'low-light']

    batches = get_batch('configurations-can-be-complex-objects')
    assert batches[0].configurations == ['base', 'low-light', {"cde": ["-w 9920", "-h 2448", "-it BAYER10"]}]

    batches = get_batch('each-input-can-have-its-own-configuration')
    assert batches[0].configurations == ['base']
    assert batches[1].configurations == ['base', 'low-light', {"cde": ["-DD"]}]

    batches = get_batch('my-alias')
    assert len(batches) == 2

    batches = get_batch('you-can-override-globs')
    assert len(batches) == 1

    # batches-can-be-paths
    batches = get_batch('../cli_tests/dir')
    print([b.input_path for b in batches])
    assert len(batches) == 1




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
#=> configurations == ["base", "low-light"]

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
# configurations == ["base", "low-light", {"cde": ["-w 9920", "-h 2448", "-it BAYER10"]}]


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


aliases:
  my-alias:
  - my-batch
"""

if __name__ == '__main__':
  unittest.main()
