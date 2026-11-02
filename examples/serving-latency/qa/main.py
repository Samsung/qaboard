"""
QA-Board runs this file: `qa run --input profiles/steady-high.yaml` calls run(context).

It runs gateway-bench (the Rust crate in gateway/: Kitefin's inference gateway and an open-loop load generator in one
process) with the input's load profile, then turns what it measured into metrics, plots and a CPU flame graph.
- the code's flags come from build/flags.json (what a commit changed), tuning parameters override them,
- configurations set how long it measures: {repeats: 3, duration_s: 4} (default: 2 repeats of 1 s warmup + 3 s).
"""
import hashlib
import json
import os
import statistics
import subprocess
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402
import flame  # noqa: E402
import plots  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# The code's defaults: the head of `main` at T0. A commit's changes are in build/flags.json.
DEFAULT_FLAGS = {
    'workers': 3,                 # 1-3, the load generator keeps a core
    'batching': 'dynamic',        # or none
    'max_batch': 16,              # 1-64
    'max_delay_us': 250,          # 0-5000
    'queue_policy': 'edf',        # fifo, lifo, edf, drop-late
    'allocator': 'mimalloc',      # system, jemalloc
    'pin': 'workers',             # or none
    'model_dtype': 'int8',        # or fp32
    'cache': 'sharded',           # none, shared
    'cache_entries': 16384,
    'cache_shards': 16,
    'batch_buffer': 'reuse',      # or alloc
    'payload_copy': False,
    'bug_batch_overflow': False,
}
# How long each run measures, set by the batch's configurations
DEFAULT_SETTINGS = {'repeats': 2, 'warmup_s': 1, 'duration_s': 3}


def read_flags(params):
    flags = dict(DEFAULT_FLAGS)
    path = ROOT / 'build' / 'flags.json'
    if path.exists():
        flags.update({k: v for k, v in json.loads(path.read_text()).items() if v is not None})
    flags.update({k: v for k, v in params.items() if k in DEFAULT_FLAGS})   # tuning parameters
    return flags


def load_args(profile):
    arrivals, tokens, keys = profile['arrivals'], profile['tokens'], profile['keys']
    args = [f"rate={profile['rate']}", f"deadline_ms={profile['deadline_ms']}", f"zipf_s={keys['s']}", f"keys={keys['n']}"]
    process = arrivals['process']
    args.append(f'arrivals={process}')
    if process == 'bursty':
        args += [f"burst_factor={arrivals['factor']}", f"burst_ms={arrivals['burst_ms']}", f"burst_every_ms={arrivals['every_ms']}"]
    elif process == 'ramp':
        args += [f"ramp_from={arrivals['from']}", f"ramp_to={arrivals['to']}", f"ramp_steps={arrivals['steps']}", f"ramp_step_ms={arrivals['step_ms']}"]
    if tokens['distribution'] == 'pareto':
        args += ['tokens=pareto', f"tokens_alpha={tokens['alpha']}", f"tokens_min={tokens['min']}", f"tokens_max={tokens['max']}"]
    else:
        args += ['tokens=fixed', f"tokens_n={tokens['n']}"]
    return args


def gateway_args(flags):
    def value(v):
        return str(v).lower() if isinstance(v, bool) else str(v)
    return [f'{k}={value(v)}' for k, v in flags.items() if k != 'allocator']


def run(context):
    flags = read_flags(context.params)
    settings = {**DEFAULT_SETTINGS, **{k: v for k, v in context.params.items() if k in DEFAULT_SETTINGS}}
    profile = yaml.safe_load(context.input_path.read_text())
    # the load depends on the input and $QA_SEED, never on the commit: commits are compared on the same requests
    seed = int(hashlib.sha256(f"{os.environ.get('QA_SEED', 0)}:{context.rel_input_path.as_posix()}".encode()).hexdigest()[:12], 16)
    output_dir = context.output_dir
    size = build.calibration()
    command = [
        str(build.binary()), '--out', str(output_dir), '--seed', str(seed),
        '--repeats', str(settings['repeats']), '--warmup', str(settings['warmup_s']), '--duration', str(settings['duration_s']),
        *gateway_args(flags), *load_args(profile), f"hidden={size['hidden']}", f"top_k={size['top_k']}",
    ]
    env = {**os.environ, 'GATEWAY_ALLOCATOR': flags['allocator'], 'RUST_BACKTRACE': '1'}
    print(f"$ GATEWAY_ALLOCATOR={flags['allocator']} gateway-bench {' '.join(command[3:])}", flush=True)
    process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
    for line in process.stdout:
        print(line, end='', flush=True)
    if process.wait() != 0:
        print(f'gateway-bench exited with {process.returncode}', flush=True)
        return {'is_failed': True}

    bench = json.loads((output_dir / 'bench.json').read_text())
    metrics = summarize(bench)
    repeats = bench['repeats']
    median = repeats[int(bench['median_repeat'])]
    name = context.rel_input_path.stem
    slo = profile['deadline_ms']
    plots.latency_cdf(output_dir / 'latency_cdf.plotly.json', bench['cdf'], slo,
                      f"{name}: p50 {metrics['latency_p50']:.2f} ms, p99 {metrics['latency_p99']:.2f} ms, p99.9 {metrics['latency_p999']:.2f} ms")
    rows = [{k: statistics.mean(r['breakdown'][i][k] for r in repeats) for k in repeats[0]['breakdown'][i]} for i in range(len(repeats[0]['breakdown']))]
    plots.breakdown(output_dir / 'breakdown.plotly.json', rows)
    plots.timeline(output_dir / 'timeline.plotly.json', median['timeline'], f'{name}: latency and queue depth over time')
    if profile['arrivals']['process'] == 'ramp':
        steps = [{k: statistics.median(r['steps'][i][k] for r in repeats) for k in ('offered', 'throughput', 'p50_ms', 'p99_ms')}
                 for i in range(len(median['steps']))]
        plots.throughput_vs_p99(output_dir / 'sweep.plotly.json', steps, slo)
    plots.cores(output_dir / 'cores.plotly.json', median['cores'])
    plots.batch_sizes(output_dir / 'batch_sizes.plotly.json', bench['batch_sizes'])
    plots.latency_histogram(output_dir / 'latency_hist.plotly.json', bench['histogram'])
    flame.write(output_dir / 'cpu.folded', output_dir / 'cpu.flame.json', bench['profiled_cpu_s'], bench['profiled_requests'])
    print(' | '.join(f'{k} {v:.4g}' for k, v in metrics.items() if k != 'is_failed'), flush=True)
    return metrics


def summarize(bench):
    """Medians over the repeats"""
    repeats = bench['repeats']

    def median(f):
        return statistics.median(f(r) for r in repeats)
    p99s = [r['percentiles_ms']['99'] for r in repeats]
    return {
        'latency_p50': median(lambda r: r['percentiles_ms']['50']),
        'latency_p90': median(lambda r: r['percentiles_ms']['90']),
        'latency_p99': statistics.median(p99s),
        'latency_p999': median(lambda r: r['percentiles_ms']['99.9']),
        'latency_max': max(r['percentiles_ms']['max'] for r in repeats),
        'throughput': median(lambda r: r['throughput']),
        'goodput': median(lambda r: r['goodput']),
        'slo_miss': median(lambda r: r['slo_miss']),
        'dropped': median(lambda r: r['dropped_share']),
        'p99_spread': (max(p99s) - min(p99s)) / statistics.median(p99s) if len(p99s) > 1 and statistics.median(p99s) else 0.0,
        'cpu_per_req': median(lambda r: r['cpu_per_req_us']),
        'lock_wait_p99': median(lambda r: r['lock_wait_p99_ms']),
        'cache_hit': median(lambda r: r['cache_hit']),
        'batch_mean': median(lambda r: r['batch_mean']),
        'is_failed': False,
    }
