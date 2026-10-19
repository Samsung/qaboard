"""
Depth and IMU odometry: each frame is registered to the last keyframe with point-to-plane ICP, started from the IMU's
prediction, which also stays in the cost as a prior (`imu_weight`). A new keyframe after `keyframe_dist` meters or
`keyframe_angle` degrees. With `loop_closure`, keyframes that come back to a place are matched (loop_closure.py) and
a pose graph of the keyframes is solved again.
"""
import time

import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

import geometry as G
import loop_closure
import sensors

MAX_SOURCE_POINTS = 2500      # points of each frame used by ICP, sampled after voxel downsampling
MAX_CORRESPONDENCE = 0.25     # m
HUBER = 0.04                  # m
SIGMA_ICP = 0.02              # m, per point...
ICP_POINTS = 150              # ...as if that many points were independent
SIGMA_PRIOR_ROT = 0.004       # rad, the IMU's prediction over a frame
SIGMA_PRIOR_T = 0.01          # m
DEGENERATE = 0.02             # translation directions that fewer than ~2% of the points constrain follow the prior
VELOCITY_GAIN = 0.5           # how much of ICP's correction goes into the velocity estimate


def voxel_downsample(points, size):
    """The centroid of the points in each voxel"""
    if len(points) == 0:
        return points
    keys = np.floor(points / size).astype(np.int64)
    keys -= keys.min(axis=0)
    dims = keys.max(axis=0) + 1
    flat = (keys[:, 0] * dims[1] + keys[:, 1]) * dims[2] + keys[:, 2]
    _, inverse, counts = np.unique(flat, return_inverse=True, return_counts=True)
    out = np.zeros((len(counts), 3))
    np.add.at(out, inverse, points)
    return out / counts[:, None]


def normals(points, tree, k=10):
    """Normals (pointing to the sensor at the origin) and curvature (smallest eigenvalue over their sum) by PCA"""
    k = min(k, len(points))
    _, idx = tree.query(points, k=k)
    nb = points[idx]
    centered = nb - nb.mean(axis=1, keepdims=True)
    cov = np.einsum('nki,nkj->nij', centered, centered) / k
    w, v = np.linalg.eigh(cov)
    n = v[:, :, 0]
    flip = np.einsum('ni,ni->n', n, points) > 0
    n[flip] *= -1
    curvature = w[:, 0] / np.maximum(w.sum(axis=1), 1e-12)
    return n, curvature


class Keyframe:
    def __init__(self, frame, pose, points, voxel_size):
        self.frame = frame
        self.pose = pose                        # world <- body, updated by the pose graph
        self.points = voxel_downsample(points, voxel_size)
        self.tree = cKDTree(self.points)
        self.normals, self.curvature = normals(self.points, self.tree)
        self.planar = self.curvature < 0.08
        self.distance = 0.0                     # traveled since the start, m
        self.signature = None
        self.coarse = None


def icp(source, target, T, iterations, prior=None, prior_weight=0.0, max_corr=MAX_CORRESPONDENCE):
    """
    Point-to-plane ICP of source points (in their body frame) to a keyframe, from T (keyframe <- source).
    prior: the predicted T, kept in the cost with prior_weight (0-1, against ICP's weight). Returns T and stats.
    """
    info = np.zeros((6, 6))
    n_iter, inliers, rmse, degenerate = 0, 0, np.inf, 0
    for n_iter in range(1, iterations + 1):
        moved = G.apply(T, source)
        dist, idx = target.tree.query(moved, distance_upper_bound=max_corr)
        ok = np.isfinite(dist)
        ok[ok] &= target.planar[idx[ok]]
        if ok.sum() < 10:
            break
        p, q, nq = moved[ok], target.points[idx[ok]], target.normals[idx[ok]]
        r = np.einsum('ni,ni->n', p - q, nq)
        J = np.hstack([np.cross(p, nq), nq])
        w = np.where(np.abs(r) < HUBER, 1.0, HUBER / np.maximum(np.abs(r), 1e-12))
        scale = (1 - prior_weight) * ICP_POINTS / (len(r) * SIGMA_ICP ** 2)
        H = scale * (J * w[:, None]).T @ J
        g = scale * J.T @ (w * r)
        info = H.copy()
        if prior is not None and prior_weight > 0:
            e = G.log(prior @ G.inv(T))   # the update that would bring T to the prior, to first order
            L = prior_weight * np.diag([1 / SIGMA_PRIOR_ROT ** 2] * 3 + [1 / SIGMA_PRIOR_T ** 2] * 3)
            H += L
            g -= L @ e
        delta = -np.linalg.solve(H + 1e-9 * np.eye(6), g)
        if prior is not None:
            # Degenerate directions (an aisle, a corridor: nothing in view says how far along it the robot moved): ICP
            # can't tell, and its noise would decide. Its translation along them stays where the prior put it.
            eigenvalues, directions = np.linalg.eigh(J[:, 3:].T @ (J[:, 3:] * w[:, None]) / len(r))
            weak = directions[:, eigenvalues < DEGENERATE]
            delta[3:] -= weak @ (weak.T @ delta[3:])
            degenerate = weak.shape[1]
        T = G.exp(delta) @ T
        inliers = int((np.abs(r) < 0.03).sum())
        rmse = float(np.sqrt(np.mean(r ** 2)))
        if np.linalg.norm(delta[:3]) < 1e-5 and np.linalg.norm(delta[3:]) < 1e-4:
            break
    return T, {'iterations': n_iter, 'inliers': inliers, 'rmse': rmse, 'information': info, 'degenerate': degenerate}


class Odometry:
    def __init__(self, flags, rng):
        self.flags = flags
        self.rng = rng
        self.keyframes = []
        self.frame_keyframe = []     # each frame's keyframe index
        self.frame_relative = []     # each frame's pose relative to its keyframe
        self.online = []             # each frame's pose as estimated when it was processed
        self.closures = []           # accepted loop closures: (frame, keyframe index, matched keyframe index)
        self.rejected = []           # candidates that failed verification
        self.times = []              # processing time of each frame, s
        self.graph = loop_closure.PoseGraph()
        self.icp_stats = []

    def run(self, depth_frames, imu, initial_pose):
        t_imu, gyro, accel = imu
        dt_frame = 1 / sensors.FPS
        T = initial_pose.copy()
        v = np.zeros(3)
        distance = 0.0
        for k, depth in enumerate(depth_frames):
            start = time.perf_counter()
            points = sensors.backproject(depth)
            if k == 0:
                self._new_keyframe(k, T, depth, distance)
            else:
                # IMU prediction from the previous frame
                R, p = T[:3, :3].copy(), T[:3, 3].copy()
                p_start = p.copy()
                ta, tb = (k - 1) * dt_frame, k * dt_frame
                j0 = int(np.floor(ta * sensors.IMU_RATE))
                j1 = int(np.ceil(tb * sensors.IMU_RATE))
                v_pred = v.copy()
                for j in range(j0, min(j1, len(t_imu))):
                    lo = max(ta, t_imu[j])
                    hi = min(tb, t_imu[j] + 1 / sensors.IMU_RATE)
                    dt = hi - lo
                    if dt <= 0:
                        continue
                    a_world = R @ accel[j] + sensors.GRAVITY
                    p = p + v_pred * dt + 0.5 * a_world * dt ** 2
                    v_pred = v_pred + a_world * dt
                    R = R @ Rotation.from_rotvec(gyro[j] * dt).as_matrix()
                predicted = G.orthonormalize(G.pose(R, p))
                kf = self.keyframes[-1]
                source = voxel_downsample(points, self.flags['voxel_size'])
                if len(source) > MAX_SOURCE_POINTS:
                    source = source[self.rng.choice(len(source), MAX_SOURCE_POINTS, replace=False)]
                prior_rel = G.inv(kf.pose) @ predicted
                rel, stats = icp(source, kf, prior_rel, int(self.flags['icp_iterations']), prior=prior_rel,
                                 prior_weight=float(self.flags['imu_weight']))
                self.icp_stats.append(stats)
                T = G.orthonormalize(kf.pose @ rel)
                # the velocity follows the IMU, corrected by part of what ICP moved the prediction
                v = v_pred + VELOCITY_GAIN * (T[:3, 3] - predicted[:3, 3]) / dt_frame
                distance += np.linalg.norm(T[:3, 3] - p_start)
                if (np.linalg.norm(rel[:3, 3]) > self.flags['keyframe_dist']
                        or G.angle_deg(rel) > self.flags['keyframe_angle']):
                    T = self._new_keyframe(k, T, depth, distance, stats['information'])
            kf_index = len(self.keyframes) - 1
            self.frame_keyframe.append(kf_index)
            self.frame_relative.append(G.inv(self.keyframes[kf_index].pose) @ T)
            self.online.append(T.copy())
            self.times.append(time.perf_counter() - start)

    def _new_keyframe(self, frame, T, depth, distance, information=None):
        # keyframes are registered to many times: their depth is smoothed first, for cleaner surfaces and normals
        points = sensors.backproject(sensors.smooth_depth(depth, radius=1))
        kf = Keyframe(frame, T.copy(), points, self.flags['voxel_size'])
        kf.distance = distance
        index = len(self.keyframes)
        self.keyframes.append(kf)
        if index > 0:
            prev = self.keyframes[index - 1]
            self.graph.add_edge(index - 1, index, G.inv(prev.pose) @ kf.pose, kind='odometry')
        if self.flags['loop_closure']:
            loop_closure.describe(kf)
            match = loop_closure.find(self.keyframes, index)
            if match is not None:
                other, Z, stats = match
                if stats['overlap'] >= self.flags['loop_min_overlap']:
                    self.graph.add_edge(other, index, Z, kind='loop')
                    self.closures.append({'frame': frame, 'keyframe': index, 'matched': other, **stats})
                    poses = self.graph.optimize([k.pose for k in self.keyframes])
                    for k, P in zip(self.keyframes, poses):
                        k.pose = P
                    return kf.pose.copy()
                self.rejected.append({'frame': frame, 'keyframe': index, 'matched': other, **stats})
        return T

    def trajectory(self):
        """Every frame's pose, on the keyframes' final poses"""
        return np.array([self.keyframes[k].pose @ rel for k, rel in zip(self.frame_keyframe, self.frame_relative)])
