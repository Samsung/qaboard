"""
The annotations of the runs' inputs, from the site's sources (backend/annotations.py), for the image viewer.
"""
from urllib.parse import quote

from flask import request, jsonify

from backend import app
from ..annotations import annotation_sources, annotations_of, for_user, image_size
from .auth import get_current_user
from .files import readable_file


@app.route("/api/v1/output/image/annotations/<source_id>", methods=['GET'])
def get_annotations(source_id):
  """
  The annotations of an image: {groups, annotations, width, height}, see backend/annotations.py. Groups say if they're
  the user's (mine). width and height: of the input, to place the annotations on images of other sizes (null if unknown).
  Query: path, the absolute path of a run's input. Users see the annotations of the files they can see.
  """
  if source_id not in annotation_sources():
    return jsonify({"error": f"Unknown annotation source: {source_id}"}), 404
  path = request.args.get('path')
  if not path or not path.startswith('/'):
    return jsonify({"error": "path must be the absolute path of the input"}), 400
  image_path, denied = readable_file(f"/s{quote(path)}")
  if denied:
    return denied
  if not image_path.exists():
    return jsonify({"error": f"Cannot find {image_path}"}), 404
  try:
    found = annotations_of(source_id, str(image_path), image_path.stat().st_mtime_ns)
  except Exception as e:
    label = getattr(annotation_sources()[source_id], 'label', source_id)
    return jsonify({"error": f"Could not get the annotations from {label}: {e}"}), 502
  width, height = image_size(str(image_path))
  return jsonify({**for_user(found, get_current_user(to_jsonify=False).get('user_name')), "width": width, "height": height})
