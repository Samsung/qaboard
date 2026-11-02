"""
Loop closure: when the robot comes back to a place, its new keyframe is matched to the older keyframes the odometry
puts nearby (the closest first, by position and heading; their coarse occupancy signatures break ties). Each candidate
is verified by ICP, coarse to fine. A match is a loop closure when enough of the new keyframe's points land on the old
one's surfaces (`loop_min_overlap`): matches with little overlap slid along repeated structure, like a row of identical
shelf bays. A loop closure is an edge in the keyframes' pose graph, which is solved again with
scipy.optimize.least_squares.
"""
import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix
from scipy.spatial.transform import Rotation

import geometry as G
import sensors

MIN_GAP = 25                  # keyframes between a keyframe and its candidates
MIN_TRAVEL = 6.0              # m traveled between them
SEARCH_RADIUS = 3.0           # m, plus 3% of the distance traveled since
MAX_VERIFIED = 3              # candidates verified per keyframe, the closest
HEADING_COST = 1.0 / 30       # m per degree of heading difference, to rank candidates
ON_SURFACE = 0.03             # m from the old keyframe's surface, for the overlap
SIGMA_ODOMETRY = (0.002, 0.01)    # rad, m per edge
SIGMA_LOOP = (0.004, 0.03)


def _voxel(points, size):
    keys = np.floor(points / size).astype(np.int64)
    _, first = np.unique(keys, axis=0, return_index=True)
    return points[np.sort(first)]


def describe(kf):
    """The keyframe's signature and coarse cloud"""
    pts = kf.points
    above = pts[:, 2] > -sensors.CAMERA_HEIGHT + 0.15     # not the floor
    horizontal = np.hypot(pts[above, 0], pts[above, 1])
    ranges, _ = np.histogram(horizontal, bins=16, range=(0, sensors.MAX_RANGE))
    heights, _ = np.histogram(pts[above, 2] + sensors.CAMERA_HEIGHT, bins=8, range=(0, 2.4))
    kf.signature = np.concatenate([ranges / max(ranges.sum(), 1), heights / max(heights.sum(), 1)])
    kf.coarse = _voxel(pts, 0.1)


def _verify(new, old, T):
    """ICP of the new keyframe's coarse cloud to the old one, from T (old <- new), coarse to fine; and the overlap"""
    from odometry import icp
    for max_corr, iterations in ((0.4, 15), (0.15, 10)):
        T, stats = icp(new.coarse, old, T, iterations, max_corr=max_corr)
    moved = G.apply(T, new.coarse)
    d, idx = old.tree.query(moved, distance_upper_bound=0.1)
    ok = np.isfinite(d)
    on_surface = np.abs(np.einsum('ni,ni->n', moved[ok] - old.points[idx[ok]], old.normals[idx[ok]])) < ON_SURFACE
    return T, {'overlap': float(on_surface.sum() / max(len(moved), 1)), 'rmse': stats['rmse']}


def find(keyframes, index):
    """
    The best match of keyframe `index` among the older ones, by overlap: (other index, T other <- new, stats) or None.
    stats: overlap (0-1), correction (m, how far it moves the keyframe from the odometry's pose), rmse.
    """
    new = keyframes[index]
    candidates = []
    for i, old in enumerate(keyframes[:max(0, index - MIN_GAP)]):
        if new.distance - old.distance < MIN_TRAVEL:
            continue
        gap = np.linalg.norm(new.pose[:3, 3] - old.pose[:3, 3])
        if gap > SEARCH_RADIUS + 0.03 * (new.distance - old.distance):
            continue
        heading = G.angle_deg(G.inv(old.pose) @ new.pose)
        candidates.append((gap + HEADING_COST * heading + np.abs(new.signature - old.signature).sum(), i))
    best = None
    for _, i in sorted(candidates)[:MAX_VERIFIED]:
        old = keyframes[i]
        predicted = G.inv(old.pose) @ new.pose
        T, stats = _verify(new, old, predicted)
        stats['correction'] = float(np.linalg.norm((G.inv(predicted) @ T)[:3, 3]))
        if best is None or stats['overlap'] > best[2]['overlap']:
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
