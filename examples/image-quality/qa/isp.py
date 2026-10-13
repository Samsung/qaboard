"""
The ISP in floating point (the `linux` platform): raw mosaic -> displayable sRGB image, in 5 stages.

Stages 3 and 4 work on companded values (square roots of linear light: the sensor noise there has about the same
amplitude in shadows and highlights), in luma and chroma: Y = (R + 2G + B) / 4, C1 = R - G, C2 = B - G.
"""
import time

import numpy as np
from scipy import ndimage

from camera import BLACK_LEVEL, FULL_SCALE, SENSITIVITY_Q8, cfa_channel

WB_GAINS = np.array([256 / s for s in SENSITIVITY_Q8], dtype=np.float32)
MARGIN = 32   # how far, in pixels, an output pixel's value depends on the raw: tiles overlap that much

# Tuning, in units of the noise profile's sigma where it applies
GAUSSIAN_SIGMA = (0.6, 4)           # spatial sigma = strength * (a + b * noise)
BILATERAL_SIGMA = (1.0, 0.6, 2.0)   # spatial sigma = a + b * strength, range sigma = c * strength * noise
SHARPEN_RADIUS = 1.4                # sigma of the blur the details are measured against
SHARPEN_AMOUNT = 0.42               # per unit of detail_boost
SHARPEN_CORING = 0.2                # details smaller than this many noise sigmas are left alone
CLAMP_MARGIN = 0.1                  # overshoot allowed by the clamp, share of the local range


def noise_sigma(gain):
    """The noise profile, from calibration: noise of the companded luma after demosaicing, at a given analog gain."""
    return np.sqrt(3.45e-5 * gain + 2.64e-7 * gain ** 2)


def srgb(linear):
    """sRGB transfer function, linear light in [0, 1] -> display value in [0, 1]."""
    linear = np.clip(linear, 0, 1)
    return np.where(linear <= 0.0031308, 12.92 * linear, 1.055 * np.power(linear, 1 / 2.4) - 0.055)


SRGB_8BIT = np.round(srgb(np.arange(65536) / 65535) * 255).astype(np.uint8)


def display(linear):
    """Linear light -> 8-bit sRGB, to look at the stages."""
    return SRGB_8BIT[np.clip(linear * 65535 + 0.5, 0, 65535).astype(np.uint16)]


# 1. Black level and white balance
def black_level_white_balance(mosaic):
    channel = cfa_channel(*mosaic.shape)
    return (mosaic.astype(np.float32) - BLACK_LEVEL) * (WB_GAINS / FULL_SCALE)[channel]


def false_color(cfa):
    """The raw mosaic, each pixel in the color it sees."""
    channel = cfa_channel(*cfa.shape)
    rgb = np.zeros((*cfa.shape, 3), dtype=cfa.dtype)
    for c in range(3):
        rgb[..., c] = np.where(channel == c, cfa, 0)
    return rgb


# 2. Demosaic
BILINEAR_G = np.array([[0, 1, 0], [1, 4, 1], [0, 1, 0]], dtype=np.float32) / 4
BILINEAR_RB = np.array([[1, 2, 1], [2, 4, 2], [1, 2, 1]], dtype=np.float32) / 4


def demosaic(cfa, method):
    channel = cfa_channel(*cfa.shape)
    if method == 'bilinear':
        green = ndimage.convolve(np.where(channel == 1, cfa, 0), BILINEAR_G, mode='mirror')
    elif method == 'hamilton-adams':
        # Green at red and blue pixels: interpolate along the direction with the smallest gradient,
        # corrected by the second derivative of the pixel's own color.
        h, w = cfa.shape
        p = np.pad(cfa, 2, mode='reflect')
        at = lambda dy, dx: p[2 + dy:2 + dy + h, 2 + dx:2 + dx + w]
        laplacian_h = 2 * cfa - at(0, -2) - at(0, 2)
        laplacian_v = 2 * cfa - at(-2, 0) - at(2, 0)
        green_h = (at(0, -1) + at(0, 1)) / 2 + laplacian_h / 4
        green_v = (at(-1, 0) + at(1, 0)) / 2 + laplacian_v / 4
        gradient_h = np.abs(at(0, -1) - at(0, 1)) + np.abs(laplacian_h)
        gradient_v = np.abs(at(-1, 0) - at(1, 0)) + np.abs(laplacian_v)
        green = np.where(gradient_h < gradient_v, green_h, np.where(gradient_v < gradient_h, green_v, (green_h + green_v) / 2))
        green = np.where(channel == 1, cfa, green)
    else:
        raise ValueError(f'unknown demosaic: {method}')
    rgb = np.empty((*cfa.shape, 3), dtype=np.float32)
    rgb[..., 1] = green
    for c in (0, 2):
        if method == 'bilinear':
            rgb[..., c] = ndimage.convolve(np.where(channel == c, cfa, 0), BILINEAR_RB, mode='mirror')
        else:  # interpolate the difference with green, smoother than the color itself
            rgb[..., c] = green + ndimage.convolve(np.where(channel == c, cfa - green, 0), BILINEAR_RB, mode='mirror')
    return rgb


# 3. Denoise
def to_luma_chroma(rgb):
    r, g, b = (np.sqrt(np.maximum(rgb[..., c], 0)) for c in range(3))
    return (r + 2 * g + b) / 4, r - g, b - g


def to_rgb(y, c1, c2):
    rgb = np.empty((*y.shape, 3), dtype=np.float32)
    g = y - (c1 + c2) / 4
    for c, companded in enumerate((g + c1, g, g + c2)):
        rgb[..., c] = np.square(np.maximum(companded, 0))
    return rgb


def bilateral(y, chroma, sigma_s, sigma_r, radius=3):
    """Cross-bilateral filter: weights from the luma (distance, and difference of values), applied to luma and chroma."""
    h, w = y.shape
    padded = [np.pad(c, radius, mode='reflect') for c in (y, *chroma)]
    sums = [c.copy() for c in (y, *chroma)]
    total = np.ones_like(y)
    weight = np.empty_like(y)
    scale = np.float32(-0.5 / sigma_r ** 2)
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dy == dx == 0:
                continue
            neighbors = [p[radius + dy:radius + dy + h, radius + dx:radius + dx + w] for p in padded]
            np.subtract(neighbors[0], y, out=weight)
            np.square(weight, out=weight)
            weight *= scale
            np.exp(weight, out=weight)
            weight *= np.float32(np.exp(-(dx * dx + dy * dy) / (2 * sigma_s ** 2)))
            total += weight
            for s, n in zip(sums, neighbors):
                s += weight * n
    return [s / total for s in sums]


def denoise(y, c1, c2, method, strength, gain, chroma_low_light=False):
    sigma = noise_sigma(gain)
    if method == 'gaussian':
        sigma_s = strength * (GAUSSIAN_SIGMA[0] + GAUSSIAN_SIGMA[1] * sigma)
        y = ndimage.gaussian_filter(y, sigma_s, mode='mirror')
        c1, c2 = (ndimage.gaussian_filter(c, 2 * sigma_s, mode='mirror') for c in (c1, c2))
    elif method == 'bilateral':
        a, b, c = BILATERAL_SIGMA
        y, c1, c2 = bilateral(y, (c1, c2), sigma_s=a + b * strength, sigma_r=c * strength * sigma)
    else:
        raise ValueError(f'unknown denoise: {method}')
    if chroma_low_light and gain >= 16:
        c1, c2 = (ndimage.gaussian_filter(c, 2.0, mode='mirror') for c in (c1, c2))
    return y, c1, c2


# 4. Sharpen
def sharpen(y, detail_boost, gain, clamp):
    detail = y - ndimage.gaussian_filter(y, SHARPEN_RADIUS, mode='mirror')
    coring = SHARPEN_CORING * noise_sigma(gain)   # don't amplify what is likely noise
    detail = np.sign(detail) * np.maximum(np.abs(detail) - coring, 0)
    sharpened = y + SHARPEN_AMOUNT * detail_boost * detail
    if clamp == 'local-contrast':
        # stay within the range of the neighbors: no halos
        low = ndimage.minimum_filter(y, 3, mode='mirror')
        high = ndimage.maximum_filter(y, 3, mode='mirror')
        margin = CLAMP_MARGIN * (high - low)
        sharpened = np.clip(sharpened, low - margin, high + margin)
    elif clamp != 'none':
        raise ValueError(f'unknown sharpen_clamp: {clamp}')
    return sharpened


# 5. Tone map
def tone_curve(linear, curve):
    """Linear light -> display-referred linear light in [0, 1], before the sRGB encoding."""
    if curve == 'gamma':
        return linear
    if curve == 'filmic':
        # brighter mid-tones, and highlights that roll off instead of clipping
        x = 1.5 * np.maximum(linear, 0)
        return x * (1 + x / 1.6 ** 2) / (1 + x)
    raise ValueError(f'unknown tone_curve: {curve}')


class Stopwatch:
    def __init__(self, log):
        self.log, self.last = log, time.time()

    def __call__(self, step):
        if self.log:
            self.log(f'  {step:<32} {1000 * (time.time() - self.last):5.0f} ms')
        self.last = time.time()


def process(mosaic, gain, flags, log=None, all_stages=True):
    """The 5 stages on a raw mosaic (starting with a red pixel). Returns each stage as an 8-bit sRGB image; the 5th is
    the output."""
    lap = Stopwatch(log)
    stages = {}
    cfa = black_level_white_balance(mosaic)
    if all_stages:
        stages[1] = display(false_color(cfa))
    lap('1 black level, white balance')
    rgb = demosaic(cfa, flags['demosaic'])
    if all_stages:
        stages[2] = display(rgb)
    lap('2 demosaic')
    y, c1, c2 = to_luma_chroma(rgb)
    del rgb
    y, c1, c2 = denoise(y, c1, c2, flags['denoise'], flags['denoise_strength'], gain, flags['chroma_denoise_low_light'])
    if all_stages:
        stages[3] = display(to_rgb(y, c1, c2))
    lap('3 denoise')
    y = sharpen(y, flags['detail_boost'], gain, flags['sharpen_clamp'])
    linear = to_rgb(y, c1, c2)
    if all_stages:
        stages[4] = display(linear)
    lap('4 sharpen')
    stages[5] = display(tone_curve(linear, flags['tone_curve']))
    lap('5 tone map')
    return stages
