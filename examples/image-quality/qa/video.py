"""
Videos: what the K3 camera records while the robot drives. An input clips/<name>.yaml says which photo the camera
looks at and how it moves across it. Each frame goes through the camera (new noise every frame) and the ISP, like a
photo, and the output is out.webm. QA-Board plays it in sync with the reference's, to compare them frame by frame.

VP9 in WebM: every browser plays it, including the Chromium the docs are captured with (it has no H.264). One thread
and fixed settings: the same frames always encode to the same file.
"""
import subprocess

import numpy as np
import yaml
from PIL import Image

import camera
import isp
import measures


def views(scene, clip):
    """The part of the scene the camera sees at each frame: a window moving from `from` to `to`, easing in and out."""
    width, height = clip['size']
    (x0, y0), (x1, y1) = clip['from'], clip['to']
    for i in range(clip['frames']):
        t = i / (clip['frames'] - 1)
        t = t * t * (3 - 2 * t)
        x, y = round(x0 + (x1 - x0) * t), round(y0 + (y1 - y0) * t)
        yield np.ascontiguousarray(scene[y:y + height, x:x + width])


def run(input_path, database, output_dir, config, flags, seed_key):
    clip = yaml.safe_load(input_path.read_text())
    scene = np.asarray(Image.open(database / clip['photo']).convert('RGB'))
    width, height = clip['size']
    print(f"K3 camera: {clip['frames']} frames of {width}x{height} at {clip['fps']} fps, across {clip['photo']}")
    encoder = subprocess.Popen([
        'ffmpeg', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{width}x{height}',
        '-r', str(clip['fps']), '-i', '-',
        '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '0',
        '-threads', '1', '-pix_fmt', 'yuv420p', str(output_dir / 'out.webm'),
    ], stdin=subprocess.PIPE)
    psnr = []
    for i, view in enumerate(views(scene, clip)):
        raw = camera.capture(view, config, f'{seed_key}:{i}')
        output = isp.process(raw.mosaic, raw.gain, flags, all_stages=False)[5]
        ideal = isp.display(isp.tone_curve(camera.SRGB_TO_LINEAR[view] / 65535, flags['tone_curve']))
        psnr.append(measures.psnr(output, ideal))
        encoder.stdin.write(output.tobytes())
    encoder.stdin.close()
    if encoder.wait() != 0:
        raise RuntimeError('ffmpeg could not encode the video')
    return {'psnr': float(np.mean(psnr))}
