"""
Image quality measures: PSNR, SSIM, slanted-edge MTF and overshoot, noise in flat patches, CIEDE2000 color error.
Images are 8-bit sRGB arrays (H, W, 3).
"""
import numpy as np
from scipy import ndimage


def luma(image):
    image = np.asarray(image, dtype=np.float64)
    return 0.299 * image[..., 0] + 0.587 * image[..., 1] + 0.114 * image[..., 2]


def psnr(image, reference):
    mse = np.mean((image.astype(np.float64) - reference.astype(np.float64)) ** 2)
    return float(10 * np.log10(255 ** 2 / max(mse, 1e-10)))


def ssim_map(a, b):
    """SSIM of the lumas, Gaussian window of sigma 1.5 (Wang et al. 2004)."""
    a, b = luma(a), luma(b)
    blur = lambda x: ndimage.gaussian_filter(x, 1.5, truncate=3.5, mode='mirror')
    mu_a, mu_b = blur(a), blur(b)
    var_a = blur(a * a) - mu_a ** 2
    var_b = blur(b * b) - mu_b ** 2
    cov = blur(a * b) - mu_a * mu_b
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    return ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (var_a + var_b + c2))


def ssim(image, reference):
    return float(np.mean(ssim_map(image, reference)))


def slanted_edge(image, roi, oversampling=4):
    """
    ISO 12233-style e-SFR on a near-vertical edge inside roi = {x, y, w, h}:
    edge location per row -> line fit -> edge spread function (ESF) binned at 1/4 pixel -> line spread function (LSF)
    -> MTF. Returns the curves, MTF50 (cycles/pixel), and the overshoot past the bright and dark levels, as a share of
    the step.
    """
    y = luma(image)[roi['y']:roi['y'] + roi['h'], roi['x']:roi['x'] + roi['w']]
    if y[:, :5].mean() > y[:, -5:].mean():
        y = y[:, ::-1]   # dark on the left
    rows, cols = np.indices(y.shape)
    # edge location in each row: centroid of the derivative (of rows smoothed against noise) around its peak
    gradient = np.abs(np.gradient(ndimage.uniform_filter(y, (5, 3)), axis=1))
    near_peak = np.abs(cols - np.argmax(gradient, axis=1)[:, None]) <= 4
    gradient *= near_peak
    centroids = (gradient * cols).sum(axis=1) / np.maximum(gradient.sum(axis=1), 1e-9)
    slope, intercept = np.polyfit(np.arange(y.shape[0]), centroids, 1)
    distance = (cols - (slope * rows + intercept)) * np.cos(np.arctan(slope))
    bins = np.round(distance * oversampling).astype(int)
    offset = bins.min()
    counts = np.bincount((bins - offset).ravel())
    sums = np.bincount((bins - offset).ravel(), weights=y.ravel())
    valid = np.nonzero(counts)[0]
    position = (valid + offset) / oversampling
    esf = sums[valid] / counts[valid]
    keep = np.abs(position) <= 16
    esf, position = esf[keep], position[keep]

    lsf = np.gradient(esf)
    peak = np.argmax(lsf)
    window = np.hamming(2 * len(lsf))[len(lsf) - peak:2 * len(lsf) - peak]
    mtf = np.abs(np.fft.rfft(lsf * window))
    mtf /= mtf[0]
    frequency = np.fft.rfftfreq(len(lsf), d=1 / oversampling)
    below = np.nonzero(mtf < 0.5)[0]
    if len(below) and below[0] > 0:
        i = below[0]
        mtf50 = frequency[i - 1] + (mtf[i - 1] - 0.5) / (mtf[i - 1] - mtf[i]) * (frequency[i] - frequency[i - 1])
    else:
        mtf50 = float('nan')

    # halos: how far the profile goes past the levels on each side, within 5 pixels of the edge
    dark = esf[position < -6].mean()
    bright = esf[position > 6].mean()
    near = np.abs(position) <= 5
    overshoot = max(esf[near].max() - bright, dark - esf[near].min(), 0) / (bright - dark)
    return {
        'esf': esf, 'position': position, 'frequency': frequency, 'mtf': mtf,
        'mtf50': float(mtf50), 'overshoot': float(overshoot), 'dark': float(dark), 'bright': float(bright),
    }


def patch_stats(image, box, inset=0.25):
    """Mean and standard deviation of each channel and of the luma in the center of a box = {x, y, w, h}."""
    dx, dy = int(box['w'] * inset), int(box['h'] * inset)
    patch = image[box['y'] + dy:box['y'] + box['h'] - dy, box['x'] + dx:box['x'] + box['w'] - dx].astype(np.float64)
    values = np.concatenate([patch, luma(patch)[..., None]], axis=-1).reshape(-1, 4)
    return values.mean(axis=0), values.std(axis=0)


def srgb_to_lab(rgb):
    """8-bit sRGB -> CIELAB (D65)."""
    c = np.asarray(rgb, dtype=np.float64) / 255
    linear = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = linear @ np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]).T
    xyz /= np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def delta_e2000(lab1, lab2):
    """CIEDE2000 color difference (Sharma, Wu, Dalal 2005)."""
    L1, a1, b1 = np.moveaxis(np.asarray(lab1, dtype=np.float64), -1, 0)
    L2, a2, b2 = np.moveaxis(np.asarray(lab2, dtype=np.float64), -1, 0)
    C_mean = (np.hypot(a1, b1) + np.hypot(a2, b2)) / 2
    G = 0.5 * (1 - np.sqrt(C_mean ** 7 / (C_mean ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dLp, dCp = L2 - L1, C2p - C1p
    dhp = h2p - h1p
    dhp = np.where(dhp > 180, dhp - 360, np.where(dhp < -180, dhp + 360, dhp))
    dhp = np.where(C1p * C2p == 0, 0, dhp)
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dhp / 2))
    Lp_mean, Cp_mean = (L1 + L2) / 2, (C1p + C2p) / 2
    hp_sum = h1p + h2p
    hp_mean = np.where(C1p * C2p == 0, hp_sum,
                       np.where(np.abs(h1p - h2p) <= 180, hp_sum / 2,
                                np.where(hp_sum < 360, (hp_sum + 360) / 2, (hp_sum - 360) / 2)))
    T = (1 - 0.17 * np.cos(np.radians(hp_mean - 30)) + 0.24 * np.cos(np.radians(2 * hp_mean))
         + 0.32 * np.cos(np.radians(3 * hp_mean + 6)) - 0.20 * np.cos(np.radians(4 * hp_mean - 63)))
    d_theta = 30 * np.exp(-(((hp_mean - 275) / 25) ** 2))
    R_C = 2 * np.sqrt(Cp_mean ** 7 / (Cp_mean ** 7 + 25 ** 7))
    S_L = 1 + 0.015 * (Lp_mean - 50) ** 2 / np.sqrt(20 + (Lp_mean - 50) ** 2)
    S_C = 1 + 0.045 * Cp_mean
    S_H = 1 + 0.015 * Cp_mean * T
    R_T = -np.sin(np.radians(2 * d_theta)) * R_C
    return np.sqrt((dLp / S_L) ** 2 + (dCp / S_C) ** 2 + (dHp / S_H) ** 2 + R_T * (dCp / S_C) * (dHp / S_H))
