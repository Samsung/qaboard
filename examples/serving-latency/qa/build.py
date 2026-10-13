#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""
Builds gateway-bench (`cargo build --release` in gateway/), the first time and again when its sources change.
Every commit of the story uses the same binary: its flags (build/flags.json) select the behavior.

Then it sizes requests for this machine, once (`gateway-bench --calibrate`, see gateway/src/calibrate.rs): the load
levels are fixed numbers of requests/s, so the model's hidden layer and the responses are sized for the gateway to be
as loaded as on the reference machine. The result is kept in <target>/calibration.json; delete it to measure again.

  uv run qa/build.py          # what qa/main.py does before its first run

$GATEWAY_TARGET_DIR moves cargo's target directory (default: gateway/target).
"""
import fcntl
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CRATE = ROOT / 'gateway'


def target_dir() -> Path:
    return Path(os.environ.get('GATEWAY_TARGET_DIR', CRATE / 'target'))


def sources():
    yield CRATE / 'Cargo.toml'
    yield CRATE / 'Cargo.lock'
    yield CRATE / '.cargo' / 'config.toml'
    yield from (CRATE / 'src').rglob('*.rs')


def binary(quiet: bool = False) -> Path:
    """The path of gateway-bench, built if needed"""
    target = target_dir()
    path = target / 'release' / 'gateway-bench'
    newest = max(p.stat().st_mtime for p in sources() if p.exists())
    if path.exists() and path.stat().st_mtime >= newest:
        return path
    target.mkdir(parents=True, exist_ok=True)
    with open(target / '.build.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)   # one build at a time
        if path.exists() and path.stat().st_mtime >= newest:
            return path
        if not quiet:
            print('Building gateway-bench (cargo build --release)...', flush=True)
        command = ['cargo', 'build', '--release', '--locked', '--target-dir', str(target)]
        if os.environ.get('CARGO_BUILD_JOBS'):
            command += ['-j', os.environ['CARGO_BUILD_JOBS']]
        try:
            result = subprocess.run(command, cwd=CRATE, capture_output=True, text=True)
        except FileNotFoundError:
            raise SystemExit('ERROR: cargo not found. Install Rust: https://rustup.rs')
        if result.returncode != 0:
            print(result.stdout, result.stderr, file=sys.stderr)
            raise SystemExit(f'ERROR: could not build gateway-bench (cargo exited with {result.returncode})')
        path.touch()   # cargo doesn't relink when nothing changed
        (target / 'calibration.json').unlink(missing_ok=True)   # the code changed: measure again
    return path


def calibration(quiet: bool = False) -> dict:
    """{"hidden": .., "top_k": ..}: the size of requests on this machine, measured once"""
    path = target_dir() / 'calibration.json'
    gateway = binary(quiet)

    def fresh():
        return path.exists() and path.stat().st_mtime >= gateway.stat().st_mtime
    if fresh():
        return json.loads(path.read_text())
    with open(target_dir() / '.build.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not fresh():
            result = subprocess.run([str(gateway), '--calibrate'], capture_output=True, text=True, check=True)
            data = json.loads(result.stdout)
            path.write_text(json.dumps(data, indent=2) + '\n')
            if not quiet:
                m = data['measured']
                print(f"Sized requests for this machine: hidden layer {data['hidden']}, top {data['top_k']} outputs per token "
                      f"(the model took {m['model_us']:.0f} µs and rendering {m['render_us']:.0f} µs at {m['hidden']} and {m['top_k']})", flush=True)
    return json.loads(path.read_text())


if __name__ == '__main__':
    print(binary())
    print(json.dumps(calibration()))
