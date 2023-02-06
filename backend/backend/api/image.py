"""
Returns a list of rois.
Create a pdf report of rois comparison.
"""
import time
from pathlib import Path
from functools import lru_cache

import numpy as np
from requests.utils import unquote
from flask import request, jsonify

from cde.image import read_image, ImageType
from qaboard.api import url_to_dir 

from backend import app
from ..models import Output
from ..config import qaboard_url
from .image_diff import find_rois

@lru_cache(maxsize=2)
def cached_read_image(image_path):
  """
  Simple LRU cache - the downside is that our images are huge so with 8 workers each saving 2 image, each 300MB, it's bad...
  """
  image, meta = read_image(image_path)
  return image, meta


# TODO: - add locking when working with flask
#         import threading # Lock, Semaphore
#       - check locking works ok with uwsgi
try:
  import uwsgi
  under_uwsgi = True
except:
  under_uwsgi = False

import json
import time
import hashlib

from backend.config import qaboard_data_dir
image_cache_dir = qaboard_data_dir / 'cache' / 'images'
image_cache_dir = Path('/algo/qa_db/image_cache') # TODO: remove for the open-source version
image_cache_dir.mkdir(exist_ok=True, parents=True)

def clear_memmapped_cache_dir():
    cache_size = 20
    file_data = list(image_cache_dir.glob('*.dat'))
    file_data.sort(key=lambda f: -f.stat().st_mtime) # oldest last
    for file in file_data[cache_size:]:
        print(f"RM {file}")
        file.unlink(missing_ok=True)
        file_info = file.with_suffix('.json')
        file_info.unlink(missing_ok=True)

def memmapped_read_image(image_path):
  key = f"{image_path}-{image_path.stat().st_mtime}"
  hash = hashlib.sha1(key.encode()).hexdigest()
  image_cache_data = image_cache_dir / f"{hash}.dat"
  image_cache_info = image_cache_dir / f"{hash}.json"
  if not (image_cache_data.exists() and image_cache_info.exists()):
    clear_memmapped_cache_dir()
    # if under_uwsgi:
    #   # worst case the 1st requests will write multiple times that file...
    #   uwsgi.lock()
    # print(f'MISS {image_path}')
    image, meta = read_image(image_path)
    # print(f'READ', meta)
    with image_cache_info.open('w') as fmeta:
      json.dump({"meta": meta, "shape": image.shape, "dtype": str(image.dtype)}, fmeta)
    fp = np.memmap(image_cache_data, dtype=image.dtype, mode='w+', shape=image.shape)
    fp[:] = image[:]
    fp.flush() # write to disk
    # print(f'WRITE')
    # if under_uwsgi:
    #   uwsgi.unlock()
    return fp, meta
  else:
    # print(f'HIT {hash}')
    with image_cache_info.open() as f:
      info = json.load(f)
    # print(info['meta'])
    fp = np.memmap(image_cache_data, dtype=info['dtype'], mode='r', shape=tuple(info['shape']))
    return fp, info['meta']


@app.route("/api/v1/output/image/pixel", methods=['GET', 'POST'])
def get_pixel():
  x = int(request.args['x'])-1
  y = int(request.args['y'])-1
  image_path = url_to_dir(request.args['image_url'])
  # We work with huge images (100-200MP). Loading them each request can be very slow (~seconds).
  # Since the frontend may request 5-10 pixel values per second, we need some form of caching.
  image, meta = memmapped_read_image(Path(image_path))
  # image, meta = cached_read_image(Path(image_path))
  # print('meta', meta)
  try:
    meta = ImageType(*meta)
  except:
    pass
  if isinstance(meta, ImageType):
    meta = {"mode": meta.id}
  return jsonify({
    "value": image[y,x].tolist(),
    "meta": meta,
  })


@app.route("/api/v1/output/image/diff", methods=['GET', 'POST'])
def get_rois():
  data = request.json
  print(data)
  start = time.time()
  image_path_new = url_to_dir(data['output_dir_url_new']) / data["path"]
  image_path_ref = url_to_dir(data['output_dir_url_ref']) / data["path"]
  blobs = find_rois(
    image_path_new,
    image_path_ref,
    data["diff_type"],
    data['threshold'],
    data['diameter'],
    data['count']
  )
  return jsonify(blobs)



@app.route("/api/v1/output/diff/report", methods=['GET', 'POST'])
def get_report():
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
  report_url = f"{qaboard_url}/s/{report_folder}/{time_string}_report.pdf"
  Path(report_folder).mkdir(parents=True, exist_ok=True)

  image_1, meta_1 = read_image(Path(new_url))
  image_2, meta_2 = read_image(Path(ref_url))

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
