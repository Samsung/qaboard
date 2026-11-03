"""
IQE's annotations, for QA-Board's image viewer (read-only). See backend/backend/annotations.py for the format.

IQE keeps annotations per workspace, on the images annotated: the runs' inputs, found by their path.
With its service account (QABOARD_IQE_USER, QABOARD_IQE_PASSWORD) we show the names of the workspaces and users.
"""
import os
import time

import requests

label = "IQE"
description = "The annotations of the run's input in IQE, by workspace"
group_noun = "workspace"

IQE_URL = os.environ.get("QABOARD_IQE_URL", "").rstrip("/")
# The web app's page of a workspace
IQE_WORKSPACE_URL = os.environ.get("QABOARD_IQE_WORKSPACE_URL", "")
USER = os.environ.get("QABOARD_IQE_USER")
PASSWORD = os.environ.get("QABOARD_IQE_PASSWORD")
TIMEOUT = 10
# Names change rarely
NAMES_TTL = 30 * 60

_token = None
_cache = {}  # key: (expires, value)


def _request(method, path, **kwargs):
  """IQE's API, with the service account's token when there is one"""
  global _token
  for attempt in range(2):
    if USER and PASSWORD and not _token:
      response = requests.post(f"{IQE_URL}/api/token", data={"username": USER, "password": PASSWORD}, timeout=TIMEOUT)
      response.raise_for_status()
      _token = response.json()["access_token"]
    headers = {"Authorization": f"Bearer {_token}"} if _token else {}
    response = requests.request(method, f"{IQE_URL}{path}", headers=headers, timeout=TIMEOUT, **kwargs)
    # the token expired (after 96h)
    if response.status_code == 401 and _token and attempt == 0:
      _token = None
      continue
    response.raise_for_status()
    return response.json()


def _cached(key, compute):
  expires, value = _cache.get(key, (0, None))
  if time.monotonic() > expires:
    value = compute()
    _cache[key] = (time.monotonic() + NAMES_TTL, value)
  return value


def usernames():
  """{user id: user name}, empty without the service account"""
  if not (USER and PASSWORD):
    return {}
  def compute():
    try:
      found = _request("GET", "/api/v1/users")
    except Exception:
      return {}
    return {u["id"]: u["username"] for u in found if u.get("username")}
  return _cached("users", compute)


def workspace(id):
  """{name, user: {username}, ...} of a workspace, empty without the service account"""
  if not (USER and PASSWORD):
    return {}
  def compute():
    try:
      return _request("GET", f"/api/v1/workspace/workspace-session/{id}")
    except Exception:
      return {}
  return _cached(("workspace", id), compute)


def annotations(path):
  if not IQE_URL:
    raise RuntimeError("QABOARD_IQE_URL is not set")
  # on all the workspaces: scope it to one image, the server joins whole tables otherwise
  found = _request("POST", "/api/v1/annotations_filtered", json={"image": {"path": path}})
  return from_iqe(found, usernames(), workspace)


def workspace_url(id):
  return IQE_WORKSPACE_URL.format(id=id) if IQE_WORKSPACE_URL else None


def from_iqe(found, users, workspace):
  """IQE's annotations (AnnotationRead) as {groups, annotations}. users: {id: name}, workspace(id) => its details"""
  groups, annotations = {}, []
  for a in found:
    roi = a.get("roi") or []
    if len(roi) != 4:  # rectangles only, all of them in practice
      continue
    x, y, w, h = roi
    id = a.get("workspace_session_id")
    author = users.get(a.get("user_id"))
    if id not in groups:
      details = workspace(id)
      owner = (details.get("user") or {}).get("username")
      groups[id] = {
        "id": id,
        "label": details.get("name") or f"Workspace {id}",
        "detail": f"by {owner}" if owner else None,
        "url": workspace_url(id),
        # users whose annotations these are: the viewer shows theirs first
        "users": [owner] if owner else [],
      }
    if author and author not in groups[id]["users"]:
      groups[id]["users"].append(author)
    fields = {"Importance": a.get("importance"), "By": author, "Highlight": a.get("highlighting")}
    fields.update({m["name"]: round(m["score"], 3) for m in a.get("metrics") or [] if m.get("score") is not None})
    annotations.append({
      "id": a["id"],
      "group": id,
      "x": x, "y": y, "w": w, "h": h,
      "label": (a.get("artifact") or {}).get("name") or (a.get("content") or {}).get("name") or "Annotation",
      "tags": a.get("tags") or [],
      "fields": {k: v for k, v in fields.items() if v is not None},
      "url": workspace_url(id),
    })
  # the most important first
  order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
  annotations.sort(key=lambda a: order.get(a["fields"].get("Importance"), 4))
  return {"groups": list(groups.values()), "annotations": annotations}
