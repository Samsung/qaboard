"""
Track output images with http://gitlab-srv/Application-CIS/idb
"""
import re
import json
import shlex
from typing import Optional

from idb_client import client
from idb_client.v2.client import DuplicateMD5KeyError
from idb_client.v2.utils import Md5HashCalculator

from .config import commit_id, project


cde_images = ("output.png", "output.bmp")


def update_idb(run_context, input_files, outputs_manifest, manifest_path_str):
  # we don't really know what the main input file is, but we can guess
  if run_context.input_path.is_file():
    raw_path = run_context.input_path
    raw_info = input_files[manifest_path_str(run_context.input_path)]
  else:
    raw_path, raw_info = [i for i in input_files.items()][0]
  raw_md5 = raw_info["md5"]

  # we need to make some assumptions to extra CDE info, like assuming
  # the output images are where CDE ran, using cde-python
  cde_run_dirs = [
    re.sub("cde.sh$", "", path)
    for path in outputs_manifest
    if path.endswith("cde.sh")
  ]

  def crop_run(run_dir: str) -> Optional[str]:
    cde_sh_path = run_context.output_dir / f"{run_dir}cde.sh"
    try:
        with open(cde_sh_path, 'r') as f:
            cde_sh = f.read()
    except FileNotFoundError:
        print(f"Warning: cde.sh file not found at {cde_sh_path}. Skipping crop extraction.")
        return None
    except Exception as e:
        print(f"Error reading cde.sh at {cde_sh_path}: {e}. Skipping crop extraction.")
        return None
      
    crops = {}
    crop_name = None
    for arg in shlex.split(cde_sh):
      if crop_name and arg.startswith("-"):
        crop_name = None
      if arg.startswith("-crop"):
        crop_name = arg.replace("-crop", "")
      if crop_name:
        crops[crop_name] = arg
    crop_names = ["X", "Y", "W", "H"]
    if all([crops.get(n) for n in crop_names]):
      return ','.join([crops[n] for n in crop_names])
    return None

  for cde_run_dir in cde_run_dirs:
    for image in cde_images:
      output_image = f"{cde_run_dir}{image}"
      if output_image not in outputs_manifest:
        continue

      image_path = run_context.output_dir / output_image
      
      # Handle 0-sized files
      if not image_path.exists() or image_path.stat().st_size == 0:
          print(f"Warning: Image file {image_path} does not exist or is empty. Skipping.")
          continue

      image_md5 = Md5HashCalculator.from_image(image_path)

      image = {
        "md5": image_md5,
        "metadata": {
          "path": str(image_path),
          "raw_md5": raw_md5,
          "raw_path": str(raw_path), # the source image path (raw_path) should be taken from the idb image metadata (document) 
          "project": str(project.name),
          "commit": commit_id,
          "qaboard_run_id": run_context.id,
          "batch_label": run_context.obj['batch_label'],
          "run_context": json.load((run_context.output_dir / 'run.json').open())
      }}
      crop_str = crop_run(cde_run_dir)
      if crop_str:
        image["metadata"]["crop"] = crop_str
      collection = "rgb_images"
      client.tag(collection_name=collection, images=[image], allow_duplicates=True)

