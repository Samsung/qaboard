"""
Procedural warehouses: shelves, pallets, pillars and walls as axis-aligned boxes, from a layout and a seed.
The depth camera ray-casts against them.

World frame: x and y on the floor, z up, meters. A box is (x0, y0, z0, x1, y1, z1).
"""
import numpy as np

SHELF_HEIGHT = 2.4
LEVELS = (0.10, 0.85, 1.60)     # heights of the shelf levels' plates
BAY = 2.0                       # bay length along a row


def _shelf_row(boxes, kinds, rng, x0, x1, y0, y1, back='y1'):
    """A row of shelves along x, from x0 to x1, y0 to y1 deep: uprights, plates, a back panel, goods on the levels"""
    bays = max(1, int(round((x1 - x0) / BAY)))
    edges = np.linspace(x0, x1, bays + 1)
    for x in edges:
        boxes.append((x - 0.05, y0, 0.0, x + 0.05, y1, SHELF_HEIGHT)); kinds.append('upright')
    for z in LEVELS:
        boxes.append((x0, y0, z, x1, y1, z + 0.05)); kinds.append('shelf')
    panel = (y1 - 0.03, y1) if back == 'y1' else (y0, y0 + 0.03)
    boxes.append((x0, panel[0], 0.0, x1, panel[1], SHELF_HEIGHT)); kinds.append('shelf')
    for a, b in zip(edges[:-1], edges[1:]):
        for z in LEVELS:
            x = a + 0.1
            while True:
                w = rng.uniform(0.3, 0.8)
                if x + w > b - 0.1:
                    break
                if rng.random() < 0.75:   # some slots are empty
                    d = rng.uniform(0.4, y1 - y0 - 0.1)
                    h = rng.uniform(0.25, 0.6)
                    gy0 = y0 + 0.02 if back == 'y1' else y1 - 0.02 - d
                    boxes.append((x, gy0, z + 0.05, x + w, gy0 + d, z + 0.05 + h)); kinds.append('goods')
                x += w + rng.uniform(0.05, 0.3)


def _walls(boxes, kinds, x0, y0, x1, y1, height=4.0, t=0.2):
    boxes += [(x0 - t, y0 - t, 0, x1 + t, y0, height), (x0 - t, y1, 0, x1 + t, y1 + t, height),
              (x0 - t, y0, 0, x0, y1, height), (x1, y0, 0, x1 + t, y1, height)]
    kinds += ['wall'] * 4


def _pallet(boxes, kinds, rng, x, y, along_x=True):
    w, d = (1.2, 0.8) if along_x else (0.8, 1.2)
    boxes.append((x, y, 0.0, x + w, y + d, 0.15)); kinds.append('pallet')
    h = rng.uniform(0.4, 1.3)
    m = rng.uniform(0.0, 0.1)
    boxes.append((x + m, y + m, 0.15, x + w - m, y + d - m, 0.15 + h)); kinds.append('goods')


def _pillar(boxes, kinds, x, y, size=0.4, height=4.0):
    boxes.append((x - size / 2, y - size / 2, 0.0, x + size / 2, y + size / 2, height)); kinds.append('pillar')


def generate(layout: str, seed: int):
    """{'boxes': (n, 6) array, 'kinds': [str], 'room': (x0, y0, x1, y1)}"""
    rng = np.random.default_rng(seed)
    boxes, kinds = [], []
    if layout == 'aisles':
        room = (0.0, 0.0, 24.0, 14.4)
        for i, y in enumerate((1.2, 4.8, 8.4, 12.0)):
            _shelf_row(boxes, kinds, rng, 5.0, 17.0, y, y + 1.0, back='y0' if i % 2 else 'y1')
        for x, y in ((0.4, 1.0), (0.4, 12.6), (22.6, 1.0), (22.6, 12.6), (22.8, 7.0)):
            _pallet(boxes, kinds, rng, x + rng.uniform(-0.2, 0.2), y + rng.uniform(-0.3, 0.3), along_x=False)
        for x in (8.0, 14.0):
            _pillar(boxes, kinds, x, 0.6)
            _pillar(boxes, kinds, x, 13.8)
    elif layout == 'block':
        room = (0.0, 0.0, 18.0, 13.0)
        _shelf_row(boxes, kinds, rng, 5.0, 13.0, 5.0, 6.5, back='y1')
        _shelf_row(boxes, kinds, rng, 5.0, 13.0, 6.5, 8.0, back='y0')
        for x, y in ((1.0, 1.0), (16.0, 1.0), (1.0, 11.0), (16.0, 11.0), (8.5, 11.6)):
            _pallet(boxes, kinds, rng, x + rng.uniform(-0.2, 0.2), y + rng.uniform(-0.2, 0.2))
        for x, y in ((4.0, 1.0), (14.0, 12.0), (0.8, 6.5), (17.2, 6.5)):
            _pillar(boxes, kinds, x, y)
    elif layout == 'figure8':
        room = (0.0, 0.0, 26.0, 13.0)
        for x0 in (5.0, 17.0):
            _shelf_row(boxes, kinds, rng, x0, x0 + 4.0, 5.0, 6.5, back='y1')
            _shelf_row(boxes, kinds, rng, x0, x0 + 4.0, 6.5, 8.0, back='y0')
        for x, y in ((0.6, 0.6), (24.2, 0.6), (0.6, 11.6), (24.2, 11.6), (12.4, 0.5), (12.4, 11.8)):
            _pallet(boxes, kinds, rng, x + rng.uniform(-0.2, 0.2), y + rng.uniform(-0.1, 0.1))
        for x, y in ((7.0, 0.5), (19.0, 0.5), (7.0, 12.5), (19.0, 12.5)):
            _pillar(boxes, kinds, x, y)
    elif layout == 'dock':
        room = (0.0, 0.0, 10.0, 8.0)
        boxes.append((9.5, 3.5, 0.0, 10.0, 4.5, 0.6)); kinds.append('dock')       # the charging dock
        boxes.append((9.7, 3.2, 0.0, 10.0, 3.35, 1.2)); kinds.append('dock')
        boxes.append((9.7, 4.65, 0.0, 10.0, 4.8, 1.2)); kinds.append('dock')
        for x, y in ((8.6, 0.4), (8.6, 6.4), (0.4, 0.4), (0.4, 6.4), (5.0, 7.0)):
            _pallet(boxes, kinds, rng, x + rng.uniform(-0.1, 0.0), y + rng.uniform(0.0, 0.1), along_x=False)
        _shelf_row(boxes, kinds, rng, 1.0, 7.0, 0.0, 1.0, back='y0')
        for y in (2.0, 6.0):
            _pillar(boxes, kinds, 9.8, y, size=0.3)
    elif layout == 'corridor':
        # a long corridor (along x, 2.6 m wide, 2.8 m high): flat walls, a door frame or a cabinet now and then
        room = (0.0, 0.0, 40.0, 2.6)
        boxes.append((0.0, 0.0, 2.8, 40.0, 2.6, 2.9)); kinds.append('ceiling')
        x = 3.0 + rng.uniform(0, 2)
        while x < 38:
            side = rng.integers(2)
            if rng.random() < 0.5:   # a door frame
                y0, y1 = (0.0, 0.08) if side == 0 else (2.52, 2.6)
                boxes.append((x, y0, 0.0, x + 0.1, y1, 2.1)); kinds.append('wall')
                boxes.append((x + 1.0, y0, 0.0, x + 1.1, y1, 2.1)); kinds.append('wall')
                boxes.append((x, y0, 2.0, x + 1.1, y1, 2.1)); kinds.append('wall')
            else:                    # a cabinet against the wall
                d = rng.uniform(0.25, 0.4)
                y0, y1 = (0.0, d) if side == 0 else (2.6 - d, 2.6)
                boxes.append((x, y0, 0.0, x + rng.uniform(0.5, 1.0), y1, rng.uniform(0.8, 1.8))); kinds.append('goods')
            x += rng.uniform(6.0, 10.0)
    else:
        raise ValueError(f'unknown layout: {layout}')
    _walls(boxes, kinds, *room, height=2.9 if layout == 'corridor' else 4.0)
    x0, y0, x1, y1 = room
    boxes.append((x0 - 1, y0 - 1, -0.1, x1 + 1, y1 + 1, 0.0)); kinds.append('floor')
    return {'boxes': np.array(boxes, dtype=np.float64), 'kinds': kinds, 'room': room}


def raycast(origin, directions, boxes, max_range):
    """
    Distance along each ray (unit directions, (n, 3)) to the first box it hits, np.inf if none within max_range.
    Slab test, vectorized over rays x boxes; boxes out of range or behind the rays are skipped.
    """
    origin = np.asarray(origin, dtype=np.float64)
    centers = (boxes[:, :3] + boxes[:, 3:]) / 2 - origin
    radii = np.linalg.norm(boxes[:, 3:] - boxes[:, :3], axis=1) / 2
    mean_dir = directions.mean(axis=0)
    mean_dir /= np.linalg.norm(mean_dir)
    spread = np.max(np.arccos(np.clip(directions @ mean_dir, -1, 1)))
    dist = np.linalg.norm(centers, axis=1)
    # in range, and within the cone of the rays (or around the origin)
    cos_to_box = (centers @ mean_dir) / np.maximum(dist, 1e-9)
    angle_to_box = np.arccos(np.clip(cos_to_box, -1, 1))
    ang_radius = np.arcsin(np.clip(radii / np.maximum(dist, 1e-9), 0, 1))
    keep = (dist - radii < max_range) & ((angle_to_box - ang_radius < spread) | (dist <= radii))
    b = boxes[keep].astype(np.float32)
    d = directions.astype(np.float32)
    o = origin.astype(np.float32)
    with np.errstate(divide='ignore', invalid='ignore'):
        inv = 1.0 / d
        t_near = np.full((len(d), len(b)), -np.inf, dtype=np.float32)
        t_far = np.full((len(d), len(b)), np.inf, dtype=np.float32)
        for a in range(3):
            t1 = (b[None, :, a] - o[a]) * inv[:, a, None]
            t2 = (b[None, :, a + 3] - o[a]) * inv[:, a, None]
            # rays parallel to the slab: inside it or never
            parallel = d[:, a] == 0
            if parallel.any():
                inside = (o[a] >= b[:, a]) & (o[a] <= b[:, a + 3])
                t1[parallel] = np.where(inside, -np.inf, np.inf)[None, :]
                t2[parallel] = np.where(inside, np.inf, -np.inf)[None, :]
            np.maximum(t_near, np.minimum(t1, t2), out=t_near)
            np.minimum(t_far, np.maximum(t1, t2), out=t_far)
        hit = (t_near <= t_far) & (t_far > 0)
        t = np.where(hit, np.maximum(t_near, 0), np.inf)
    depth = t.min(axis=1) if t.shape[1] else np.full(len(d), np.inf, dtype=np.float32)
    depth[depth > max_range] = np.inf
    return depth
