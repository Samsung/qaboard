# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "scipy>=1.11", "pyyaml"]
# ///
"""
Generates the sequences' ground truth: for each inputs/sequences/<name>/sequence.yaml (committed: which path, the
world's seed), the warehouse, the robot's true trajectory and the depth camera's noiseless images, ray-cast against
the boxes, in truth.npz next to it (about 10 MB, not committed). Nothing is downloaded.

    uv run qa/make_sequences.py            # the missing ones (qa/main.py does it when it's imported)
    uv run qa/make_sequences.py --force loop
"""
import argparse
import fcntl
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import geometry  # noqa: E402
import sensors  # noqa: E402
import trajectory  # noqa: E402
import world  # noqa: E402

FRAMES = 600            # 40 s at 15 fps
VERSION = 1             # bump when the generation changes: truth.npz files are regenerated


def generate(folder: Path):
    spec = yaml.safe_load((folder / 'sequence.yaml').read_text())
    name = spec['sequence']
    layout = trajectory.SEQUENCES[name]['layout']
    w = world.generate(layout, spec['world_seed'])
    traj = trajectory.generate(name, spec['world_seed'], duration=FRAMES / sensors.FPS)
    dense = geometry.from_xy_yaw(traj['x'], traj['y'], traj['z'], traj['yaw'], traj['pitch'], traj['roll'])
    step = trajectory.RATE // sensors.FPS
    frames = dense[::step][:FRAMES]
    rays, ray_z = sensors.pixel_rays()
    rays_body = rays @ sensors.R_BODY_CAMERA.T
    depth = np.zeros((FRAMES, sensors.HEIGHT, sensors.WIDTH), dtype=np.uint16)
    for i, T in enumerate(frames):
        ranges = world.raycast(T[:3, 3], rays_body @ T[:3, :3].T, w['boxes'], sensors.MAX_RANGE)
        z = np.where(np.isfinite(ranges), ranges * ray_z, 0)
        depth[i] = np.round(z * 1000).astype(np.uint16).reshape(sensors.HEIGHT, sensors.WIDTH)
    tmp = folder / 'truth.tmp.npz'
    np.savez_compressed(tmp, version=VERSION, frames=frames, dense=dense.astype(np.float64), rate=trajectory.RATE,
                        depth_mm=depth, boxes=w['boxes'], kinds=np.array(w['kinds']), room=np.array(w['room']))
    tmp.rename(folder / 'truth.npz')
    return name


def is_current(folder: Path):
    path = folder / 'truth.npz'
    if not path.exists():
        return False
    try:
        with np.load(path) as data:
            return int(data['version']) == VERSION
    except Exception:
        return False


def ensure_sequences(root: Path, names=None, force=False, jobs=4):
    """Generates the missing (or outdated) sequences under root/sequences, once, even with runs in parallel"""
    folders = sorted(p.parent for p in (root / 'sequences').glob('*/sequence.yaml'))
    if names:
        folders = [f for f in folders if f.name in names]
    if not force and all(is_current(f) for f in folders):
        return
    with open(root / '.generate.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        todo = [f for f in folders if force or not is_current(f)]
        if todo:
            print(f"Generating the ground truth of {len(todo)} sequences (once): {', '.join(f.name for f in todo)}", file=sys.stderr)
            with ProcessPoolExecutor(max_workers=min(jobs, len(todo))) as pool:
                for name in pool.map(generate, todo):
                    print(f'  {name}', file=sys.stderr)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('names', nargs='*', help='sequences (default: all)')
    parser.add_argument('--force', action='store_true', help='regenerate even if up to date')
    parser.add_argument('--jobs', type=int, default=4)
    args = parser.parse_args()
    ensure_sequences(Path(__file__).resolve().parent.parent / 'inputs', args.names, args.force, args.jobs)
