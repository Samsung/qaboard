"""
Read images as numpy arrays.

At SIRC we use the (internal) cde package, which also reads raw/hex formats.
Without it, we read common image formats with Pillow.
"""
import numpy as np

try:
  from cde.image import read_image, ImageType
except ImportError:
  ImageType = None

  def read_image(image_path):
    from PIL import Image
    with Image.open(image_path) as image:
      return np.asarray(image), {"mode": image.mode}
