"""
Returns a list of rois
"""
import time  # for Debugging purpose
from pathlib import Path
from math import sqrt, ceil

import numpy as np
from skimage import color
from skimage.color import deltaE_cie76, rgb2lab
from skimage.viewer import ImageViewer  # for Debugging purpose
from skimage.transform import rescale
# probably only one of them is enough, or perhaps "amitay algo" or "TheCodingTrain algo"
from skimage.feature import blob_dog # blob_log, blob_doh
from skimage.color import rgb2yiq
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages

from flask import request, jsonify

from cde.image import read_image

from slamvizapp import app # necessary?

'''
'''
@app.route("/api/v1/output/diff/image", methods=['GET', 'POST'])
def get_images():
  data = request.get_json()
  # Directory URLs begin with /s/
  new_url = Path(data['output_dir_url_new'][2:]) / data["path"]
  ref_url = Path(data['output_dir_url_ref'][2:]) / data["path"]
  print(data) # DEBUG
  blobs = createAutoRois(new_url, ref_url, data["diff_type"], data['threshold'], data['diameter'])

  blobs = (blobs.tolist())
  ##print(blobs)
  print("len:", len(blobs))
  #
  # limits the number of rois to "num_crops", filtering small rois.
  while len(blobs) > data['count']:
    index_min = np.argmin([yxr[2] for yxr in blobs])
    del blobs[index_min]

  # print(blobs)
  print("len: ", len(blobs))
  # blobs = list(reversed(blobs))
  #blobs.sort(key=lambda yxr: yxr[2], reverse=True)
  print("sorted: ",blobs)
  return jsonify(blobs)



def createAutoRois(path1, path2, diff_type, threshold, blob_diameter):
  scale = 1
  #scale = 0.5
  blob_ratio = 0.1
  min_sigma = 5
  
  image_1, meta_1 = read_image(Path(path1))
  image_2, meta_2 = read_image(Path(path2))

  '''
  print(image_1.shape)
  print(image_1.size)
  print(image_1.shape[0]*image_1.shape[1])
  print("type:", type(image_1))
  print(image_1[0][0])
  '''
 
  '''
  #image_1_orig = image_1 # DEBUG
  image_1 = rescale(image_1, scale, mode='constant',
                    multichannel=True, anti_aliasing=True)
  image_2 = rescale(image_2, scale, mode='constant',
                    multichannel=True, anti_aliasing=True)
  '''
 
  # start = time.time()
  # delta = diff(image_1, image_2, diff_type)
  # end = time.time()
  # print("diff time: {} sec".format(end-start))


  start = time.time()                  # DEBUG
  delta = pixelmatch(image_1, image_2)
  end = time.time()                    # DEBUG
  print("pixelmatch time: {} sec".format(end-start))   # DEBUG

  #delta = rescale(delta, scale, mode='constant', multichannel=False, anti_aliasing=True)
  print("delta: ", delta)              # DEBUG

  width = image_1.shape[0]
  height = image_1.shape[1]
  '''
  output = np.empty([width, height])
  print("output type:", type(output))
  print("image1 shape:",image_1.shape)
  print("output shape:", output.shape)
  '''

  '''
  print("delta shape:", delta.shape)
  print("delta size:",delta.size)
  print(delta.max())
  np.savetxt("/home/itamarp/delta.txt", delta)
  viewer = ImageViewer((delta)) #, plugins=[])
  viewer.show()

  blobs = blob_doh(delta,min_sigma=15, max_sigma=100,num_sigma=10, threshold=.01)
  blobs = blob_log(delta,min_sigma=15, max_sigma=100, num_sigma=10, threshold=.1)
  blobs[:, 2] = blobs[:, 2] * sqrt(2) # Compute radii in the 3rd column.
  '''


  if int(blob_diameter) == 0 :
    blob_diameter = (width + height) / 2 * blob_ratio

  print("blob_diameter: ", blob_diameter)
  max_sigma = int(blob_diameter) * scale

  if min_sigma >= max_sigma:
    min_sigma = 1

  start = time.time()         # DEBUG
  blobs = blob_dog(delta, min_sigma=min_sigma, max_sigma=int(max_sigma), threshold=threshold)
  end = time.time()           # DEBUG
  print(f"blob_dog time: {end-start} sec")

  blobs[:, 0] = blobs[:, 0] * 1 / scale
  blobs[:, 1] = blobs[:, 1] * 1 / scale
  # The radius of each blob is approximately √2*σ
  blobs[:, 2] = blobs[:, 2] * sqrt(2)


  # print("blobs size:", blobs.size / 3)         # DEBUG
  # figure, ax = plt.subplots(figsize=(15, 15))  # DEBUG
  # ax.imshow(image_1_orig)                      # DEBUG

  for blob in blobs:
    blob[2] = ceil(blob[2])
    y, x, r = blob
    # c = plt.Circle((x, y), r, color="red", linewidth=1, fill=False) # DEBUG
    # ax.add_patch(c)                         # DEBUG


  # plt.savefig('C:/Users/itamarp/Desktop/blobs.png', dpi=300)  # DEBUG
  # plt.tight_layout()                          # DEBUG
  # plt.show()                                  # DEBUG

  return blobs


################################################################################
def diff(image_1, image_2, diff_type):
  # start = time.time()

  # if (diff_type == "rgb"): # for future development

  # other possibilities are CIE94, CIEDE2000, CMC l:c (1984)
  delta = deltaE_cie76(rgb2lab(image_1), rgb2lab(image_2))

  # end = time.time()
  # print(f"deltaE_cie76 time: {end - start} sec")
  return delta


def pixelmatch(img1, img2) :
  yuv1 = rgb2yiq(img1)
  yuv2 = rgb2yiq(img2)
  delta2 = np.square(yuv1 - yuv2) # why square?
  return delta2 @ [0.5053, 0.299, 0.1957]

################################################################################
@app.route("/api/v1/output/diff/report", methods=['GET', 'POST'])
def get_rois():
  data = request.get_json()
  # Directory URLs begin with /s/
  new_url = Path(data['output_dir_url_new'][2:]) / data["path"]
  ref_url = Path(data['output_dir_url_ref'][2:]) / data["path"]
  rois = data['rois']
  print(data) # DEBUG

  image_1, meta_1 = read_image(Path(new_url))
  image_2, meta_2 = read_image(Path(ref_url))

  crop1 = crop_image(image_1, rois[0]['x'], rois[0]['y'] ,rois[0]['w'] ,rois[0]['h'])
  crop2 = crop_image(image_2, rois[0]['x'], rois[0]['y'] ,rois[0]['w'] ,rois[0]['h'])

  t = time.time()
  report_url = f"/stage/algo_data/qatools_dev/{t}_crop1.pdf"
  report_url_win = f"\\\\netapp\\algo_data\\qatools_dev\\{t}_crop1.pdf"
  figure, axes = plt.subplots(1, 2, figsize=(30, 15), sharex=True, sharey=True)

  ax = axes.ravel()
  ax[0].imshow(crop1)
  ax[1].imshow(crop2)
  plt.subplots_adjust(bottom=0.15, wspace=0.01)
  pp = PdfPages(report_url)
  pp.savefig(figure)
  pp.close()
  #  plt.savefig(f"{report_url}/{time.time()}_crop1.pdf")
  print("Report done.")
  return jsonify(report_url_win)

def crop_image(img, cropx, cropy, cropw, croph):

  return img[cropy:cropy+croph, cropx:cropx+cropw]

################################################################################
if __name__ == "__main__":

  app.run()

  '''
  start = time.time()

  path1 = 'C:/Users/itamarp/Desktop/itamar1.bmp'
  path2 = 'C:/Users/itamarp/Desktop/itamar2.bmp'
  threshold = 0.01
  blobs = createAutoRois(path1, path2, "RGB", threshold)
  print(blobs)

  end = time.time()
  print("time: {} sec".format(end-start))
  '''