"""
The K3 camera module: from a scene (an sRGB image) to the 12-bit raw mosaic its sensor records.

Optics blur, RGGB Bayer mosaic, channel sensitivities, exposure and analog gain, shot and read noise, black level,
12-bit quantization. Integer math only (plus IEEE square roots, exact everywhere), so the raw is the same on every
machine: the hw-model platform's bit-exactness starts here.
"""
import hashlib
from dataclasses import dataclass

import numpy as np

BLACK_LEVEL = 64
WHITE_LEVEL = 4095
FULL_SCALE = WHITE_LEVEL - BLACK_LEVEL   # 4031 DN

# Configurations (`configs` in qa/batches.yaml): ISO settings. Auto-exposure keeps the image as bright,
# so a higher analog gain means proportionally fewer photons, and more noise.
CONFIGS = {
    'base':      {'iso': 100,   'gain': 1},
    'low-light': {'iso': 3200,  'gain': 32},
    'night':     {'iso': 12800, 'gain': 128},
}

FULL_WELL = 6000                       # electrons collected by a green pixel from a white scene at ISO 100
READ_NOISE = 2.5                       # electrons
SENSITIVITY_Q8 = (141, 256, 192)       # R, G, B response relative to green, /256 (white balance undoes it)
OPTICS_PSF_Q8 = (6, 58, 128, 58, 6)    # separable lens blur, /256: a Gaussian of sigma 0.8 px
NOISE_CELL = 512                       # noise is seeded per cell of this grid: tiled simulation gives the same raw

# sRGB 8-bit -> linear light, 16 bits
_v = np.arange(256) / 255
SRGB_TO_LINEAR = np.round(65535 * np.where(_v <= 0.04045, _v / 12.92, ((_v + 0.055) / 1.055) ** 2.4)).astype(np.int32)


@dataclass
class Raw:
    mosaic: np.ndarray   # (H, W) uint16, RGGB, 12 bits, black level 64
    iso: int
    gain: int


def cfa_channel(height, width, y0=0, x0=0):
    """The color each pixel of the RGGB mosaic sees: 0=R, 1=G, 2=B."""
    yy = (np.arange(y0, y0 + height) % 2)[:, None]
    xx = (np.arange(x0, x0 + width) % 2)[None, :]
    return (yy + xx).astype(np.uint8)


def blur_int(image, kernel_q8):
    """Separable integer convolution (kernel /256) on both axes, edges mirrored, rounded."""
    r = len(kernel_q8) // 2
    for axis in (0, 1):
        padded = np.pad(image, [(r, r) if a == axis else (0, 0) for a in range(image.ndim)], mode='reflect')
        n = image.shape[axis]
        out = np.zeros(image.shape, dtype=np.int32)
        for k, coefficient in enumerate(kernel_q8):
            out += coefficient * (padded[k:k + n] if axis == 0 else padded[:, k:k + n])
        image = (out + 128) >> 8
    return image


def seed_for(*keys):
    return int.from_bytes(hashlib.sha256(':'.join(str(k) for k in keys).encode()).digest()[:8], 'little')


def unit_gaussian_q15(shape, seed):
    """Samples of a unit Gaussian, times 2^15, as integers (a sum of 3 uniforms): the same on every machine."""
    u = np.random.Generator(np.random.PCG64(seed)).integers(0, 65536, size=(3, *shape), dtype=np.int32)
    return u[0] + u[1] + u[2] - 98302


def capture(scene, config='base', seed_key='', y0=0, x0=0, margin=0):
    """
    Simulates the sensor on an 8-bit sRGB scene (H, W, 3).
    To simulate a big frame in tiles: (y0, x0) is where the tile starts in the frame, and the scene has `margin`
    extra pixels on each side, used by the optics blur only.
    """
    gain = CONFIGS[config]['gain']
    linear = blur_int(SRGB_TO_LINEAR[scene], OPTICS_PSF_Q8)
    if margin:
        linear = linear[margin:-margin, margin:-margin]
    height, width = linear.shape[:2]
    channel = cfa_channel(height, width, y0, x0)
    sensed = np.where(channel == 0, linear[..., 0], np.where(channel == 1, linear[..., 1], linear[..., 2]))
    sensitivity = np.array(SENSITIVITY_Q8, dtype=np.int64)[channel]
    mean_dn = (sensed * sensitivity * FULL_SCALE + (1 << 23)) >> 24

    # Shot noise (Poisson) and read noise, as one Gaussian of the same variance: signal * k + read^2
    dn_per_electron = gain * FULL_SCALE / FULL_WELL
    k_q8 = round(dn_per_electron * 256)
    read_q8 = round((READ_NOISE * dn_per_electron) ** 2 * 256)
    sigma_q4 = np.sqrt((mean_dn * k_q8 + read_q8).astype(np.float64)).astype(np.int64)
    z = np.empty((height, width), dtype=np.int64)
    for cy in range(y0 - y0 % NOISE_CELL, y0 + height, NOISE_CELL):
        for cx in range(x0 - x0 % NOISE_CELL, x0 + width, NOISE_CELL):
            cell = unit_gaussian_q15((NOISE_CELL, NOISE_CELL), seed_for(seed_key, config, cy, cx))
            ty, tx = max(cy, y0), max(cx, x0)
            by, bx = min(cy + NOISE_CELL, y0 + height), min(cx + NOISE_CELL, x0 + width)
            z[ty - y0:by - y0, tx - x0:bx - x0] = cell[ty - cy:by - cy, tx - cx:bx - cx]
    noise = (sigma_q4 * z + (1 << 18)) >> 19
    mosaic = np.clip(mean_dn + noise + BLACK_LEVEL, 0, WHITE_LEVEL).astype(np.uint16)
    return Raw(mosaic=mosaic, iso=CONFIGS[config]['iso'], gain=gain)
