"""
Annotations of images, from other apps: the regions people marked on them, e.g. defects, in groups (who annotated,
for what: a project, a task, a workspace...). The image viewer shows them as regions of interest, read-only.

Sites add their sources with a package, like the site defaults (qaboard/site_config.py): an entry point in the group
"qaboard.annotations", which names a module or an object with

    label = "Defects"                 # what users pick in the viewer
    description = "From our app"      # optional, on hover
    group_noun = "project"            # optional, what the groups are (by default "group")

    def annotations(path: str, md5: Optional[str]) -> dict:
        # path: the image's absolute path on the server, md5: of the file if we know it
        return {
          # e.g. who annotated, or a task. The viewer filters by group and links to them.
          "groups": [{"id": "12", "label": "Night scenes", "detail": "by alice", "url": "https://..."}],
          # in the pixels of the image
          "annotations": [{"id": "1", "group": "12", "x": 10, "y": 20, "w": 30, "h": 40, "label": "Noise",
                           "color": "#e5484d", "tags": ["night"], "fields": {"Importance": "High"}, "url": "https://..."}],
        }

    [project.entry-points."qaboard.annotations"]
    defects = "my_site_package.defects"

All fields but x, y, w, h are optional. Groups without annotations are fine: e.g. where else the image is used.
Groups of annotations kept by QA-Board itself would be one more source.
"""
from functools import lru_cache
from typing import Any, Dict, Optional

from qaboard.site_config import site_entry_points

from .hybrid_cache import hybrid_cache


@lru_cache(maxsize=None)
def annotation_sources() -> Dict[str, Any]:
  """The sources installed: {id: source}"""
  sources = {}
  for entry_point in site_entry_points("qaboard.annotations"):
    try:
      sources[entry_point.name] = entry_point.load()
    except Exception as e:
      print(f"WARNING: could not load the annotation source {entry_point.name}: {e}")
  return sources


def describe_sources():
  """For the web app's config: [{id, label, description, group_noun}]"""
  return [
    {"id": id, "label": getattr(source, "label", id), "description": getattr(source, "description", None), "group_noun": getattr(source, "group_noun", None)}
    for id, source in annotation_sources().items()
  ]


# People annotate while others look: we ask again after a few minutes
@hybrid_cache(ttl=5 * 60, maxsize=512)
def annotations_of(source_id: str, path: str, md5: Optional[str], mtime_ns: int):
  """The annotations of the image, its version identified by mtime_ns"""
  found = annotation_sources()[source_id].annotations(path, md5) or {}
  return {
    "groups": [{**group, "id": str(group["id"])} for group in found.get("groups", [])],
    "annotations": [
      {**annotation, "id": str(annotation.get("id", i)), "group": None if annotation.get("group") is None else str(annotation["group"])}
      for i, annotation in enumerate(found.get("annotations", []))
    ],
  }
