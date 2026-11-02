"""
QA-Board runs this file: `qa run --input sequences/figure8-fast` calls run(context).

A run is one sequence (inputs/sequences/<name>/): the K3 drives through a simulated warehouse, its depth camera and
IMU are simulated from the ground truth, and the odometry (qa/odometry.py, qa/loop_closure.py) estimates its
trajectory. The run saves the trajectories, a video of the depth camera with the path so far, the error over time, the
map it built, and the metrics (qa/metrics.yaml).
- the code's flags come from build/flags.json (what a commit changed), tuning parameters override them.
- a run is memoized by everything it depends on (the code, the flags, the sequence, the seed): a commit that doesn't
  change them reuses the identical, already computed run, time per frame included.
"""
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evaluate  # noqa: E402
import geometry as G  # noqa: E402
import outputs  # noqa: E402
import sensors  # noqa: E402
import slam  # noqa: E402
from make_sequences import ensure_sequences  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
INPUTS = ROOT / 'inputs'
CACHE = Path(os.environ.get('SLAM_CACHE_DIR', ROOT / '.cache' / 'runs'))

# The code's defaults: the head of `main` at T0. A commit's changes are in build/flags.json.
DEFAULT_FLAGS = {
    'voxel_size': 0.05,            # m, the frames' downsampling before ICP
    'icp_iterations': 15,          # 5-50
    'keyframe_dist': 0.6,          # m traveled before a new keyframe...
    'keyframe_angle': 10,          # ...or degrees turned
    'imu_weight': 0.6,             # 0-1: how much the IMU's prediction counts against ICP
    'loop_closure': True,
    'loop_min_overlap': 0.6,       # 0-1: share of a keyframe's points that must land on the matched one's surfaces
}
VERSION = 1   # bump when the outputs change without the code that computes them

# The first time qa imports this file, it generates the sequences' ground truth (about 20 s, see make_sequences.py)
ensure_sequences(INPUTS)


def read_flags(params=None):
    flags = dict(DEFAULT_FLAGS)
    path = ROOT / 'build' / 'flags.json'
    if path.exists():
        flags.update({k: v for k, v in json.loads(path.read_text()).items() if v is not None and k in DEFAULT_FLAGS})
    flags.update({k: v for k, v in (params or {}).items() if k in DEFAULT_FLAGS})   # tuning parameters
    for key, value in flags.items():
        if isinstance(DEFAULT_FLAGS[key], bool) and isinstance(value, str):
            flags[key] = value.lower() == 'true'
    return flags


def run_key(folder, flags, seed):
    """Everything a run depends on"""
    h = hashlib.sha256(json.dumps({'flags': flags, 'seed': seed, 'version': VERSION}, sort_keys=True).encode())
    for path in sorted((ROOT / 'qa').glob('*.py')) + [folder / 'sequence.yaml']:
        h.update(path.read_bytes())
    return h.hexdigest()[:20]


def compute(folder, flags, seed, output_dir):
    name = folder.name
    result = slam.process(folder, flags, seed)
    odo, truth, estimate = result['odometry'], result['truth'], result['estimate']
    frames = truth['frames']
    t = np.arange(len(frames)) / sensors.FPS
    world = {'room': tuple(truth['room']), 'boxes': truth['boxes'], 'kinds': [str(k) for k in truth['kinds']]}

    outputs.poses_tsv(output_dir / 'poses.tsv', t, estimate)
    outputs.poses_tsv(output_dir / 'GT_final.txt', t, frames)
    # the trajectories start at the same place: aligning them isn't needed to see the drift
    outputs.camera_video(output_dir / 'camera.webm', result['depth'], estimate, frames, world)
    outputs.error_plot(output_dir / 'ate.plotly.json', t, estimate, frames, odo.closures, f'{name}: position error')
    poses = [kf.pose for kf in odo.keyframes]
    true_poses = [frames[kf.frame] for kf in odo.keyframes]
    points = outputs.map_points(odo.keyframes, poses)
    outputs.map_png(output_dir / 'map.png', points, estimate, frames, world,
                    f"{name}: {len(odo.keyframes)} keyframes, {len(odo.closures)} loop closures")
    outputs.pcd(output_dir / 'map.pcd', points)
    outputs.pcd(output_dir / 'map.truth.pcd', outputs.map_points(odo.keyframes, true_poses))
    (output_dir / 'loop_closures.json').write_text(json.dumps({
        'accepted': [{k: v for k, v in c.items()} for c in odo.closures],
        'rejected': [{k: v for k, v in c.items()} for c in odo.rejected],
    }, indent=1))

    metrics = {**result['metrics'], 'is_failed': False}
    alignment = evaluate.align(estimate, frames)
    print(f"{len(odo.keyframes)} keyframes, {len(odo.closures)} loop closures ({len(odo.rejected)} candidates rejected), "
          f"aligned with a {np.linalg.norm(alignment[:3, 3]):.2f} m, {G.angle_deg(alignment):.1f}° transform")
    return metrics


def run(context):
    flags = read_flags(context.params)
    folder = Path(context.input_path)
    output_dir = Path(context.output_dir)
    seed = int(os.environ.get('QA_SEED', 0))
    name = folder.name
    print(f"{name}: voxel {flags['voxel_size']} m, {flags['icp_iterations']} ICP iterations, keyframes every "
          f"{flags['keyframe_dist']} m or {flags['keyframe_angle']}°, IMU weight {flags['imu_weight']}, loop closure "
          + (f"(overlap >= {flags['loop_min_overlap']})" if flags['loop_closure'] else 'off'))

    cached = CACHE / run_key(folder, flags, seed)
    if (cached / 'metrics.json').exists():
        print(f'Same code, flags and sequence as an earlier run: reusing it ({cached.name})')
        for path in cached.iterdir():
            if path.name != 'metrics.json':
                shutil.copy2(path, output_dir / path.name)
        metrics = json.loads((cached / 'metrics.json').read_text())
    else:
        metrics = compute(folder, flags, seed, output_dir)
        tmp = cached.with_name(cached.name + '.tmp')
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        for path in output_dir.iterdir():
            if path.is_file() and path.suffix != '.txt' or path.name == 'GT_final.txt':
                shutil.copy2(path, tmp / path.name)
        (tmp / 'metrics.json').write_text(json.dumps(metrics))
        shutil.rmtree(cached, ignore_errors=True)
        tmp.rename(cached)

    shown = ['ate_rmse', 'rpe_trans', 'rpe_rot', 'drift_end', 'loop_closures', 'time_per_frame']
    print(' | '.join(f'{k} {metrics[k]:.4g}' for k in shown if metrics.get(k) is not None))
    return metrics


if __name__ == '__main__':
    # A quick look without QA-Board: python qa/main.py figure8-fast [...] (flags from build/flags.json, FLAGS='{...}')
    flags = read_flags(json.loads(os.environ.get('FLAGS', '{}')))
    for arg in sys.argv[1:]:
        out = ROOT / 'output' / arg
        out.mkdir(parents=True, exist_ok=True)
        print(arg, json.dumps(compute(INPUTS / 'sequences' / arg, flags, int(os.environ.get('QA_SEED', 0)), out)))
