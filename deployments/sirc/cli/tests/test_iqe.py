"""IQE's annotations, for QA-Board's image viewer. Run with: uv run --with pytest --with requests pytest deployments/sirc/cli/tests"""
from qaboard_site_sirc import iqe


def annotation(**fields):
  return {
    "id": 1, "roi": [10, 20, 30, 40], "shape": "Rect", "highlighting": "RED", "importance": "High",
    "workspace_session_id": 7, "artifact": {"id": 2, "name": "Ringing Edge"}, "content": None, "user_id": 2,
    "image": {"path": "/data/in.bmp", "md5": "abc", "id": 3},
    "metrics": [{"name": "rank", "score": 105.0, "id": 1}, {"name": "metric", "score": 2.6261625, "id": 2}],
    "tags": ["GEOMETRY"], "connections": [{"id": 2}],
    **fields,
  }


def test_from_iqe(monkeypatch):
  monkeypatch.setattr(iqe, "IQE_WORKSPACE_URL", "https://iqe/workspace/{id}")
  users = {1: "alice", 2: "bob"}
  # as IQE returns them
  workspaces = {7: {"id": 7, "name": "Night scenes", "user": {"username": "alice", "id": 1}, "images": [], "read_only": False}}
  found = iqe.from_iqe([
    annotation(id=1, importance="Low"),
    annotation(id=2, workspace_session_id=8, artifact=None, content={"name": "Sky"}, user_id=99),
    annotation(id=3, roi=[1, 2]),
  ], users, lambda id: workspaces.get(id, {}))
  assert found["groups"] == [
    {"id": 7, "label": "Night scenes", "detail": "by alice", "url": "https://iqe/workspace/7", "users": ["alice", "bob"]},
    # without the service account, or unknown
    {"id": 8, "label": "Workspace 8", "detail": None, "url": "https://iqe/workspace/8", "users": []},
  ]
  # the most important first, rectangles only
  assert [a["id"] for a in found["annotations"]] == [2, 1]
  assert found["annotations"][0] == {
    "id": 2, "group": 8, "x": 10, "y": 20, "w": 30, "h": 40, "label": "Sky", "tags": ["GEOMETRY"],
    "fields": {"Importance": "High", "Highlight": "RED", "rank": 105.0, "metric": 2.626},
    "url": "https://iqe/workspace/8",
  }
  assert found["annotations"][1]["fields"]["By"] == "bob"


class Response:
  def __init__(self, status, data=None):
    self.status_code, self.data = status, data

  def json(self):
    return self.data

  def raise_for_status(self):
    if self.status_code >= 400:
      raise RuntimeError(self.status_code)


def test_signs_in_again_when_the_token_expires(monkeypatch):
  monkeypatch.setattr(iqe, "IQE_URL", "https://iqe")
  monkeypatch.setattr(iqe, "USER", "svc")
  monkeypatch.setattr(iqe, "PASSWORD", "secret")
  monkeypatch.setattr(iqe, "_token", "old")
  calls = []
  monkeypatch.setattr(iqe.requests, "post", lambda url, data, timeout: calls.append("token") or Response(200, {"access_token": "new"}))
  def request(method, url, headers, timeout, **kwargs):
    calls.append(headers["Authorization"])
    return Response(401) if headers["Authorization"] == "Bearer old" else Response(200, [annotation()])
  monkeypatch.setattr(iqe.requests, "request", request)
  monkeypatch.setattr(iqe, "_cache", {"users": (float("inf"), {2: "bob"}), ("workspace", 7): (float("inf"), {})})
  found = iqe.annotations("/data/in.bmp")
  assert calls == ["Bearer old", "token", "Bearer new"]
  assert found["annotations"][0]["fields"]["By"] == "bob"
