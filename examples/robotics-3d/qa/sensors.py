"""
The K3's sensors, simulated: a depth camera (160x120, 15 fps, 70° horizontal field of view) and an IMU (200 Hz).

The depth camera's optical frame has z forward, x right, y down; the body frame x forward, y left, z up, both centered
on the camera.
"""
import numpy as np
from scipy.spatial.transform import Rotation

WIDTH, HEIGHT = 160, 120
HFOV = np.radians(70)
FX = (WIDTH / 2) / np.tan(HFOV / 2)
FY = FX
CX, CY = WIDTH / 2 - 0.5, HEIGHT / 2 - 0.5
FPS = 15
CAMERA_HEIGHT = 0.6     # m above the floor, where the robot's mount puts it
MAX_RANGE = 8.0
MIN_RANGE = 0.2
IMU_RATE = 200
GRAVITY = np.array([0.0, 0.0, -9.81])
# body <- optical
R_BODY_CAMERA = np.array([[0.0, 0.0, 1.0], [-1.0, 0.0, 0.0], [0.0, -1.0, 0.0]])


def pixel_rays():
    """Unit rays of the pixels in the optical frame (H*W, 3), and their z component"""
    u, v = np.meshgrid(np.arange(WIDTH), np.arange(HEIGHT))
    rays = np.stack([(u - CX) / FX, (v - CY) / FY, np.ones_like(u, dtype=np.float64)], axis=-1).reshape(-1, 3)
    norms = np.linalg.norm(rays, axis=1, keepdims=True)
    return rays / norms, 1 / norms[:, 0]


def backproject(depth, stride=1):
    """Depth image (H, W), z in meters (0 = no data) -> points in the body frame (n, 3)"""
    d = depth[::stride, ::stride]
    v, u = np.nonzero(d > 0)
    z = d[v, u].astype(np.float64)
    u, v = u * stride, v * stride
    optical = np.stack([(u - CX) / FX * z, (v - CY) / FY * z, z], axis=1)
    return optical @ R_BODY_CAMERA.T


def noisy_depth(depth, rng):
    """
    What the camera measures: noise of 1% of the depth (σ), no data at depth edges (mixed pixels are dropped, most of
    the time) and on 0.5% of the pixels, nothing under 0.2 m.
    """
    d = depth.astype(np.float64)
    valid = (d > MIN_RANGE) & np.isfinite(d)
    padded = np.pad(np.where(valid, d, 0), 1, mode='edge')
    jumps = np.zeros_like(d)
    for dy, dx in ((0, 1), (2, 1), (1, 0), (1, 2)):
        jumps = np.maximum(jumps, np.abs(padded[dy:dy + HEIGHT, dx:dx + WIDTH] - d))
    edge = jumps > 0.08 * np.maximum(d, 0.5)
    drop = (edge & (rng.random(d.shape) < 0.8)) | (rng.random(d.shape) < 0.005)
    out = d + rng.normal(0, 1, d.shape) * 0.01 * d
    out[~valid | drop] = 0.0
    return out.astype(np.float32)


def imu_truth(poses, rate):
    """True angular velocity (body frame) and specific force (body frame) at each sample of a pose sequence"""
    R = poses[:, :3, :3]
    p = poses[:, :3, 3]
    dt = 1 / rate
    rel = np.einsum('nji,njk->nik', R[:-1], R[1:])     # R_i^T R_{i+1}
    omega = Rotation.from_matrix(rel).as_rotvec() / dt
    omega = np.vstack([omega, omega[-1:]])
    acc_world = np.gradient(np.gradient(p, dt, axis=0), dt, axis=0)
    specific = np.einsum('nji,nj->ni', R, acc_world - GRAVITY)
    return omega, specific


def imu(truth_poses, truth_rate, rng):
    """IMU samples at 200 Hz: (t, gyro, accel), with white noise and biases that random-walk"""
    step = truth_rate // IMU_RATE
    omega, specific = imu_truth(truth_poses, truth_rate)
    # angular velocity between consecutive IMU samples: average the truth over the interval
    n = len(truth_poses) // step
    omega = omega[:n * step].reshape(n, step, 3).mean(axis=1)
    specific = specific[:n * step].reshape(n, step, 3).mean(axis=1)
    t = np.arange(n) / IMU_RATE
    gyro_bias = rng.normal(0, 0.002, 3) + np.cumsum(rng.normal(0, 2e-5, (n, 3)), axis=0)
    accel_bias = rng.normal(0, 0.02, 3) + np.cumsum(rng.normal(0, 2e-4, (n, 3)), axis=0)
    gyro = omega + gyro_bias + rng.normal(0, 0.004, (n, 3))
    accel = specific + accel_bias + rng.normal(0, 0.04, (n, 3))
    return t, gyro, accel


def smooth_depth(depth, radius=2, tolerance=0.03):
    """
    Edge-preserving smoothing of a depth image: each pixel becomes the mean of its (2r+1)² neighbors whose depth is
    within `tolerance` (relative) of its own, so that surfaces are averaged and depth edges kept. 0 is no data.
    """
    d = depth.astype(np.float64)
    valid = d > 0
    padded = np.pad(d, radius, mode='constant')
    total = np.zeros_like(d)
    count = np.zeros_like(d)
    for dy in range(2 * radius + 1):
        for dx in range(2 * radius + 1):
            n = padded[dy:dy + HEIGHT, dx:dx + WIDTH]
            ok = (n > 0) & (np.abs(n - d) < tolerance * np.maximum(d, 1e-6))
            total += np.where(ok, n, 0)
            count += ok
    out = np.where(valid & (count > 0), total / np.maximum(count, 1), 0)
    return out.astype(np.float32)
