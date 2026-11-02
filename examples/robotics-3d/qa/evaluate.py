"""
Trajectory errors against the ground truth: ATE (after the best rigid alignment), RPE over 1 m segments, drift.
"""
import numpy as np

import geometry as G

RPE_SEGMENT = 1.0   # m traveled


def align(estimate, truth):
    """The rigid transform that best maps the estimated positions onto the true ones"""
    return G.umeyama(estimate[:, :3, 3], truth[:, :3, 3])


def position_errors(estimate, truth, alignment=None):
    """Distance between each estimated position and the true one, after the alignment"""
    A = align(estimate, truth) if alignment is None else alignment
    return np.linalg.norm(G.apply(A, estimate[:, :3, 3]) - truth[:, :3, 3], axis=1)


def ate_rmse(estimate, truth):
    return float(np.sqrt(np.mean(position_errors(estimate, truth) ** 2)))


def rpe(estimate, truth, segment=RPE_SEGMENT):
    """
    Relative pose error over segments of `segment` meters traveled (true path): mean translation error per meter
    (a fraction: 0.01 is 1%) and mean rotation error in degrees per meter. Segments start at every frame.
    """
    steps = np.linalg.norm(np.diff(truth[:, :3, 3], axis=0), axis=1)
    traveled = np.concatenate([[0], np.cumsum(steps)])
    trans, rot = [], []
    for i in range(len(truth)):
        j = np.searchsorted(traveled, traveled[i] + segment)
        if j >= len(truth):
            break
        dist = traveled[j] - traveled[i]
        true_rel = G.inv(truth[i]) @ truth[j]
        est_rel = G.inv(estimate[i]) @ estimate[j]
        E = G.inv(true_rel) @ est_rel
        trans.append(np.linalg.norm(E[:3, 3]) / dist)
        rot.append(G.angle_deg(E) / dist)
    if not trans:
        return None, None
    return float(np.mean(trans)), float(np.mean(rot))


def drift_end(estimate, truth):
    """Where the robot thinks it is at the end, against where it is (both start at the true pose)"""
    return float(np.linalg.norm(estimate[-1, :3, 3] - truth[-1, :3, 3]))
