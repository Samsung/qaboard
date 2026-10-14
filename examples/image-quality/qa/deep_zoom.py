"""
The 113 MP test wall: the camera and the ISP run in tiles of `tile_size` (from the flags) on a pool of 4 processes,
and the output is saved as a tiled, multi-resolution TIFF (out.tiff), that the IIIF server can stream without decoding
the whole image. With `tile_size: 0`, the whole frame is processed at once, in one process: it needs well over 3 GB.

Tiles overlap by isp.MARGIN pixels, and the noise is seeded per cell of a fixed grid, so the output doesn't depend on
the tile size.
"""
import os
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import tifffile

import camera
import isp
import measures

WORKERS = 4
OPTICS = len(camera.OPTICS_PSF_Q8) // 2   # pixels of scene around the raw, for the lens blur
SSIM_MARGIN = 8


def read_scene(path, y0, y1, x0, x1):
    """scene[y0:y1, x0:x1], mirrored outside of the frame like np.pad(mode='reflect')."""
    scene = tifffile.memmap(path, mode='r')
    height, width = scene.shape[:2]
    rows = np.abs(np.arange(y0, y1))
    rows = np.where(rows >= height, 2 * (height - 1) - rows, rows)
    cols = np.abs(np.arange(x0, x1))
    cols = np.where(cols >= width, 2 * (width - 1) - cols, cols)
    block = np.asarray(scene[rows.min():rows.max() + 1, cols.min():cols.max() + 1])
    return block[rows - rows.min()][:, cols - cols.min()]


def process_tile(path, y0, x0, h, w, config, flags, seed_key):
    """One tile: the output, and the sums for PSNR and SSIM."""
    height, width = tifffile.memmap(path, mode='r').shape[:2]
    m = isp.MARGIN
    # the raw of the tile and its margin, inside the frame
    ry0, rx0, ry1, rx1 = max(0, y0 - m), max(0, x0 - m), min(height, y0 + h + m), min(width, x0 + w + m)
    scene = read_scene(path, ry0 - OPTICS, ry1 + OPTICS, rx0 - OPTICS, rx1 + OPTICS)
    raw = camera.capture(scene, config, seed_key, y0=ry0, x0=rx0, margin=OPTICS)
    # outside of the frame, the raw is mirrored, as when the whole frame is processed
    pad = ((m - (y0 - ry0), m - (ry1 - y0 - h)), (m - (x0 - rx0), m - (rx1 - x0 - w)))
    mosaic = np.pad(raw.mosaic, pad, mode='reflect')
    output = isp.process(mosaic, raw.gain, flags, all_stages=False)[5]

    # measures against the ideal output, the SSIM with some context around the tile
    s = SSIM_MARGIN
    context = read_scene(path, y0 - s, y0 + h + s, x0 - s, x0 + w + s)
    reference = isp.display(isp.tone_curve(camera.SRGB_TO_LINEAR[context] / 65535, flags['tone_curve']))
    out_context = output[m - s:m + h + s, m - s:m + w + s]
    tile = output[m:m + h, m:m + w]
    error = tile.astype(np.float64) - reference[s:-s, s:-s]
    ssim = measures.ssim_map(out_context, reference)[s:-s, s:-s]
    return y0, x0, tile, float(np.sum(error ** 2)), float(np.sum(ssim))


def whole_frame(path, config, flags, seed_key):
    """No tiles: the whole frame at once."""
    scene = tifffile.memmap(path, mode='r')
    raw = camera.capture(np.asarray(scene), config, seed_key)
    m = isp.MARGIN
    output = isp.process(np.pad(raw.mosaic, m, mode='reflect'), raw.gain, flags, all_stages=False)[5][m:-m, m:-m]
    reference = isp.display(isp.tone_curve(camera.SRGB_TO_LINEAR[scene] / 65535, flags['tone_curve']))
    return output, float(np.sum((output.astype(np.float64) - reference) ** 2)), float(np.sum(measures.ssim_map(output, reference)))


def downsample(image):
    h, w = image.shape[0] // 2 * 2, image.shape[1] // 2 * 2
    i = image[:h, :w].astype(np.uint16)
    return ((i[0::2, 0::2] + i[1::2, 0::2] + i[0::2, 1::2] + i[1::2, 1::2] + 2) // 4).astype(np.uint8)


def write_pyramid(path, image, tile=256, layout='pages'):
    """Tiled TIFF, JPEG-compressed (quality 90), full resolution then each level at half the size, down to one tile.
    layout='pages': each level in its own IFD (page), 'subifds': the levels in SubIFDs of the first page.
    Cantaloupe 5's TIFF reader uses the levels in successive IFDs, and ignores SubIFDs: 'pages' it is."""
    levels = [image]
    while max(levels[-1].shape[:2]) > tile:
        levels.append(downsample(levels[-1]))
    # photometric='rgb': tifffile converts the RGB pixels and stores YCbCr JPEG tiles. With 'ycbcr' it would take the
    # pixels as YCbCr already, and every reader would show false colors (magenta and green)
    options = dict(tile=(tile, tile), compression='jpeg', compressionargs={'level': 90}, photometric='rgb', maxworkers=WORKERS)
    with tifffile.TiffWriter(path) as tiff:
        tiff.write(levels[0], subifds=len(levels) - 1 if layout == 'subifds' else None, **options)
        for level in levels[1:]:
            tiff.write(level, subfiletype=1, **options)   # 1: reduced-resolution version


def run(path, output_dir, config, flags, seed_key, start):
    height, width = tifffile.memmap(path, mode='r').shape[:2]
    tile_size = int(flags['tile_size'])
    print(f'K3 camera: {path.name}, {width}x{height} ({width * height / 1e6:.0f} MP), ISO {camera.CONFIGS[config]["iso"]}')
    if not tile_size:
        print('ISP on the whole frame at once')
        output, sse, ssim_sum = whole_frame(path, config, flags, seed_key)
    else:
        tiles = [(y, x, min(tile_size, height - y), min(tile_size, width - x))
                 for y in range(0, height, tile_size) for x in range(0, width, tile_size)]
        print(f'ISP in {len(tiles)} tiles of {tile_size}x{tile_size} on {WORKERS} processes')
        output = np.empty((height, width, 3), dtype=np.uint8)
        sse = ssim_sum = 0
        with ProcessPoolExecutor(WORKERS) as pool:
            jobs = [pool.submit(process_tile, path, y, x, h, w, config, flags, seed_key) for y, x, h, w in tiles]
            for done, job in enumerate(jobs, 1):
                y, x, tile, tile_sse, tile_ssim = job.result()
                output[y:y + tile.shape[0], x:x + tile.shape[1]] = tile
                sse += tile_sse
                ssim_sum += tile_ssim
                if done % 48 == 0 or done == len(jobs):
                    print(f'  {done}/{len(jobs)} tiles, {time.time() - start:.0f}s')
    write_pyramid(output_dir / 'out.tiff', output)
    print(f'Saved out.tiff: tiled, multi-resolution, {os.path.getsize(output_dir / "out.tiff") / 1e6:.0f} MB')
    pixels = height * width
    metrics = {
        'psnr': float(10 * np.log10(255 ** 2 / (sse / (3 * pixels)))),
        'ssim': ssim_sum / pixels,
        'runtime': time.time() - start,
    }
    print(' | '.join(f'{k} {v:.4g}' for k, v in metrics.items()))
    return {**metrics, 'is_failed': False}
