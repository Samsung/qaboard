"""
Loop closure: each keyframe gets a coarse occupancy signature (histograms of its points' ranges and heights) and
keypoints (where the surface bends: corners and edges). A new keyframe is compared with the older ones the odometry
puts nearby; the closest signatures are verified by ICP, coarse to fine, and the match counts its keypoints that land
on the other keyframe's. With `loop_min_inliers` of them or more, it's a loop closure: an edge in the keyframes' pose
graph, which is solved again with scipy.optimize.least_squares.
"""
import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

import geometry as G
import sensors

KEYPOINT_CURVATURE = 0.06     # smallest eigenvalue over their sum, at 10 neighbors
KEYPOINT_VOXEL = 0.15         # m
INLIER_DISTANCE = 0.08        # m
MIN_GAP = 25                  # keyframes between a keyframe and its candidates
MIN_TRAVEL = 6.0              # m traveled between them
SEARCH_RADIUS = 3.0           # m, plus 3% of the distance traveled since
MAX_VERIFIED = 2              # candidates verified per keyframe, the closest signatures
SIGMA_ODOMETRY = (0.002, 0.01)    # rad, m per edge
SIGMA_LOOP = (0.004, 0.03)


def _voxel(points, size):
    keys = np.floor(points / size).astype(np.int64)
    _, first = np.unique(keys, axis=0, return_index=True)
    return points[np.sort(first)]


def describe(kf):
    """The keyframe's signature, keypoints and coarse cloud"""
    pts = kf.points
    above = pts[:, 2] > -sensors.CAMERA_HEIGHT + 0.15     # not the floor
    horizontal = np.hypot(pts[above, 0], pts[above, 1])
    ranges, _ = np.histogram(horizontal, bins=16, range=(0, sensors.MAX_RANGE))
    heights, _ = np.histogram(pts[above, 2] + sensors.CAMERA_HEIGHT, bins=8, range=(0, 2.4))
    sig = np.concatenate([ranges / max(ranges.sum(), 1), heights / max(heights.sum(), 1)])
    kf.signature = sig
    kf.keypoints = _voxel(pts[(kf.curvature > KEYPOINT_CURVATURE) & above], KEYPOINT_VOXEL)
    kf.keypoint_tree = cKDTree(kf.keypoints) if len(kf.keypoints) else None
    kf.coarse = _voxel(pts, 0.1)


def _verify(new, old, T):
    """ICP of the new keyframe's coarse cloud to the old one, from T (old <- new), coarse to fine"""
    from odometry import icp
    for max_corr, iterations in ((1.0, 15), (0.4, 10), (0.15, 10)):
        T, stats = icp(new.coarse, old, T, iterations, max_corr=max_corr)
    inliers = 0
    if old.keypoint_tree is not None and len(new.keypoints):
        d, _ = old.keypoint_tree.query(G.apply(T, new.keypoints), distance_upper_bound=INLIER_DISTANCE)
        inliers = int(np.isfinite(d).sum())
    return T, {'inliers': inliers, 'rmse': stats['rmse']}


def find(keyframes, index, flags):
    """The best verified match of keyframe `index` among the older ones: (other index, T other <- new, stats) or None"""
    new = keyframes[index]
    candidates = []
    for i, old in enumerate(keyframes[:max(0, index - MIN_GAP)]):
        if new.distance - old.distance < MIN_TRAVEL:
            continue
        gap = np.linalg.norm(new.pose[:3, 3] - old.pose[:3, 3])
        if gap > SEARCH_RADIUS + 0.03 * (new.distance - old.distance):
            continue
        candidates.append((np.abs(new.signature - old.signature).sum(), i))
    best = None
    for _, i in sorted(candidates)[:MAX_VERIFIED]:
        old = keyframes[i]
        T, stats = _verify(new, old, G.inv(old.pose) @ new.pose)
        if best is None or stats['inliers'] > best[2]['inliers']:
            best = (i, T, stats)
    return best


class PoseGraph:
    """Keyframe poses linked by relative measurements; the first keyframe is fixed"""
    def __init__(self):
        self.edges = []   # (i, j, Z: T_i^-1 T_j measured, kind)

    def add_edge(self, i, j, Z, kind):
        self.edges.append((i, j, Z.copy(), kind))

    def optimize(self, poses):
        n = len(poses)
        poses = np.array(poses)
        x0 = np.concatenate([np.concatenate([Rotation.from_matrix(P[:3, :3]).as_rotvec(), P[:3, 3]]) for P in poses[1:]])
        I = np.array([e[0] for e in self.edges])
        J = np.array([e[1] for e in self.edges])
        Z = np.array([e[2] for e in self.edges])
        Zinv_R = np.transpose(Z[:, :3, :3], (0, 2, 1))
        Z_t = Z[:, :3, 3]
        loop = np.array([e[3] == 'loop' for e in self.edges])
        w_rot = np.where(loop, 1 / SIGMA_LOOP[0], 1 / SIGMA_ODOMETRY[0])
        w_t = np.where(loop, 1 / SIGMA_LOOP[1], 1 / SIGMA_ODOMETRY[1])
        first = poses[0]

        def unpack(x):
            rv = np.vstack([Rotation.from_matrix(first[:3, :3]).as_rotvec(), x.reshape(-1, 6)[:, :3]])
            t = np.vstack([first[:3, 3], x.reshape(-1, 6)[:, 3:]])
            return Rotation.from_rotvec(rv).as_matrix(), t

        def residuals(x):
            R, t = unpack(x)
            Ri, Rj, ti, tj = R[I], R[J], t[I], t[J]
            Ri_T = np.transpose(Ri, (0, 2, 1))
            rel_R = Ri_T @ Rj
            rel_t = np.einsum('nij,nj->ni', Ri_T, tj - ti)
            err_R = Zinv_R @ rel_R
            err_t = np.einsum('nij,nj->ni', Zinv_R, rel_t - Z_t)
            r_rot = Rotation.from_matrix(err_R).as_rotvec() * w_rot[:, None]
            return np.hstack([r_rot, err_t * w_t[:, None]]).ravel()

        sparsity = lil_matrix((len(self.edges) * 6, (n - 1) * 6), dtype=int)
        for e, (i, j) in enumerate(zip(I, J)):
            for node in (i, j):
                if node > 0:
                    sparsity[e * 6:(e + 1) * 6, (node - 1) * 6:node * 6] = 1
        result = least_squares(residuals, x0, jac_sparsity=sparsity, method='trf', x_scale='jac', max_nfev=50)
        R, t = unpack(result.x)
        out = np.tile(np.eye(4), (n, 1, 1))
        out[:, :3, :3] = R
        out[:, :3, 3] = t
        return list(out)
