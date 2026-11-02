"""
The robot's true motion for each sequence: paths through waypoints (cubic splines), driven with a speed profile that
respects lateral and longitudinal acceleration limits, turns in place, and waits. Sampled at 600 Hz, a multiple of
the IMU's 200 Hz and the depth camera's 15 fps. The body frame is the depth camera's center: x forward, y left, z up.
"""
import numpy as np
from scipy.interpolate import CubicSpline

RATE = 600            # Hz
CAMERA_HEIGHT = 0.6   # m

# waypoints (x, y), cruise speed (m/s), and the acceleration limits (m/s²) of each sequence's path legs
SEQUENCES = {
    'aisle-sweep': {
        'layout': 'aisles',
        'legs': [{'path': [(3.0, 3.5), (8.0, 3.5), (13.0, 3.5), (18.0, 3.5), (20.2, 4.2), (21.0, 5.3), (20.2, 6.4),
                           (18.0, 7.1), (13.0, 7.1), (8.0, 7.1), (4.0, 7.1), (1.8, 7.8), (1.0, 8.9), (1.8, 10.0),
                           (4.0, 10.7), (8.0, 10.7), (13.0, 10.7), (18.0, 10.7), (22.0, 10.7)],
                  'speed': 1.2, 'lateral': 0.8}],
    },
    'loop': {
        'layout': 'block',
        'legs': [{'path': [(6.0, 3.0), (10.0, 3.0), (13.5, 3.0), (15.2, 3.6), (15.8, 5.0), (15.8, 8.0), (15.2, 9.4),
                           (13.5, 10.0), (10.0, 10.0), (6.0, 10.0), (4.5, 10.0), (2.8, 9.4), (2.2, 8.0), (2.2, 5.0),
                           (2.8, 3.6), (4.5, 3.0)],
                  'closed': True, 'laps': 1.4, 'speed': 1.1, 'lateral': 0.8}],
    },
    'figure8': {
        'layout': 'figure8',
        'legs': [{'path': [(13.0, 6.5), (15.0, 9.0), (17.5, 10.4), (20.5, 10.6), (23.0, 9.6), (24.2, 6.5), (23.0, 3.4),
                           (20.5, 2.4), (17.5, 2.6), (15.0, 4.0), (13.0, 6.5), (11.0, 9.0), (8.5, 10.4), (5.5, 10.6),
                           (3.0, 9.6), (1.8, 6.5), (3.0, 3.4), (5.5, 2.4), (8.5, 2.6), (11.0, 4.0)],
                  'closed': True, 'laps': 1.2, 'speed': 1.15, 'lateral': 1.0}],
    },
    'docking': {
        'layout': 'dock',
        'legs': [{'path': [(3.0, 4.6), (5.0, 4.4), (7.0, 4.05), (8.0, 4.0)], 'speed': 0.35, 'lateral': 0.3},
                 {'wait': 1.5},
                 {'turn': 60}, {'turn': -120}, {'turn': 60},
                 {'wait': 1.0},
                 {'path': [(8.0, 4.0), (8.5, 4.0), (9.0, 4.0)], 'speed': 0.15, 'lateral': 0.3},
                 {'wait': 30}],
    },
    'long-corridor': {
        'layout': 'corridor',
        'legs': [{'path': [(1.5, 1.3), (6.0, 1.3), (10.0, 1.3), (13.0, 1.2), (15.5, 0.8), (17.2, 0.8), (18.1, 1.3),
                           (17.2, 1.85), (15.5, 1.85), (13.0, 1.4), (10.0, 1.3), (6.0, 1.3), (1.5, 1.3)],
                  'speed': 0.9, 'lateral': 0.6}],
    },
}
SEQUENCES['figure8-fast'] = {
    'layout': 'figure8',
    'legs': [{**SEQUENCES['figure8']['legs'][0], 'laps': 2.4, 'speed': 2.3, 'lateral': 2.5}],
}


def _spline(points, closed):
    p = np.asarray(points, dtype=np.float64)
    if closed:
        p = np.vstack([p, p[:1]])
    chord = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))])
    return CubicSpline(chord, p, bc_type='periodic' if closed else 'not-a-knot'), chord[-1]


def _path_leg(leg, duration):
    """x, y, yaw at RATE for a path leg, from rest; it stops at the end of the path (or runs out of time)"""
    closed = leg.get('closed', False)
    spline, length = _spline(leg['path'], closed)
    laps = leg.get('laps', 1)
    # arc length along the spline's parameter (the chord length)
    u = np.linspace(0, length, 4001)
    xy = spline(u)
    d1, d2 = spline(u, 1), spline(u, 2)
    s_of_u = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(xy, axis=0), axis=1))])
    curvature = np.abs(d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]) / np.maximum(np.linalg.norm(d1, axis=1) ** 3, 1e-9)
    if closed:
        arc = s_of_u[-1]
        reps = int(np.ceil(laps))
        s_all = np.concatenate([s_of_u[:-1] + k * arc for k in range(reps)])
        u_all = np.concatenate([u[:-1] + k * length for k in range(reps)])
        k_all = np.tile(curvature[:-1], reps)
        total = arc * laps
    else:
        s_all, u_all, k_all = s_of_u, u, curvature
        total = s_of_u[-1]
    keep = s_all <= total
    s_all, u_all, k_all = s_all[keep], u_all[keep], k_all[keep]
    # speed profile: lateral limit, then acceleration limits forward (from rest) and backward (to rest)
    accel = leg.get('accel', 0.5 if leg['speed'] < 2 else 1.2)
    v = np.minimum(leg['speed'], np.sqrt(leg['lateral'] / np.maximum(k_all, 1e-6)))
    ds = np.diff(s_all)
    v[0] = 0.0
    for i in range(1, len(v)):
        v[i] = min(v[i], np.sqrt(v[i - 1] ** 2 + 2 * accel * ds[i - 1]))
    v[-1] = 0.0
    for i in range(len(v) - 2, -1, -1):
        v[i] = min(v[i], np.sqrt(v[i + 1] ** 2 + 2 * accel * ds[i]))
    # time at each arc-length sample, then positions at RATE
    v_mid = np.maximum((v[1:] + v[:-1]) / 2, 1e-3)
    t_s = np.concatenate([[0], np.cumsum(ds / v_mid)])
    n = min(int(t_s[-1] * RATE) + 1, int(duration * RATE))
    t = np.arange(n) / RATE
    uu = np.interp(t, t_s, u_all)
    if closed:
        uu = np.mod(uu, length)
    p = spline(uu)
    d = spline(uu, 1)
    yaw = np.unwrap(np.arctan2(d[:, 1], d[:, 0]))
    return p[:, 0], p[:, 1], yaw


def _turn_leg(x, y, yaw, degrees, rate=0.45, accel=0.9):
    """A turn in place, with a trapezoid yaw-rate profile"""
    angle = np.radians(abs(degrees))
    t_acc = rate / accel
    if angle < rate * t_acc:      # triangle
        t_acc = np.sqrt(angle / accel)
        rate = accel * t_acc
    t_cruise = (angle - rate * t_acc) / rate
    total = 2 * t_acc + t_cruise
    t = np.arange(int(total * RATE) + 1) / RATE
    a = np.where(t < t_acc, 0.5 * accel * t ** 2,
                 np.where(t < t_acc + t_cruise, 0.5 * accel * t_acc ** 2 + rate * (t - t_acc),
                          angle - 0.5 * accel * np.maximum(total - t, 0) ** 2))
    return np.full_like(t, x), np.full_like(t, y), yaw + np.sign(degrees) * a


def generate(name, seed, duration=40.0):
    """The true trajectory at RATE: {'t', 'x', 'y', 'z', 'yaw', 'pitch', 'roll'} over `duration` seconds"""
    spec = SEQUENCES[name]
    xs, ys, yaws = [], [], []
    for leg in spec['legs']:
        last = (xs[-1][-1], ys[-1][-1], yaws[-1][-1]) if xs else None
        if 'path' in leg:
            x, y, yaw = _path_leg(leg, duration)
            if last is not None:   # continue from the current heading
                yaw = yaw + np.round((last[2] - yaw[0]) / (2 * np.pi)) * 2 * np.pi
        elif 'turn' in leg:
            x, y, yaw = _turn_leg(*last, leg['turn'])
        else:
            n = int(leg['wait'] * RATE)
            x, y, yaw = np.full(n, last[0]), np.full(n, last[1]), np.full(n, last[2])
        xs.append(x); ys.append(y); yaws.append(yaw)
    x, y, yaw = (np.concatenate(a) for a in (xs, ys, yaws))
    n = int(duration * RATE)
    if len(x) < n:   # stopped at the end
        pad = n - len(x)
        x, y, yaw = (np.concatenate([a, np.full(pad, a[-1])]) for a in (x, y, yaw))
    x, y, yaw = x[:n], y[:n], yaw[:n]
    t = np.arange(n) / RATE
    # small bumps from the floor: height, pitch and roll, smooth (sums of sines with seeded phases)
    rng = np.random.default_rng(seed)
    def bumps(amplitude):
        out = np.zeros(n)
        for f in (0.7, 1.3, 2.9):
            out += amplitude / 3 * np.sin(2 * np.pi * f * t + rng.uniform(0, 2 * np.pi))
        return out
    speed = np.hypot(np.gradient(x, 1 / RATE), np.gradient(y, 1 / RATE))
    moving = np.clip(speed / 0.3, 0, 1)
    z = CAMERA_HEIGHT + bumps(0.004) * moving
    pitch = bumps(np.radians(0.6)) * moving
    roll = bumps(np.radians(0.5)) * moving
    return {'t': t, 'x': x, 'y': y, 'z': z, 'yaw': yaw, 'pitch': pitch, 'roll': roll}
