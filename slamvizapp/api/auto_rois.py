"""
Returns a list of rois
"""
#import time  # for Debugging purpose
from pathlib import Path
from math import sqrt, ceil

import numpy as np
from skimage import color
from skimage.color import deltaE_cie76, rgb2lab
# from skimage.viewer import ImageViewer  # for Debugging purpose
from skimage.transform import rescale
# probably only one of them is enough, or perhaps "amitay algo" or "TheCodingTrain algo"
from skimage.feature import blob_dog # blob_log, blob_doh
#import matplotlib.pyplot as plt # for Debugging purpose

from flask import request, jsonify

from cde.image import read_image

from slamvizapp import app # necessary? 


@app.route("/api/v1/output/diff/image", methods=['GET', 'POST'])
def get_images():
  data = request.get_json()
  # Directory URLs begin with /s/
  new_url = Path(data['output_dir_url_new'][2:]) / data["path"]
  ref_url = Path(data['output_dir_url_ref'][2:]) / data["path"]

  blobs = createAutoRois(new_url, ref_url, data["diff_type"], data['threshold'])

  blobs = (blobs.tolist())
  print(blobs)
  print(len(blobs))
  
  # limits the number of rois to 20, filtering small rois.
  while len(blobs) > 20:
    index_min = np.argmin([x[2] for x in blobs])
    del blobs[index_min]
  
  # print(blobs)
  # print(len(blobs))
  # blobs = list(reversed(blobs))
  blobs.sort(key=lambda y, x, r: r, reverse=True)

  return jsonify(blobs)




def createAutoRois(path1, path2, diff_type, threshold):
  scale = 0.5
  image_1, meta_1 = read_image(Path(path1))
  image_2, meta_2 = read_image(Path(path2))
  '''
  print(image_1.shape)
  print(image_1.size)
  print(image_1.shape[0]*image_1.shape[1])
'''
  # image_1_orig = image_1 # DEBUG
  image_1 = rescale(image_1, scale, mode='constant',
                    multichannel=True, anti_aliasing=True)
  image_2 = rescale(image_2, scale, mode='constant',
                    multichannel=True, anti_aliasing=True)

  delta = diff(image_1, image_2, diff_type)
  
  '''
  print(delta.shape)
  print(delta.size)
  print(delta.max())

  np.savetxt("/home/itamarp/delta.txt", delta)
  viewer = ImageViewer((delta)) #, plugins=[]) 
  viewer.show()

  blobs = blob_doh(delta,min_sigma=15, max_sigma=100,num_sigma=10, threshold=.01)

  blobs = blob_log(delta,min_sigma=15, max_sigma=100, num_sigma=10, threshold=.1)
  blobs[:, 2] = blobs[:, 2] * sqrt(2) # Compute radii in the 3rd column.
  '''

  # start = time.time()
  blobs = blob_dog(delta, min_sigma=25, max_sigma=100, sigma_ratio=1.6, threshold=(threshold * 10))
  # end = time.time()
  # print(f"blob_dog time: {end-start} sec")

  blobs[:, 0] = blobs[:, 0] * 1 / scale
  blobs[:, 1] = blobs[:, 1] * 1 / scale
  # The radius of each blob is approximately √2*σ
  blobs[:, 2] = blobs[:, 2] * sqrt(2)

  '''
  print(blobs.size / 3)                        # DEBUG
  figure, ax = plt.subplots(figsize=(15, 15))  # DEBUG
  ax.imshow(image_1_orig)                      # DEBUG
  '''
  for blob in blobs:
    blob[2] = ceil(blob[2])
  
  '''
    y, x, r = blob
    c = plt.Circle((x, y), r, color="red",
                    linewidth=1, fill=False)
    ax.add_patch(c)                         # DEBUG

  #plt.savefig('C:/Users/itamarp/Desktop/auto_crops/blobs.png',
  #            dpi=300)  # DEBUG
  # plt.tight_layout()                          # DEBUG
  # plt.show()                                  # DEBUG
  '''
  return blobs

def diff(image_1, image_2, diff_type):
  # start = time.time()

  # if (diff_type == "rgb"): # for future development

  # other possibilities are CIE94, CIEDE2000, CMC l:c (1984)
  delta = deltaE_cie76(rgb2lab(image_1), rgb2lab(image_2))

  # end = time.time()
  # print(f"deltaE_cie76 time: {end - start} sec")
  return delta


if __name__ == "__main__":

  app.run()

  '''
  start = time.time()

  path1 = 'C:/Users/itamarp/Desktop/auto_crops/itamar1.bmp'
  path2 = 'C:/Users/itamarp/Desktop/auto_crops/itamar2.bmp'
  threshold = 0.1
  CreateAutoRois(path1, path2, "RGB", threshold)

  end = time.time()
  print("time: {} sec".format(end-start))
  '''