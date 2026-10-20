"""
What a commit of the demo story changes in the SDK and its tests (see ../SPEC.md). The story's seeder writes them
to build/flags.json before each commit's runs; without the file, the defaults are the head of `main`.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEFAULT_FLAGS = {
    # SDK code
    'bug_varint_fast_path': False,      # true: the varint fast path drops the high bits of values from 2^32 to 2^35
    'client_legacy_parse': False,       # true: the client decodes frames with the deprecated codec.parse()
    'bug_missions_reserve': False,      # true: missions pick the closest robot, even under its battery reserve
    # tests
    'tests': {},                        # test module (codec/test_frames) -> false: not written yet, or deleted
    'skip_tests': [],                   # test ids marked @skip
    'fuzz_cases': 200,                  # random round trips per codec fuzz test
    'isolate_registry': True,           # false: tests share the handler registry, one depends on the order
}


def flags() -> dict:
    values = dict(DEFAULT_FLAGS)
    path = ROOT / 'build' / 'flags.json'
    if path.exists():
        values.update({k: v for k, v in json.loads(path.read_text()).items() if v is not None and k in DEFAULT_FLAGS})
    return values
