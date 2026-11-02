"""
What a run saves for QA-Board's viewers (qaboard.yaml's visualizations):
- poses.tsv and GT_final.txt: the estimated and true trajectories, for the 6DoF viewer,
- camera.webm: the depth camera, next to a top-down view of the path so far, played in sync with the reference's,
- ate.plotly.json: the position error over time, with the loop closures,
- map.png: the map the odometry built, seen from above, over the warehouse's true layout,
- map.pcd and map.truth.pcd: the same map in 3D, and the points where they really are, for the point cloud viewer.
"""
import json
import subprocess

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.spatial.transform import Rotation

import evaluate
import geometry as G
import sensors

# The same colors as the web app's viewers: the run in orange, the ground truth in green
NEW = (217, 130, 43)
TRUTH = (35, 133, 81)
INK = (28, 33, 39)
SHELF = (171, 179, 191)
BACKGROUND = (246, 247, 249)
VIDEO_SCALE = 2           # the depth images are 160x120: 320x240 in the video
VIDEO_PANEL = 240         # px, the top-down view next to them
MAP_SIZE = 900            # px, map.png's longest side
MAP_VOXEL = 0.08          # m, the point clouds' resolution


def poses_tsv(path, t, poses):
    """t x y z yaw pitch roll (m, degrees, yaw unwrapped), tab-separated, a header row: the 6DoF viewer's format"""
    angles = np.degrees(np.unwrap(Rotation.from_matrix(poses[:, :3, :3]).as_euler('ZYX'), axis=0))
    rows = np.column_stack([t, poses[:, :3, 3], angles])
    lines = ['t\tx\ty\tz\tyaw\tpitch\troll'] + ['\t'.join(f'{v:.4f}' for v in row) for row in rows]
    path.write_text('\n'.join(lines) + '\n')


def turbo(x):
    """Google's Turbo colormap (polynomial approximation), x in 0-1 -> uint8 RGB"""
    x = np.clip(x, 0, 1)[..., None]
    r = 0.13572138 + x * (4.61539260 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))))
    g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))))
    b = 0.10667330 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))))
    return (np.clip(np.concatenate([r, g, b], axis=-1), 0, 1) * 255).astype(np.uint8)


def depth_image(depth):
    """Near is red, far is blue, no data is black"""
    rgb = turbo(1 - np.clip(depth / sensors.MAX_RANGE, 0, 1) ** 0.6)
    rgb[depth <= 0] = 0
    return rgb


class TopDown:
    """World (x, y) to pixels of a view of the room, north up, with the boxes taller than the camera's floor clutter"""
    def __init__(self, room, boxes, kinds, size, margin=10):
        x0, y0, x1, y1 = room
        self.scale = (size - 2 * margin) / max(x1 - x0, y1 - y0)
        self.width = int(round((x1 - x0) * self.scale)) + 2 * margin
        self.height = int(round((y1 - y0) * self.scale)) + 2 * margin
        self.origin = (x0, y1, margin)
        self.boxes = [b for b, k in zip(boxes, kinds) if k not in ('floor', 'ceiling') and b[5] > 0.3]

    def px(self, xy):
        x0, y1, margin = self.origin
        xy = np.asarray(xy, dtype=np.float64).reshape(-1, 2)
        return np.column_stack([margin + (xy[:, 0] - x0) * self.scale, margin + (y1 - xy[:, 1]) * self.scale])

    def base(self):
        image = Image.new('RGB', (self.width, self.height), BACKGROUND)
        draw = ImageDraw.Draw(image)
        for b in self.boxes:
            (ax, ay), (bx, by) = self.px([(b[0], b[4]), (b[3], b[1])])
            draw.rectangle([ax, ay, max(bx, ax + 1), max(by, ay + 1)], fill=SHELF)
        return image

    def path(self, draw, xy, color, width):
        if len(xy) > 1:
            draw.line([tuple(p) for p in self.px(xy)], fill=color, width=width, joint='curve')


def camera_video(path, depth_frames, estimate, truth, world):
    """The depth camera, and next to it the paths so far (estimated and true) over the room, at 15 fps, VP9 in WebM"""
    view = TopDown(world['room'], world['boxes'], world['kinds'], VIDEO_PANEL)
    panel_base = view.base()
    w = sensors.WIDTH * VIDEO_SCALE
    h = max(sensors.HEIGHT * VIDEO_SCALE, view.height)
    width = w + view.width
    width += width % 2
    h += h % 2
    # VP9 in WebM: every browser plays it, including the Chromium the docs are captured with (it has no H.264). One
    # thread and fixed settings: the same frames always encode to the same file.
    encoder = subprocess.Popen([
        'ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{width}x{h}',
        '-r', str(sensors.FPS), '-i', '-',
        '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '0',
        '-threads', '1', '-pix_fmt', 'yuv420p', str(path),
    ], stdin=subprocess.PIPE)
    try:
        for k, depth in enumerate(depth_frames):
            frame = Image.new('RGB', (width, h), BACKGROUND)
            camera = Image.fromarray(depth_image(depth)).resize((w, sensors.HEIGHT * VIDEO_SCALE), Image.NEAREST)
            frame.paste(camera, (0, (h - camera.height) // 2))
            panel = panel_base.copy()
            draw = ImageDraw.Draw(panel)
            view.path(draw, truth[:k + 1, :2, 3], TRUTH, 2)
            view.path(draw, estimate[:k + 1, :2, 3], NEW, 2)
            # the robot: where it thinks it is, and where it looks
            p = view.px(estimate[k, :2, 3])[0]
            heading = estimate[k, :2, 0]
            tip = view.px(estimate[k, :2, 3] + 0.8 * heading / max(np.linalg.norm(heading), 1e-9))[0]
            draw.line([tuple(p), tuple(tip)], fill=INK, width=2)
            draw.ellipse([p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4], fill=NEW, outline=INK)
            frame.paste(panel, (w, (h - panel.height) // 2))
            encoder.stdin.write(frame.tobytes())
    finally:
        encoder.stdin.close()
        if encoder.wait() != 0:
            raise RuntimeError('ffmpeg could not encode the video')


def error_plot(path, t, estimate, truth, closures, title):
    """Position error over time (after aligning the whole trajectory), and when loop closures happened"""
    errors = evaluate.position_errors(estimate, truth)
    data = [{
        'type': 'scatter', 'mode': 'lines', 'name': 'Position error',
        'x': [round(float(v), 3) for v in t], 'y': [round(float(v), 4) for v in errors],
        'line': {'color': '#c87619', 'width': 2},
    }]
    shapes = [{'type': 'line', 'xref': 'x', 'yref': 'paper', 'x0': float(t[c['frame']]), 'x1': float(t[c['frame']]),
               'y0': 0, 'y1': 1, 'line': {'color': '#238551', 'width': 1, 'dash': 'dot'}} for c in closures]
    layout = {
        'title': {'text': title, 'x': 0.01, 'xanchor': 'left', 'font': {'size': 14}},
        'xaxis': {'title': {'text': 'Time (s)'}},
        'yaxis': {'title': {'text': 'Error (m)'}, 'rangemode': 'tozero'},
        'shapes': shapes, 'height': 320, 'margin': {'l': 60, 'r': 20, 't': 50, 'b': 50},
    }
    if closures:
        # a legend entry for the dotted lines
        data.append({'type': 'scatter', 'mode': 'lines', 'name': f'Loop closures ({len(closures)})', 'x': [None],
                     'y': [None], 'line': {'color': '#238551', 'width': 1, 'dash': 'dot'}})
    path.write_text(json.dumps({'data': data, 'layout': layout}, separators=(',', ':')))


def map_points(keyframes, poses):
    """The keyframes' points (above the floor, under the ceiling) in the world frame, from these poses, voxelized"""
    clouds = []
    for kf, P in zip(keyframes, poses):
        pts = kf.points[(kf.points[:, 2] > -sensors.CAMERA_HEIGHT + 0.05) & (kf.points[:, 2] < 2.6 - sensors.CAMERA_HEIGHT)]
        clouds.append(G.apply(P, pts))
    cloud = np.vstack(clouds) if clouds else np.zeros((0, 3))
    keys = np.floor(cloud / MAP_VOXEL).astype(np.int64)
    _, first = np.unique(keys, axis=0, return_index=True)
    return cloud[np.sort(first)]


def map_png(path, points, estimate, truth, world, title):
    """The map seen from above: the true layout in gray, the mapped points and the estimated path in orange"""
    view = TopDown(world['room'], world['boxes'], world['kinds'], MAP_SIZE, margin=40)
    image = view.base()
    draw = ImageDraw.Draw(image)
    for x, y in view.px(points[:, :2]):
        draw.point((x, y), fill=NEW)
    view.path(draw, truth[:, :2, 3], TRUTH, 3)
    view.path(draw, estimate[:, :2, 3], NEW, 3)
    font = ImageFont.load_default(size=18)
    draw.text((40, 10), title, fill=INK, font=font)
    legend = [(TRUTH, 'true path'), (NEW, 'estimated path and map'), (SHELF, 'true layout')]
    x = 40
    y = image.height - 30
    for color, label in legend:
        draw.rectangle([x, y + 4, x + 14, y + 18], fill=color)
        draw.text((x + 20, y), label, fill=INK, font=font)
        x += 30 + int(draw.textlength(label, font=font))
    image.save(path, optimize=True)


def pcd(path, points):
    """ASCII PCD with x y z"""
    header = ['# .PCD v0.7', 'VERSION 0.7', 'FIELDS x y z', 'SIZE 4 4 4', 'TYPE F F F', 'COUNT 1 1 1',
              f'WIDTH {len(points)}', 'HEIGHT 1', 'VIEWPOINT 0 0 0 1 0 0 0', f'POINTS {len(points)}', 'DATA ascii']
    body = '\n'.join(f'{x:.3f} {y:.3f} {z:.3f}' for x, y, z in points)
    path.write_text('\n'.join(header) + '\n' + body + '\n')
