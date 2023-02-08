import os
import time

import numpy as np
import skimage.color
import skimage.transform
from skimage.feature import peak_local_max, blob_dog # blob_log, blob_doh
from skimage.metrics import structural_similarity as ssim
from scipy import ndimage as ndi

from cde.image import read_image

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
      # print(image_1.shape)
      # print(image_2.shape)
      ssim_score, delta = ssim(
        image_1,
        image_2,
        data_range=image_1.max()-image_1.min(),
        channel_axis=2,
        full=True,
        # win_size=3,
      )
      delta = 1-np.min(delta, axis=2)
      # print("ssim_score", ssim_score)
      # print("delta.shape", delta)
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

  # print("image: ", image_1.shape)
  # plt.imshow(image_1)
  # return

  delta = diff(image_1, image_2, diff_type)
  print("diff time: {} sec".format(time.time()-start))
  # print("delta", delta.shape)
  # plt.imshow(delta)
  # return


  if True:
    delta_size = 20
    delta_max = ndi.maximum_filter(delta, size=delta_size, mode='constant')
    delta_max_max = delta_max.max()
    # print(f"max diff: {delta.max()}")
    # print(f"delta_max_max: {delta_max_max}")
    coordinates = peak_local_max(delta, min_distance=delta_size)
    # print(coordinates)
    # print(len(coordinates))
    if plot_debug:
      plot_rois(delta, delta_max, coordinates)
    # print("delta_max.shape", delta_max.shape)
    # print(coordinates)
    blobs = [{
      "x": int(x/scale), 
      "y": int(y/scale),
      "r": int(delta_size/2/scale), # TODO: improve: normalized laplacian...
      "diff": float(delta_max[y, x] / delta_max_max),
    } for y, x in coordinates.tolist()]
    # print(blobs)
    blobs.sort(key=lambda b: b["diff"], reverse=True)
    return blobs[:count]

  width = image_1.shape[0]
  height = image_1.shape[1]
  blob_ratio = 0.1 # default ratio for blob diameter
  if int(blob_diameter) == 0 :
    blob_diameter = (width + height) / 2 * blob_ratio

  # print("blob_diameter: ", blob_diameter) # DEBUG
  min_sigma = 5    # for blob_dog algorithm
  max_sigma = int(blob_diameter) * scale
  if min_sigma >= max_sigma:
    min_sigma = 1

  start = time.time()         # DEBUG
  blobs = blob_dog(delta, min_sigma=min_sigma, max_sigma=int(max_sigma), threshold=(float(threshold) / 100))  # Divide treshold to increase sensetivity
  for blob in blobs:
    blob[2] = np.ceil(blob[2])
  print("cluster time: {} sec".format(time.time()-start))  # DEBUG

  if plot_debug:
    figure, ax = plt.subplots(figsize=(15, 15))  # DEBUG
    ax.imshow(delta)                      # DEBUG
    for blob in blobs:
      y, x, r = blob      # DEBUG
      c = plt.Circle((x, y), r, color="red", linewidth=1, fill=False) # DEBUG
      ax.add_patch(c)   # DEBUG
    plt.tight_layout()                          # DEBUG
    plt.show()

  blobs[:, 0] = blobs[:, 0] * 1 / scale
  blobs[:, 1] = blobs[:, 1] * 1 / scale
  # The radius of each blob is approximately √2*σ
  blobs[:, 2] = blobs[:, 2] * np.sqrt(2)

  # print("blobs size:", blobs.size / 3)         # DEBUG
  # plt.savefig('C:/Users/itamarp/Desktop/blobs.png', dpi=300)  # DEBUG
  blobs = [{"x": x, "y": y, "r": r} for x, y, r in blobs]
  blobs.sort(key=lambda b: b["r"], reverse=True)
  return blobs



################################################################################
if __name__ == "__main__":
    from pathlib import Path
    dir_new = '/algo/HP2/outputs/noar/CDE-Users/HW_ALG/3d/725cf7398b523a/CIS/tests/products/HP2/output/abs-test/d471da0e-al/ABS_9Stars_AG6_0x60'
    dir_ref = '/algo/HP2/outputs/noar/CDE-Users/HW_ALG/89/02082f8eff5b0a/CIS/tests/products/HP2/output/sds-test/94fd955c-al/ABS_9Stars_AG6_0x60'
    path = 'output.bmp'
    start = time.time()
    print(f"read 2 time: {time.time()-start}s")
    find_rois(
      Path(dir_new) / path,
      Path(dir_ref) / path,
      diff_type="yiq",
      threshold=0.01,
      blob_diameter=0
    )
    print(f"total time: {time.time()-start}s")
