"""
The annotations of the images of runs, from the site's sources (backend/annotations.py), for the image viewer.
"""
from flask import request, jsonify

from backend import app
from ..annotations import annotation_sources, annotations_of
from .files import readable_file


@app.route("/api/v1/output/image/annotations/<source_id>", methods=['GET'])
def get_annotations(source_id):
  """
  The annotations of an image: {groups, annotations}, see backend/annotations.py.
  Query: output_dir_url and path (the file of the run), md5 (of the file, optional: from the run's manifest).
  Users see the annotations of the files they can see.
  """
  if source_id not in annotation_sources():
    return jsonify({"error": f"Unknown annotation source: {source_id}"}), 404
  path = request.args.get('path')
  image_path, denied = readable_file(request.args.get('output_dir_url'), *([path] if path else []))
  if denied:
    return denied
  if not image_path.is_file():
    return jsonify({"error": f"Cannot find {image_path.name}"}), 404
  try:
    found = annotations_of(source_id, str(image_path), request.args.get('md5') or None, image_path.stat().st_mtime_ns)
  except Exception as e:
    label = getattr(annotation_sources()[source_id], 'label', source_id)
    return jsonify({"error": f"Could not get the annotations from {label}: {e}"}), 502
  return jsonify(found)
