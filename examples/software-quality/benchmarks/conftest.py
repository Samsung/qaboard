"""
The SDK's micro-benchmarks, with pytest-benchmark: `pytest benchmarks/ --benchmark-json=pytest.benchmarks.json`.
Not part of the test suites that `qa batch ci` runs (pytest.ini's testpaths is tests/).

Like the tests, they run the code of a story commit when build/flags.json exists. The flags are read once here: the
SDK reads the file on each call, which would be all the benchmarks measure.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from fleet_sdk import _flags  # noqa: E402
from fleet_sdk.client import registry  # noqa: E402
from fleet_sdk.codec import varint  # noqa: E402

FLAGS = _flags.flags()
for module in (varint, registry):
    module.flags = lambda: FLAGS
