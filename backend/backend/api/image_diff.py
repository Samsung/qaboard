import os
import time

import numpy as np
import skimage.color
import skimage.transform
from skimage.feature import peak_local_max
from skimage.metrics import structural_similarity as ssim
from scipy import ndimage as ndi

from ..images import read_image

plot_debug = False
if os.environ.get("PLOT_DEBUG"):
  plot_debug = True
  import matplotlib.pyplot as plt


def yiq(img1, img2):
  start = time.time()
  yuv1 = skimage.color.rgb2yiq(img1)
  yuv2 = skimage.color.rgb2yiq(img2)
  print("yuv time: {} sec".format(time.time()-start))
  delta2 = np.square(yuv1 - yuv2) # why square?
  print("delta2 time: {} sec".format(time.time()-start))
  return delta2 @ [0.5053, 0.299, 0.1957]


def diff(image_1, image_2, diff_type="yiq"):
    if diff_type == "yiq":
        return yiq(image_1, image_2)
    elif diff_type == "ssim":
      # https://scikit-image.org/docs/stable/auto_examples/transform/plot_ssim.html
      ssim_score, delta = ssim(
        image_1,
        image_2,
        data_range=image_1.max()-image_1.min(),
        channel_axis=2,
        full=True,
        # win_size=3,
      )
      delta = 1-np.min(delta, axis=2)
      return delta
    else:
        # https://scikit-image.org/docs/stable/api/skimage.color.html#skimage.color.deltaE_ciede2000
        return getattr(skimage.color, f"deltaE_{diff_type}")(
            skimage.color.rgb2lab(image_1),
            skimage.color.rgb2lab(image_2),
        ) # cie76 | ciede2000 | ciede94


def rescale(image):
  # TODO: To get better perf with huge (non-BMP?) images, we could use
  #       https://libvips.github.io/pyvips/intro.html#numpy-and-pil
  #       https://pypi.org/project/pyvips/
  #       https://www.libvips.org/API/current/libvips-resample.html#vips-resize
  #       https://www.libvips.org/
  #       https://stackoverflow.com/a/53728154
  start = time.time()
  print("  shape: ", image.shape)
  width = image.shape[0]
  height = image.shape[1]
  pixels = width * height
  if pixels < 500_000:
    return image, 1.0
  max_dim = max(width, height)
  scale = float(512 / max_dim)
  print("  scale: ", scale)
  image_rescale = skimage.transform.rescale(
      image,
      scale,
      mode='reflect',
      channel_axis=2,
      anti_aliasing=max_dim<8_000, # we ran into OOM...
  )
  print("  rescale time: {} sec".format(time.time()-start))
  return image_rescale, scale


def plot_rois(delta, delta_max, coordinates):
  fig, axes = plt.subplots(1, 3, figsize=(8, 3), sharex=True, sharey=True)
  ax = axes.ravel()
  ax[0].imshow(delta, cmap=plt.cm.gray)
  ax[0].axis('off')
  ax[0].set_title('Original')

  ax[1].imshow(delta_max, cmap=plt.cm.gray)
  ax[1].axis('off')
  ax[1].set_title('Maximum filter')

  ax[2].imshow(delta, cmap=plt.cm.gray)
  ax[2].autoscale(False)
  ax[2].plot(coordinates[:, 1], coordinates[:, 0], 'r.')
  ax[2].axis('off')
  ax[2].set_title('Peak local max')

  fig.tight_layout()
  plt.show()

def find_rois(image_1_path, image_2_path, diff_type, threshold, blob_diameter, count):
  # Note: `threshold` and `blob_diameter` are currently ignored
  # since we have huge images, we try to avoid being out of memory
  # and load one at a time if possible...
  start = time.time()
  image, meta = read_image(image_1_path)
  image_shape = image.shape
  print(f"read image 1: {time.time()-start}s")
  image_1, scale = rescale(image)
  print(f"rescaled image 1: {time.time()-start}s")

  image, meta = read_image(image_2_path)
  assert image_shape == image.shape
  print(f"read image 2: {time.time()-start}s")
  image_2, _ = rescale(image)

  delta = diff(image_1, image_2, diff_type)
  print("diff time: {} sec".format(time.time()-start))

  delta_size = 20
  delta_max = ndi.maximum_filter(delta, size=delta_size, mode='constant')
  delta_max_max = delta_max.max()
  coordinates = peak_local_max(delta, min_distance=delta_size)
  if plot_debug:
    plot_rois(delta, delta_max, coordinates)
  blobs = [{
    "x": int(x/scale), 
    "y": int(y/scale),
    "r": int(delta_size/2/scale), # TODO: improve: normalized laplacian...
    "diff": float(delta_max[y, x] / delta_max_max),
  } for y, x in coordinates.tolist()]
  blobs.sort(key=lambda b: b["diff"], reverse=True)
  return blobs[:count]
