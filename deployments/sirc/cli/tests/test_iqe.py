"""IQE's annotations, for QA-Board's image viewer. Run with: uv run --with pytest --with requests pytest deployments/sirc/cli/tests"""
from qaboard_site_sirc import iqe


def annotation(**fields):
  return {
    "id": 1, "roi": [10, 20, 30, 40], "shape": "Rect", "highlighting": "RED", "importance": "High",
    "workspace_session_id": 7, "artifact": {"id": 2, "name": "Ringing Edge"}, "content": None,
    "image": {"path": "/data/out.bmp", "md5": "abc", "id": 3},
    "metrics": [{"name": "rank", "score": 105.0, "id": 1}, {"name": "metric", "score": 2.6261625, "id": 2}],
    "tags": ["GEOMETRY"], "connections": [{"id": 2}],
    **fields,
  }


def test_from_iqe(monkeypatch):
  monkeypatch.setattr(iqe, "IQE_WORKSPACE_URL", "https://iqe/workspace/{id}")
  found = iqe.from_iqe([
    annotation(id=1, importance="Low", highlighting="GREEN"),
    annotation(id=2, workspace_session_id=8, artifact=None, content={"name": "Sky"}),
    annotation(id=3, roi=[1, 2]),
  ])
  assert found["groups"] == [
    {"id": 7, "label": "Workspace 7", "url": "https://iqe/workspace/7"},
    {"id": 8, "label": "Workspace 8", "url": "https://iqe/workspace/8"},
  ]
  # the most important first, rectangles only
  assert [a["id"] for a in found["annotations"]] == [2, 1]
  assert found["annotations"][0] == {
    "id": 2, "group": 8, "x": 10, "y": 20, "w": 30, "h": 40, "label": "Sky", "color": "#e5484d",
    "tags": ["GEOMETRY"], "fields": {"Importance": "High", "rank": 105.0, "metric": 2.626},
    "url": "https://iqe/workspace/8",
  }
  assert found["annotations"][1]["color"] == "#30a46c"


def test_finds_by_md5_then_path(monkeypatch):
  asked = []
  monkeypatch.setattr(iqe, "IQE_URL", "https://iqe")
  monkeypatch.setattr(iqe, "_find", lambda image: asked.append(image) or ([annotation()] if "path" in image else []))
  assert len(iqe.annotations("/data/out.bmp", "abc")["annotations"]) == 1
  assert asked == [{"md5": "abc"}, {"path": "/data/out.bmp"}]
