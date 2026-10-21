"""
Shared by all the suites. What the demo story changes in the tests comes from build/flags.json (fleet_sdk/_flags.py):
which test modules exist at a commit, which tests are skipped, how many fuzz cases run, and whether each test gets a
clean handler registry.
"""
import os
import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fleet_sdk._flags import flags  # noqa: E402

FLAGS = flags()

# test modules not written yet at this commit, or deleted: tests/<suite>/<module>.py
collect_ignore = [f"{module}.py" for module, present in FLAGS['tests'].items() if present is False]


def pytest_collection_modifyitems(config, items):
    skipped = set(FLAGS['skip_tests'])
    for item in items:
        rel = item.nodeid.split('tests/', 1)[-1]
        if rel in skipped or rel.split('[')[0] in skipped:
            item.add_marker(pytest.mark.skip(reason="flaky on CI, see later"))


@pytest.fixture
def rng(request):
    """Random numbers seeded from the test's name and $QA_SEED: the same cases on every run"""
    return random.Random(f"{os.environ.get('QA_SEED', '0')}:{request.node.nodeid}")


@pytest.fixture(autouse=True)
def clean_registry():
    if FLAGS['isolate_registry']:
        from fleet_sdk.client import default_registry
        default_registry.clear()
    yield


def pytest_generate_tests(metafunc):
    if 'fuzz_case' in metafunc.fixturenames:
        metafunc.parametrize('fuzz_case', range(int(FLAGS['fuzz_cases'])))
