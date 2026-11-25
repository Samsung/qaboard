#!/usr/bin/env python3
"""
Runs the Python tests (tests/) in a random order, in one process, to find tests that depend on each other,
and checks that they leave nothing in the checkout. Optionally under CPU load, to find timing-dependent tests.

It runs in the project's environment (it imports qaboard's tests), so it has no inline `# /// script` metadata:
  uv run python .github/scripts/shuffled_tests.py                      # shuffles the test cases, a random seed
  uv run python .github/scripts/shuffled_tests.py --seed 3 --repeat 3  # seeds 3, 4, 5
  uv run python .github/scripts/shuffled_tests.py --shuffle modules    # keeps each module's order
  uv run python .github/scripts/shuffled_tests.py --load 8             # with 8 busy processes alongside
  uv run python .github/scripts/shuffled_tests.py tests.test_cli tests.test_config   # some modules
A failure prints the seed: run again with it to get the same order. Don't edit the checkout while it runs: it would
report your changes as files the tests left.

--shuffle tests moves single tests across classes and modules: unittest then runs a class's setUpClass/tearDownClass
each time the class changes, so it also checks that classes can be set up again.
"""
import argparse
import multiprocessing
import os
import random
import subprocess
import sys
import time
import unittest
from pathlib import Path

root = Path(__file__).resolve().parents[2]


def flatten(suite):
  for test in suite:
    if isinstance(test, unittest.TestSuite):
      yield from flatten(test)
    else:
      yield test


def ordered(tests, shuffle, rng):
  """Groups by module (or class), shuffles the groups and what's in them"""
  if shuffle == 'tests':
    tests = list(tests)
    rng.shuffle(tests)
    return tests
  key = (lambda t: type(t).__module__) if shuffle == 'modules' else (lambda t: f'{type(t).__module__}.{type(t).__qualname__}')
  groups = {}
  for test in tests:
    groups.setdefault(key(test), []).append(test)
  names = list(groups)
  rng.shuffle(names)
  if shuffle == 'classes':
    for name in names:
      rng.shuffle(groups[name])
  return [test for name in names for test in groups[name]]


def checkout_files():
  """What git sees in the checkout, ignored files included (bytecode and the virtualenv aside)"""
  out = subprocess.run(['git', 'status', '--porcelain', '--ignored', '--untracked-files=all'], cwd=root, capture_output=True, text=True, check=True).stdout
  return {line for line in out.splitlines() if '__pycache__' not in line and not line[3:].startswith(('.venv/', 'node_modules/', 'webapp/', 'website/'))}


def busy(stop):
  while not stop.is_set():
    sum(i * i for i in range(10_000))


def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('modules', nargs='*', help='test modules (tests.test_cli...), default: all of tests/')
  parser.add_argument('--seed', type=int, help='default: random')
  parser.add_argument('--repeat', type=int, default=1, help='runs, with the seeds that follow')
  parser.add_argument('--shuffle', choices=['tests', 'classes', 'modules'], default='tests')
  parser.add_argument('--load', type=int, default=0, help='busy processes to run alongside')
  parser.add_argument('--failfast', action='store_true')
  parser.add_argument('-v', '--verbose', action='store_true')
  args = parser.parse_args()

  os.chdir(root)
  sys.path.insert(0, str(root))
  seed = args.seed if args.seed is not None else random.randrange(100_000)
  before = checkout_files()
  stop = multiprocessing.Event()
  load = [multiprocessing.Process(target=busy, args=(stop,), daemon=True) for _ in range(args.load)]
  for process in load:
    process.start()
  failed = []
  try:
    for run in range(args.repeat):
      run_seed = seed + run
      loader = unittest.TestLoader()
      suite = loader.loadTestsFromNames(args.modules) if args.modules else loader.discover('tests', top_level_dir=str(root))
      tests = ordered(flatten(suite), args.shuffle, random.Random(run_seed))
      print(f'--- seed {run_seed}: {len(tests)} tests, --shuffle {args.shuffle}, --load {args.load}', flush=True)
      environ = dict(os.environ)
      start = time.monotonic()
      result = unittest.TextTestRunner(verbosity=2 if args.verbose else 1, failfast=args.failfast, buffer=True).run(unittest.TestSuite(tests))
      os.chdir(root)  # in case a test chdir'ed without restoring it
      print(f'--- seed {run_seed}: {time.monotonic() - start:.0f}s', flush=True)
      if not result.wasSuccessful():
        failed.append(run_seed)
        for test, _ in [*result.failures, *result.errors]:
          print(f'FAILED (seed {run_seed}): {test.id()}')
      changed = sorted(k for k in {*environ, *os.environ} if environ.get(k) != os.environ.get(k))
      if changed:
        print(f'The tests changed environment variables that later tests see (seed {run_seed}): {", ".join(changed)}')
      left = sorted(checkout_files() - before)
      if left:
        failed.append(run_seed)
        print(f'The tests left files in the checkout (seed {run_seed}), use a temporary directory:', *left, sep='\n  ')
        before |= set(left)
  finally:
    stop.set()
  if failed:
    print(f'Failed with the seeds: {sorted(set(failed))}')
  return 1 if failed else 0


if __name__ == '__main__':
  sys.exit(main())
