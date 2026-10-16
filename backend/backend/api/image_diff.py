"""
Where two images differ most: the regions of interest of the image viewer's "Where they differ".

The difference is computed on a working grid about 1024 cells wide, by bands of rows, so that 100 MP images fit in
memory and in a second or two:
- perceptual: pixelmatch's YIQ color distance (like the image viewer), at full resolution, then the largest of each
  cell of the grid: a difference of a few pixels still shows;
- ssim, ciede2000: on the images averaged down to the grid. SSIM compares neighborhoods, and CIEDE2000 is slow.
Then the peaks of the difference, and around each the region where the difference stays above half of the peak's.

Values are comparable across images (to rank runs): perceptual is a fraction of the largest possible difference (like
the viewer's), ssim is 1 - SSIM, ciede2000 is ΔE.
"""
import math

import numpy as np
import skimage.color
from scipy import ndimage as ndi
from skimage.metrics import structural_similarity


METHODS = ('yiq', 'ssim', 'ciede2000')
# the working grid's size, in cells, along the image's longest side
GRID = 1024
# pixels per band, when we go through the images: small enough to stay in the processor's cache
BAND_PIXELS = 300_000
# pixelmatch's largest squared YIQ distance
YIQ_MAX = 35215.0


def value_scale(image):
  """What to multiply the values with, to get 0-255 like 8-bit images"""
  dtype = image.dtype
  if dtype == np.uint8:
    return 1.0
  if dtype == np.bool_:
    return 255.0
  if np.issubdtype(dtype, np.integer):
    # 16-bit, or 10/12-bit in 16 bits: their largest value
    sample = np.asarray(image[::16, ::16])
    top = float(sample.max()) if sample.size else 0.0
    bits = max(8, math.ceil(math.log2(top + 1))) if top > 0 else 8
    return 255.0 / (2 ** bits - 1)
  # floats: 0-1, or already 0-255
  sample = np.asarray(image[::16, ::16], dtype=np.float32)
  top = float(np.nanmax(sample)) if sample.size else 0.0
  return 255.0 if top <= 1.0 else 1.0


def as_rgb(band, scale):
  """A band of rows as float32 RGB, 0-255: gray is repeated, alpha dropped"""
  band = np.asarray(band, dtype=np.float32)
  if scale != 1:
    band *= np.float32(scale)
  if band.ndim == 2:
    return np.repeat(band[:, :, None], 3, axis=2)
  if band.shape[2] < 3:
    return np.repeat(band[:, :, :1], 3, axis=2)
  return band[:, :, :3]


def _pad_to(array, factor, mode):
  """Pads the first two axes to a multiple of factor"""
  pad_h = -array.shape[0] % factor
  pad_w = -array.shape[1] % factor
  if not pad_h and not pad_w:
    return array
  padding = [(0, pad_h), (0, pad_w)] + [(0, 0)] * (array.ndim - 2)
  return np.pad(array, padding, mode=mode)


def block_reduce(array, factor, func):
  """
  Each factor x factor block of the first two axes reduced with np.max or np.mean (as float32). The rows of each block
  first, then its columns: rows are contiguous, it's about 10 times faster than both axes at once.
  """
  if factor == 1:
    return array
  array = _pad_to(array, factor, 'constant' if func is np.max else 'edge')
  h, w = array.shape[0] // factor, array.shape[1] // factor
  rest = array.shape[2:]
  if func is np.max:
    rows = array.reshape(h, factor, w * factor, *rest).max(axis=1)
    return rows.reshape(h, w, factor, *rest).max(axis=2)
  dtype = np.uint32 if array.dtype.kind in 'ub' and array.dtype.itemsize <= 2 else np.float64
  rows = array.reshape(h, factor, w * factor, *rest).sum(axis=1, dtype=dtype)
  return (rows.reshape(h, w, factor, *rest).sum(axis=2, dtype=dtype) / (factor * factor)).astype(np.float32)


def grid_factor(shape):
  return max(1, math.ceil(max(shape[0], shape[1]) / GRID))


def _bands(height, width, factor):
  """Rows [start, stop) of the image, by bands of about BAND_PIXELS, whole rows of cells of the grid"""
  cells = max(1, BAND_PIXELS // (max(1, width) * factor))
  step = cells * factor
  for start in range(0, height, step):
    yield start, min(height, start + step)


RGB_TO_Y = np.array([0.29889531, 0.58662247, 0.11448223], dtype=np.float32)
RGB_TO_I = np.array([0.59597799, -0.27417610, -0.32180189], dtype=np.float32)
RGB_TO_Q = np.array([0.21147017, -0.52261711, 0.31114694], dtype=np.float32)

def yiq_squared(d):
  """pixelmatch's squared YIQ distance (Kotsarenko and Ramos) of a difference of RGB colors, from 0 to YIQ_MAX"""
  y, i, q = d @ RGB_TO_Y, d @ RGB_TO_I, d @ RGB_TO_Q
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q


def yiq_distance(a, b):
  """The perceptual difference of RGB colors, as a fraction of the largest: like the image viewer's"""
  return np.sqrt(yiq_squared(a - b) / np.float32(YIQ_MAX))


def rgb_difference(band_1, band_2, scale_1, scale_2):
  """band_1 - band_2, as float32 RGB 0-255"""
  if band_1.dtype == band_2.dtype == np.uint8 and band_1.shape == band_2.shape:
    # 8-bit images, the most common: one conversion instead of two
    return as_rgb(band_1.astype(np.int16) - band_2, 1)
  return as_rgb(band_1, scale_1) - as_rgb(band_2, scale_2)


def reduced(image, factor, scale):
  """The image as RGB 0-255, averaged down by factor"""
  height, width = image.shape[:2]
  bands = []
  for start, stop in _bands(height, width, factor):
    # averaged as they are, without a float copy of the band
    bands.append(block_reduce(np.asarray(image[start:stop]), factor, np.mean))
  return as_rgb(np.concatenate(bands), scale)


def difference_map(image_1, image_2, method):
  """The difference on the working grid, and the grid's factor (image pixels per cell)"""
  if method not in METHODS:
    raise ValueError(f"Unknown method {method}, use one of {', '.join(METHODS)}")
  factor = grid_factor(image_1.shape)
  scale_1, scale_2 = value_scale(image_1), value_scale(image_2)
  height, width = image_1.shape[:2]
  if method == 'yiq':
    # the square root and the scale after the largest of each cell: the same, with fewer pixels
    squared = np.concatenate([
      block_reduce(yiq_squared(rgb_difference(image_1[start:stop], image_2[start:stop], scale_1, scale_2)), factor, np.max)
      for start, stop in _bands(height, width, factor)
    ])
    return np.sqrt(squared / np.float32(YIQ_MAX)), factor
  small_1 = reduced(image_1, factor, scale_1)
  small_2 = reduced(image_2, factor, scale_2)
  if method == 'ssim':
    # neighborhoods of 7x7 cells
    if min(small_1.shape[:2]) < 7:
      return np.zeros(small_1.shape[:2], dtype=np.float32), factor
    _, ssim = structural_similarity(small_1, small_2, data_range=255, channel_axis=2, full=True)
    return (1 - ssim.min(axis=2)).astype(np.float32), factor
  lab_1 = skimage.color.rgb2lab(np.clip(small_1 / 255, 0, 1))
  lab_2 = skimage.color.rgb2lab(np.clip(small_2 / 255, 0, 1))
  return skimage.color.deltaE_ciede2000(lab_1, lab_2).astype(np.float32), factor


def find_regions(delta, factor, shape, count=20):
  """
  The regions where the difference peaks, the largest first:
  [{x, y, w, h, peak_x, peak_y, value, diff}], in the pixels of images of `shape`. value is the peak's difference,
  diff its fraction of the largest peak's.

  The largest difference left, its region, then the difference in and around the region is set aside: users want
  regions spread out, not twenty views of the same place (e.g. leaves, which differ everywhere).
  """
  delta = np.nan_to_num(delta, nan=0.0, posinf=0.0, neginf=0.0)
  top = float(delta.max()) if delta.size else 0.0
  if top <= 1e-6:
    return []
  height, width = shape[:2]
  rows, columns = delta.shape
  left_over = delta.copy()
  regions = []
  # around a peak, where the difference stays above half of it: at most this many cells away
  window = max(8, min(delta.shape) // 8)
  for _ in range(count):
    cy, cx = np.unravel_index(int(np.argmax(left_over)), left_over.shape)
    value = float(left_over[cy, cx])
    if value <= top * 0.02:
      break
    y0, x0 = max(0, cy - window), max(0, cx - window)
    local = delta[y0:cy + window + 1, x0:cx + window + 1] >= value / 2
    labels, _ = ndi.label(local)
    ys, xs = np.nonzero(labels == labels[cy - y0, cx - x0])
    left, right = (x0 + xs.min()) * factor, (x0 + xs.max() + 1) * factor
    top_, bottom = (y0 + ys.min()) * factor, (y0 + ys.max() + 1) * factor
    # with some context around: about 200 pixels at least, 2 to 4 times larger than the pixels when the viewer shows it
    size = max(right - left, bottom - top_) * 1.5
    size = max(size, min(192, max(width, height) / 2))
    w = min(width, max(right - left + size / 2, size))
    h = min(height, max(bottom - top_ + size / 2, size))
    x = min(max(0, (left + right) / 2 - w / 2), width - w)
    y = min(max(0, (top_ + bottom) / 2 - h / 2), height - h)
    regions.append({
      "x": int(round(x)), "y": int(round(y)), "w": int(round(w)), "h": int(round(h)),
      "peak_x": int(min(width - 1, (cx + 0.5) * factor)), "peak_y": int(min(height - 1, (cy + 0.5) * factor)),
      "value": value,
    })
    # the region, and half of its size around it
    left_over[
      max(0, int((y - h / 2) // factor)):min(rows, math.ceil((y + 1.5 * h) / factor)),
      max(0, int((x - w / 2) // factor)):min(columns, math.ceil((x + 1.5 * w) / factor)),
    ] = 0
  for r in regions:
    r["diff"] = r["value"] / top
  return regions
