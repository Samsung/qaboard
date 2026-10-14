"""
The ISP as the camera chip computes it (the `hw-model` platform): the stages of isp.py in integer math.

12-bit input, 16-bit buffers between stages (linear light in Q14: 1.0 is 16384), Q-format coefficients, LUTs for the
square root, the bilateral weights and the tone curve, a configurable rounding mode. Integers make every output
bit-exact across machines. A 256x256 window of each stage's buffer is saved in raw/<stage>.u16 (the window is in
regs.txt), and the registers in regs.txt.
"""
import numpy as np
from scipy import ndimage

import isp
from camera import BLACK_LEVEL, FULL_SCALE, cfa_channel

ONE = 1 << 14   # 1.0 in Q14
TONE_SEGMENTS = 9         # the tone LUT has 9 linear segments (10 entries) over companded values 0..2
DIVIDER_BITS = 6          # the bilateral filter's divider takes a 6-bit divisor, plus the guard bits
RANGE_STEPS = 1           # the bilateral range LUT has 1 entry per sigma and 4-bit weights, more with guard bits
RANGE_WEIGHT_BITS = 4
ROUNDING = {'truncate': 0, 'half-up': 1, 'half-even': 2}
DUMP_SIZE = 256           # the stage buffers are dumped in a window of 256x256 pixels at the center of the frame


def round_shift(x, bits, mode):
    """x / 2^bits, rounded as the chip does."""
    if mode == 'truncate':
        return x >> bits
    half = 1 << (bits - 1)
    if mode == 'half-up':
        return (x + half) >> bits
    if mode == 'half-even':
        q = x >> bits
        r = x - (q << bits)
        return q + (r > half) + ((r == half) & (q & 1))
    raise ValueError(f'unknown fxp_rounding: {mode}')


def gaussian_taps(sigma, bits=8, max_radius=8):
    """A Gaussian kernel with integer taps summing to 2^bits (the center tap absorbs the rounding)."""
    radius = min(max_radius, max(1, int(np.ceil(3 * sigma))))
    x = np.arange(-radius, radius + 1)
    weights = np.exp(-x ** 2 / (2 * sigma ** 2))
    taps = np.round(weights / weights.sum() * (1 << bits)).astype(np.int64)
    taps[radius] += (1 << bits) - taps.sum()
    return taps


def convolve_separable(image, taps, bits=8):
    """Integer separable convolution, edges mirrored, rounded half up after each pass."""
    for axis in (0, 1):
        image = ndimage.correlate1d(image, taps, axis=axis, mode='mirror', output=np.int64)
        image = (image + (1 << (bits - 1))) >> bits
    return image


class Registers(dict):
    """The values the chip is programmed with, written to regs.txt."""
    def text(self):
        lines = ['# K3 ISP registers (hw-model). raw/<stage>.u16: DUMP_WINDOW (x y width height) of each stage\'s buffer,',
                 '# little-endian uint16, row by row; stage 1 has one value per pixel (RGGB mosaic), the others R, G, B']
        for name, value in self.items():
            if isinstance(value, (list, tuple, np.ndarray)):
                value = ' '.join(str(int(v)) for v in value)
            lines.append(f'{name:<24} {value}')
        return '\n'.join(lines) + '\n'


def program(flags, gain):
    """Computes the register values for a configuration (what the camera driver does)."""
    regs = Registers()
    regs['BLC_LEVEL'] = BLACK_LEVEL
    for name, wb in zip('RGB', isp.WB_GAINS):
        regs[f'WB_GAIN_{name}_Q10'] = int(round(wb * ONE / FULL_SCALE * 1024))
    regs['DEMOSAIC_MODE'] = {'bilinear': 0, 'hamilton-adams': 1}[flags['demosaic']]
    sigma = isp.noise_sigma(gain)
    strength = flags['denoise_strength']
    regs['DENOISE_MODE'] = {'gaussian': 0, 'bilateral': 1}[flags['denoise']]
    if flags['denoise'] == 'gaussian':
        sigma_s = strength * (isp.GAUSSIAN_SIGMA[0] + isp.GAUSSIAN_SIGMA[1] * sigma)
        regs['DENOISE_LUMA_TAPS'] = gaussian_taps(sigma_s)
        regs['DENOISE_CHROMA_TAPS'] = gaussian_taps(2 * sigma_s)
    else:
        a, b, c = isp.BILATERAL_SIGMA
        sigma_s, sigma_r = a + b * strength, c * strength * sigma
        guard_bits = int(flags['fxp_bilateral_guard_bits'])
        d2 = np.add.outer(np.arange(-3, 4) ** 2, np.arange(-3, 4) ** 2)
        regs['BILATERAL_SPATIAL_Q8'] = np.round(256 * np.exp(-d2 / (2 * sigma_s ** 2))).astype(int).ravel()
        # range weights, looked up by |difference| up to 4 sigmas, finer with guard bits
        step = sigma_r / (RANGE_STEPS << guard_bits)
        regs['BILATERAL_GUARD_BITS'] = guard_bits
        regs['BILATERAL_RANGE_SCALE'] = int(round((1 << 16) / (step * ONE)))   # index = |d| * scale >> 16
        x = np.arange(4 * RANGE_STEPS << guard_bits) * step / sigma_r
        regs['BILATERAL_RANGE_LUT'] = np.round(np.exp(-x ** 2 / 2) * (1 << (RANGE_WEIGHT_BITS + guard_bits))).astype(int)
    regs['CHROMA_LOW_LIGHT'] = int(bool(flags.get('chroma_denoise_low_light')) and gain >= 16)
    regs['CHROMA_LOW_LIGHT_TAPS'] = gaussian_taps(2.0)
    regs['SHARPEN_TAPS'] = gaussian_taps(isp.SHARPEN_RADIUS)
    regs['SHARPEN_CORING'] = int(round(isp.SHARPEN_CORING * sigma * ONE))
    regs['SHARPEN_GAIN_Q6'] = int(round(isp.SHARPEN_AMOUNT * flags['detail_boost'] * 64))
    regs['SHARPEN_CLAMP'] = {'none': 0, 'local-contrast': 1}[flags['sharpen_clamp']]
    regs['SHARPEN_CLAMP_MARGIN_Q8'] = int(round(isp.CLAMP_MARGIN * 256))
    regs['ROUNDING'] = ROUNDING[flags['fxp_rounding']]
    # tone curve and sRGB encoding, on companded values (0..2), 8-bit output with 4 fractional bits
    companded = np.arange(TONE_SEGMENTS + 1) * 2 / TONE_SEGMENTS
    regs['TONE_LUT_Q4'] = np.round(16 * 255 * isp.srgb(isp.tone_curve(companded ** 2, flags['tone_curve']))).astype(int)
    return regs


SQRT_LUT = np.round(np.sqrt(np.arange(1 << 16) * ONE)).astype(np.int64)   # Q14 linear -> Q14 companded
SRGB_LUT = isp.SRGB_8BIT[np.minimum(np.arange(1 << 16) * 4, 65535)]       # Q14 linear -> 8-bit sRGB, to look at stages


def to_u16(x):
    return np.clip(x, 0, 65535).astype(np.uint16)


def to_linear(y, c1, c2):
    g = y - ((c1 + c2 + 2) >> 2)
    companded = np.stack([g + c1, g, g + c2], axis=-1)
    return to_u16((np.square(np.maximum(companded, 0)) + (ONE >> 1)) >> 14), companded


def bilateral(y, c1, c2, regs):
    h, w = y.shape
    spatial = regs['BILATERAL_SPATIAL_Q8'].reshape(7, 7).astype(np.int32)
    lut = np.asarray(regs['BILATERAL_RANGE_LUT'], dtype=np.int32)
    scale = np.int32(regs['BILATERAL_RANGE_SCALE'])
    padded = [np.pad(c.astype(np.int32), 3, mode='reflect') for c in (y, c1, c2)]
    center = int(spatial[3, 3]) * int(lut[0])
    sums = [center * c.astype(np.int64) for c in (y, c1, c2)]
    total = np.full(y.shape, center, dtype=np.int64)
    for dy in range(-3, 4):
        for dx in range(-3, 4):
            if dy == dx == 0:
                continue
            neighbors = [p[3 + dy:3 + dy + h, 3 + dx:3 + dx + w] for p in padded]
            index = np.minimum((np.abs(neighbors[0] - padded[0][3:3 + h, 3:3 + w]) * scale) >> 16, len(lut) - 1)
            weight = spatial[3 + dy, 3 + dx] * lut[index]   # 16 bits at most
            total += weight
            for s, n in zip(sums, neighbors):
                s += weight * n   # 31 bits at most, summed in 64
    # normalization: the divider takes a (6 + guard bits)-bit divisor, so the sums are scaled down before dividing
    shift = np.maximum(np.frexp(total.astype(np.float64))[1] - (DIVIDER_BITS + regs['BILATERAL_GUARD_BITS']), 0)
    divisor = (total + (np.left_shift(1, shift) >> 1)) >> shift
    return [((s >> shift) + (divisor >> 1)) // divisor for s in sums]


def process(mosaic, gain, flags):
    """The 5 stages, in integers. Returns 8-bit images of the stages (the 5th is the output), their 16-bit buffers,
    and the registers."""
    regs = program(flags, gain)
    rounding = flags['fxp_rounding']
    channel = cfa_channel(*mosaic.shape)
    buffers, stages = {}, {}

    # 1. black level and white balance
    wb = np.array([regs['WB_GAIN_R_Q10'], regs['WB_GAIN_G_Q10'], regs['WB_GAIN_B_Q10']], dtype=np.int64)
    cfa = (np.maximum(mosaic.astype(np.int64) - BLACK_LEVEL, 0) * wb[channel] + 512) >> 10
    buffers[1] = to_u16(cfa)
    stages[1] = np.stack([np.where(channel == c, SRGB_LUT[buffers[1]], 0) for c in range(3)], axis=-1).astype(np.uint8)

    # 2. demosaic
    h, w = cfa.shape
    if regs['DEMOSAIC_MODE'] == 0:
        green = (ndimage.correlate(np.where(channel == 1, cfa, 0), np.array([[0, 1, 0], [1, 4, 1], [0, 1, 0]]), mode='mirror', output=np.int64) + 2) >> 2
    else:
        p = np.pad(cfa, 2, mode='reflect')
        at = lambda dy, dx: p[2 + dy:2 + dy + h, 2 + dx:2 + dx + w]
        laplacian_h = 2 * cfa - at(0, -2) - at(0, 2)
        laplacian_v = 2 * cfa - at(-2, 0) - at(2, 0)
        green_h = (2 * (at(0, -1) + at(0, 1)) + laplacian_h + 2) >> 2
        green_v = (2 * (at(-1, 0) + at(1, 0)) + laplacian_v + 2) >> 2
        gradient_h = np.abs(at(0, -1) - at(0, 1)) + np.abs(laplacian_h)
        gradient_v = np.abs(at(-1, 0) - at(1, 0)) + np.abs(laplacian_v)
        green = np.where(gradient_h < gradient_v, green_h, np.where(gradient_v < gradient_h, green_v, (green_h + green_v + 1) >> 1))
        green = np.where(channel == 1, cfa, green)
    rgb = np.empty((h, w, 3), dtype=np.int64)
    rgb[..., 1] = green
    kernel = np.array([[1, 2, 1], [2, 4, 2], [1, 2, 1]])
    for c in (0, 2):
        if regs['DEMOSAIC_MODE'] == 0:
            rgb[..., c] = (ndimage.correlate(np.where(channel == c, cfa, 0), kernel, mode='mirror', output=np.int64) + 2) >> 2
        else:
            difference = ndimage.correlate(np.where(channel == c, cfa - green, 0), kernel, mode='mirror', output=np.int64)
            rgb[..., c] = green + ((difference + 2) >> 2)
    buffers[2] = to_u16(rgb)
    stages[2] = SRGB_LUT[buffers[2]]

    # 3. denoise, on companded luma and chroma
    r, g, b = (SQRT_LUT[buffers[2][..., c]] for c in range(3))
    y, c1, c2 = (r + 2 * g + b + 2) >> 2, r - g, b - g
    if regs['DENOISE_MODE'] == 0:
        y = convolve_separable(y, regs['DENOISE_LUMA_TAPS'])
        c1, c2 = (convolve_separable(c, regs['DENOISE_CHROMA_TAPS']) for c in (c1, c2))
    else:
        y, c1, c2 = bilateral(y, c1, c2, regs)
    if regs['CHROMA_LOW_LIGHT']:
        c1, c2 = (convolve_separable(c, regs['CHROMA_LOW_LIGHT_TAPS']) for c in (c1, c2))
    buffers[3], _ = to_linear(y, c1, c2)
    stages[3] = SRGB_LUT[buffers[3]]

    # 4. sharpen
    detail = y - convolve_separable(y, regs['SHARPEN_TAPS'])
    detail = np.sign(detail) * np.maximum(np.abs(detail) - regs['SHARPEN_CORING'], 0)
    sharpened = y + round_shift(regs['SHARPEN_GAIN_Q6'] * detail, 6, rounding)
    if regs['SHARPEN_CLAMP']:
        low = ndimage.minimum_filter(y, 3, mode='mirror')
        high = ndimage.maximum_filter(y, 3, mode='mirror')
        margin = ((high - low) * regs['SHARPEN_CLAMP_MARGIN_Q8'] + 128) >> 8
        sharpened = np.clip(sharpened, low - margin, high + margin)
    buffers[4], companded = to_linear(sharpened, c1, c2)
    stages[4] = SRGB_LUT[buffers[4]]

    # 5. tone curve, by linear interpolation in a LUT indexed by companded values
    lut = np.asarray(regs['TONE_LUT_Q4'], dtype=np.int64)
    companded = np.clip(companded, 0, 2 * ONE - 1)
    position = companded * TONE_SEGMENTS   # 15 fractional bits
    index, fraction = position >> 15, position & 32767
    tone_q4 = lut[index] * (32768 - fraction) + lut[index + 1] * fraction   # 4 + 15 fractional bits
    buffers[5] = to_u16(round_shift(tone_q4, 15, rounding))
    stages[5] = np.clip(round_shift(tone_q4, 19, rounding), 0, 255).astype(np.uint8)
    # like the chip's debug port, dump a window of each buffer
    y0, x0 = (np.array(mosaic.shape[:2]) - DUMP_SIZE) // 4 * 2   # even: starts on a red pixel
    regs['DUMP_WINDOW'] = [x0, y0, DUMP_SIZE, DUMP_SIZE]
    buffers = {stage: buffer[y0:y0 + DUMP_SIZE, x0:x0 + DUMP_SIZE] for stage, buffer in buffers.items()}
    return stages, buffers, regs
