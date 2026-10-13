"""
Rigid transforms. A pose is a 4x4 matrix T (world <- body): x forward, y left, z up. Quaternions are (w, x, y, z).
"""
import numpy as np
from scipy.spatial.transform import Rotation


def pose(R=None, t=None):
    T = np.eye(4)
    if R is not None:
        T[:3, :3] = R
    if t is not None:
        T[:3, 3] = t
    return T


def inv(T):
    Ti = np.eye(4)
    R = T[:3, :3]
    Ti[:3, :3] = R.T
    Ti[:3, 3] = -R.T @ T[:3, 3]
    return Ti


def apply(T, points):
    """points (n, 3) in the frame T maps from"""
    return points @ T[:3, :3].T + T[:3, 3]


def exp(xi):
    """[rotation vector, translation] -> T (rotation and translation applied separately, on the left: T' = exp(xi) T)"""
    return pose(Rotation.from_rotvec(xi[:3]).as_matrix(), xi[3:])


def log(T):
    """T -> [rotation vector, translation]"""
    return np.concatenate([Rotation.from_matrix(T[:3, :3]).as_rotvec(), T[:3, 3]])


def angle_deg(T):
    """The angle of T's rotation, in degrees"""
    return np.degrees(np.linalg.norm(Rotation.from_matrix(T[:3, :3]).as_rotvec()))


def from_xyz_quat(xyz, quat_wxyz):
    q = np.asarray(quat_wxyz)
    R = Rotation.from_quat(np.concatenate([q[..., 1:], q[..., :1]], axis=-1)).as_matrix()
    if R.ndim == 2:
        return pose(R, xyz)
    T = np.tile(np.eye(4), (len(R), 1, 1))
    T[:, :3, :3] = R
    T[:, :3, 3] = xyz
    return T


def to_xyz_quat(T):
    """(n, 4, 4) -> (n, 7): x y z q_w q_x q_y q_z, with q_w >= 0"""
    T = np.asarray(T).reshape(-1, 4, 4)
    q = Rotation.from_matrix(T[:, :3, :3]).as_quat()   # x y z w
    q = np.concatenate([q[:, 3:], q[:, :3]], axis=1)
    q[q[:, 0] < 0] *= -1
    return np.concatenate([T[:, :3, 3], q], axis=1)


def from_xy_yaw(x, y, z, yaw, pitch=0.0, roll=0.0):
    """Poses from arrays of position and Euler angles (intrinsic z-y-x)"""
    R = Rotation.from_euler('ZYX', np.stack(np.broadcast_arrays(yaw, pitch, roll), axis=-1)).as_matrix()
    T = np.tile(np.eye(4), (len(R), 1, 1))
    T[:, :3, :3] = R
    T[:, :3, 3] = np.stack(np.broadcast_arrays(x, y, z), axis=-1)
    return T


def umeyama(source, target):
    """The rigid transform (no scale) that best maps source points onto target points, least squares"""
    mu_s, mu_t = source.mean(axis=0), target.mean(axis=0)
    cov = (target - mu_t).T @ (source - mu_s) / len(source)
    U, _, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1
    R = U @ S @ Vt
    return pose(R, mu_t - R @ mu_s)
