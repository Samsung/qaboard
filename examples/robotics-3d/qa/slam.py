"""
One sequence through the odometry: simulate the sensors from the ground truth, run the odometry, evaluate it.
"""
import hashlib

import numpy as np

import evaluate
import odometry
import sensors


def load(folder):
    with np.load(folder / 'truth.npz') as data:
        return {k: data[k] for k in data.files}


def sensor_seed(seed, name, what):
    return int(hashlib.sha256(f'{seed}:{name}:{what}'.encode()).hexdigest()[:12], 16)


def process(folder, flags, seed):
    """{'truth', 'odometry', 'estimate', 'depth', 'metrics'} for the sequence in folder"""
    truth = load(folder)
    name = folder.name
    frames = truth['frames']
    depth = [sensors.noisy_depth(d / 1000.0, np.random.default_rng(sensor_seed(seed, name, f'depth{k}')))
             for k, d in enumerate(truth['depth_mm'])]
    imu = sensors.imu(truth['dense'], int(truth['rate']), np.random.default_rng(sensor_seed(seed, name, 'imu')))
    odo = odometry.Odometry(flags, np.random.default_rng(sensor_seed(seed, name, 'icp')))
    odo.run(depth, imu, frames[0])
    estimate = odo.trajectory()
    rpe_trans, rpe_rot = evaluate.rpe(estimate, frames)
    metrics = {
        'ate_rmse': evaluate.ate_rmse(estimate, frames),
        'rpe_trans': rpe_trans,
        'rpe_rot': rpe_rot,
        'drift_end': evaluate.drift_end(estimate, frames),
        'loop_closures': len(odo.closures),
        'keyframes': len(odo.keyframes),
        'time_per_frame': 1000 * float(np.mean(odo.times)),
    }
    return {'truth': truth, 'odometry': odo, 'estimate': estimate, 'depth': depth, 'metrics': metrics}
