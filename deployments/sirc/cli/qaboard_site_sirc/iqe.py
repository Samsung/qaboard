"""
IQE's annotations, for QA-Board's image viewer (read-only). See backend/backend/annotations.py for the format.

IQE keeps annotations per workspace, on the exact file annotated, identified by ImageDB's md5 (of the pixels: the
md5_data of QA-Board's manifests at SIRC) or its path.
"""
import os

import requests

label = "IQE"
description = "The annotations of the image in IQE, by workspace"
group_noun = "workspace"

IQE_URL = os.environ.get("QABOARD_IQE_URL", "").rstrip("/")
# The web app's page of a workspace
IQE_WORKSPACE_URL = os.environ.get("QABOARD_IQE_WORKSPACE_URL", "")
TIMEOUT = 10

# IQE's highlighting
COLORS = {"RED": "#e5484d", "GREEN": "#30a46c"}


def _find(image):
  # unauthenticated, and on all the workspaces: scope it to one image, the server joins whole tables otherwise
  response = requests.post(f"{IQE_URL}/api/v1/annotations_filtered", json={"image": image}, timeout=TIMEOUT)
  response.raise_for_status()
  return response.json()


def annotations(path, md5):
  if not IQE_URL:
    raise RuntimeError("QABOARD_IQE_URL is not set")
  found = _find({"md5": md5}) if md5 else []
  # md5s of the file and of the pixels differ: the path then
  if not found:
    found = _find({"path": path})
  return from_iqe(found)


def workspace_url(id):
  return IQE_WORKSPACE_URL.format(id=id) if IQE_WORKSPACE_URL else None


def from_iqe(found):
  """IQE's annotations (AnnotationRead) as {groups, annotations}"""
  groups, annotations = {}, []
  for a in found:
    roi = a.get("roi") or []
    if len(roi) != 4:  # rectangles only, all of them in practice
      continue
    x, y, w, h = roi
    workspace = a.get("workspace_session_id")
    groups.setdefault(workspace, {"id": workspace, "label": f"Workspace {workspace}", "url": workspace_url(workspace)})
    fields = {"Importance": a.get("importance")}
    fields.update({m["name"]: round(m["score"], 3) for m in a.get("metrics") or [] if m.get("score") is not None})
    annotations.append({
      "id": a["id"],
      "group": workspace,
      "x": x, "y": y, "w": w, "h": h,
      "label": (a.get("artifact") or {}).get("name") or (a.get("content") or {}).get("name") or "Annotation",
      "color": COLORS.get(a.get("highlighting")),
      "tags": a.get("tags") or [],
      "fields": {k: v for k, v in fields.items() if v is not None},
      "url": workspace_url(workspace),
    })
  # the most important first
  order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
  annotations.sort(key=lambda a: order.get(a["fields"].get("Importance"), 4))
  return {"groups": list(groups.values()), "annotations": annotations}
