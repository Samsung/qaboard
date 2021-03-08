"""
Returns a list of rois.
Create a pdf report of rois comparison.
"""
from pathlib import Path
import time  # for Debugging purpose
from math import sqrt, ceil

import numpy as np
from skimage import io
from skimage.color import deltaE_cie76, rgb2lab, rgb2yiq
from skimage.transform import rescale
from skimage.feature import blob_dog # blob_log, blob_doh

from requests.utils import unquote
from flask import request, jsonify

from qaboard.api import url_to_dir 
from backend import app
from ..models import Output

@app.route("/api/v1/output/image/pixel", methods=['GET', 'POST'])
def get_pixel():
  x = int(request.args['x'])-1
  y = int(request.args['y'])-1
  image_path = url_to_dir(request.args['image_url'])
  image, meta = read_image(Path(image_path))
  return jsonify({
    "value": image[y,x].tolist(),
    "meta": meta,
  })


@app.route("/api/v1/output/diff/image", methods=['GET', 'POST'])
def get_images():
  data = request.get_json()
  # Directory URLs begin with /s/
  new_url = url_to_dir(data['output_dir_url_new']) / data["path"]
  ref_url = url_to_dir(data['output_dir_url_ref']) / data["path"]
  # print(data) # DEBUG
  blobs = createAutoRois(new_url, ref_url, data["diff_type"], data['threshold'], data['diameter'])

  blobs = (blobs.tolist())
  # print(blobs)
  # print("len:", len(blobs))

  ## limits the number of rois to "num_crops", filtering small rois.
  while len(blobs) > data['count']:
    index_min = np.argmin([yxr[2] for yxr in blobs])
    del blobs[index_min]

  # print(blobs)  # DEBUG
  # print("sorted len: ", len(blobs)) # DEBUG

  return jsonify(blobs)



def createAutoRois(path1, path2, diff_type, threshold, blob_diameter):
  scale = 0.5      # default rescaling for delta image
  blob_ratio = 0.1 # default ratio for blob diameter
  min_sigma = 5    # for blob_dog algorithm

  image_1 = io.imread(Path(path1))
  image_2 = io.imread(Path(path2))

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

  # start = time.time()                  # DEBUG
  delta = diff(image_1, image_2, diff_type)
  # end = time.time()                    # DEBUG
  # print("diff time: {} sec".format(end-start))  # DEBUG

  width = image_1.shape[0]
  height = image_1.shape[1]
  if (width * height < 1000000):
    scale = 1


  # print("scale: ", scale)     # DEBUG
  delta = rescale(delta, scale, mode='reflect', multichannel=False, anti_aliasing=True)
  width = image_1.shape[0]
  height = image_1.shape[1]
  # print("delta: ", delta)   # DEBUG


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
  from skimage.viewer import ImageViewer  # for Debugging purpose
  viewer = ImageViewer((delta)) #, plugins=[])
  viewer.show()
  '''


  if int(blob_diameter) == 0 :
    blob_diameter = (width + height) / 2 * blob_ratio

  # print("blob_diameter: ", blob_diameter) # DEBUG
  max_sigma = int(blob_diameter) * scale

  if min_sigma >= max_sigma:
    min_sigma = 1

  start = time.time()         # DEBUG
  blobs = blob_dog(delta, min_sigma=min_sigma, max_sigma=int(max_sigma), threshold=(float(threshold) / 100))  # Divide treshold to increase sensetivity
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
    # y, x, r = blob      # DEBUG
    # c = plt.Circle((x, y), r, color="red", linewidth=1, fill=False) # DEBUG
    # ax.add_patch(c)   # DEBUG


  # plt.savefig('C:/Users/itamarp/Desktop/blobs.png', dpi=300)  # DEBUG
  # plt.tight_layout()                          # DEBUG
  # plt.show()                                  # DEBUG

  return blobs


################################################################################
def diff(image_1, image_2, diff_type):
  # if (diff_type == "rgb"): # for future development (SSIM)

  delta = pixelmatch(image_1, image_2)
  ## other possibilities are CIE94, CIEDE2000, CMC l:c (1984)
  # delta = deltaE_cie76(rgb2lab(image_1), rgb2lab(image_2))

  return delta


def pixelmatch(img1, img2) :
  yuv1 = rgb2yiq(img1)
  yuv2 = rgb2yiq(img2)
  delta2 = np.square(yuv1 - yuv2) # why square?
  return delta2 @ [0.5053, 0.299, 0.1957]

################################################################################
@app.route("/api/v1/output/diff/report", methods=['GET', 'POST'])
def get_rois():
  import matplotlib.pyplot as plt
  from matplotlib.backends.backend_pdf import PdfPages

  data = request.get_json()
  # Directory URLs begin with /s/
  report_folder = Path(data['output_dir_url_new'][2:]) / "reports"
  new_url = Path(data['output_dir_url_new'][2:]) / data["path"]
  ref_url = Path(data['output_dir_url_ref'][2:]) / data["path"]
  rois = data['rois']
  # print(data) # DEBUG

  time_tuple = time.localtime() # get struct_time
  time_string = time.strftime("%d%m%Y_%H%M%S", time_tuple)
  report_path = f"{report_folder}/{time_string}_report.pdf"
  report_url = f"https://qa/s/{report_folder}/{time_string}_report.pdf"
  Path(report_folder).mkdir(parents=True, exist_ok=True)

  image_1 = io.imread(Path(new_url))
  image_2 = io.imread(Path(ref_url))

  with PdfPages(report_path) as pdf:

    new_ci_output = Output.query.filter(Output.id == data['output_id_new']).one().batch.ci_commit.hexsha
    ref_ci_output = Output.query.filter(Output.id == data['output_id_ref']).one().batch.ci_commit.hexsha

    firstPage = plt.figure(figsize=(10,5))
    firstPage.clf()
    txt = f"Auto Rois Report\n{time.asctime(time_tuple)}\nnew: {new_ci_output}\nref:  {ref_ci_output}"

    firstPage.text(0.05, 0.5, txt, transform=firstPage.transFigure, size=14, ha='left', linespacing=2)
    pdf.savefig()
    plt.close()

    for roi in rois:
      x, y, w, h = roi['x'], roi['y'] ,roi['w'] ,roi['h']
      crop1 = crop_image(image_1, roi['x'], roi['y'] ,roi['w'] ,roi['h'])
      crop2 = crop_image(image_2, roi['x'], roi['y'] ,roi['w'] ,roi['h'])
      figure, axes = plt.subplots(1, 2, figsize=(10, 5), sharex=True, sharey=True)

      ax = axes.ravel()
      ax[0].imshow(crop1)
      ax[1].imshow(crop2)
      ax[0].set_title(f"new (x: {x}, y: {y}, w: {w}, h: {h})")
      ax[1].set_title("ref")

      figure.canvas.draw()
      xlabels = [item.get_text() for item in ax[0].get_xticklabels()]
      ylabels = [item.get_text() for item in ax[0].get_yticklabels()]
      for i, label in enumerate(xlabels):
        try:                                  # The minus signs for negative numbers is encoded as a "minus" (Unicode 2212).
          xlabels[i] = int(label) + roi['x']
        except:
          continue

      for i, label in enumerate(ylabels):
        try:
          ylabels[i] = int(label) + roi['y']
        except:
          continue

      ax[0].set_xticklabels(xlabels)
      ax[0].set_yticklabels(ylabels)

      plt.subplots_adjust(bottom=0.15, wspace=0.01)
      pdf.savefig(figure, orientation='portrait')
      plt.close()

  print("Report done: ", report_url)
  return jsonify(report_url)


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