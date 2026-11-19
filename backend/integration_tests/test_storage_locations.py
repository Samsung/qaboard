"""Storage locations, from the admin API and `qaboard-admin storage-locations`: backend/locations.py"""
import pytest
from click.testing import CliRunner

from .test_admin_cli import run, events


@pytest.fixture
def admin(logged_in):
  return logged_in('root', is_admin=True)


@pytest.fixture
def root(tmp_path, monkeypatch):
  """A storage root, with a mounted bucket in it, and an upload root"""
  from backend import config, locations
  storage = tmp_path / "storage"
  (storage / "team-a").mkdir(parents=True)
  (storage / "uploads").mkdir()
  monkeypatch.setattr(config, "storage_roots", [storage])
  monkeypatch.setattr(config, "upload_root", storage / "uploads")
  locations.invalidate()
  yield storage
  locations.invalidate()


def add(client, **body):
  return client.post('/api/v1/admin/storage-locations', json=body)


def test_admins_add_change_and_remove_locations(admin, root):
  from backend import locations
  response = add(admin, url="S3://team-a-bucket/qaboard", path=f"{root}/team-a/", projects=["team-a/"])
  assert response.status_code == 201, response.get_json()
  location = response.get_json()
  assert location["url"] == "s3://team-a-bucket/qaboard/" and location["path"] == str(root / "team-a")
  assert location["outside_storage_roots"] is False and location["reachable"] is True

  listing = admin.get('/api/v1/admin/storage-locations').get_json()
  assert [l["url"] for l in listing["locations"]] == ["s3://team-a-bucket/qaboard/"]
  assert listing["locations"][0]["runs"] == 0
  assert listing["default"] == {"path": str(root / "uploads"), "reachable": True}
  assert listing["storage_roots"] == [str(root)]
  # the server uses it right away, the default location last
  assert [l.url for l in locations.for_project("team-a/proj")] == ["s3://team-a-bucket/qaboard/", None]

  response = admin.post(f'/api/v1/admin/storage-locations/{location["id"]}', json={"projects": ["team-a/", "team-b/"]})
  assert response.status_code == 200, response.get_json()
  assert response.get_json()["projects"] == ["team-a/", "team-b/"]
  assert [l.url for l in locations.for_project("team-b/x")][0] == "s3://team-a-bucket/qaboard/"

  response = admin.delete(f'/api/v1/admin/storage-locations/{location["id"]}')
  assert response.status_code == 200
  assert admin.get('/api/v1/admin/storage-locations').get_json()["locations"] == []
  assert [e.action for e in events() if e.action.startswith('storage_location.')] == \
    ['storage_location.create', 'storage_location.update', 'storage_location.delete']
  assert {e.actor_label for e in events() if e.action.startswith('storage_location.')} == {'root'}


def test_locations_stay_inside_the_storage_roots(admin, root, tmp_path):
  (tmp_path / "elsewhere").mkdir()
  for path in (str(tmp_path / "elsewhere"), "/etc", f"{root}/../elsewhere", "relative"):
    response = add(admin, url="s3://x/", path=path)
    assert response.status_code == 400, path
  assert add(admin, url="s3://x/", path=str(tmp_path / "elsewhere")).get_json()["reason"] == "outside_storage_roots"
  location = add(admin, url="s3://x/", path=str(root / "team-a")).get_json()
  response = admin.post(f'/api/v1/admin/storage-locations/{location["id"]}', json={"path": "/etc"})
  assert response.status_code == 400 and response.get_json()["reason"] == "outside_storage_roots"
  # nothing changed
  assert admin.get('/api/v1/admin/storage-locations').get_json()["locations"][0]["path"] == str(root / "team-a")


def test_what_runs_store_never_changes(admin, root):
  location = add(admin, url="s3://x/", path=str(root / "team-a")).get_json()
  response = admin.post(f'/api/v1/admin/storage-locations/{location["id"]}', json={"url": "s3://y/"})
  assert response.status_code == 400
  assert add(admin, url="s3://x", path=str(root / "team-a")).status_code == 409


def test_locations_with_runs_are_kept_unless_forced(admin, root):
  from backend.database import db_session
  from backend.models import Project, CiCommit, Batch, Output, TestInput
  location = add(admin, url="s3://x/", path=str(root / "team-a"), projects=["p"]).get_json()
  project = Project(id="p", data={})
  commit = CiCommit("a" * 40, project=project, branch="master")
  batch = Batch(ci_commit=commit, label="default")
  test_input = TestInput(path="input", database="/")
  db_session.add_all([project, commit, batch, test_input])
  db_session.add(Output(batch=batch, test_input=test_input, output_dir_override="s3://x/p/-/aa/run", platform="linux", configurations=[], extra_parameters={}))
  db_session.commit()
  assert admin.get('/api/v1/admin/storage-locations').get_json()["locations"][0]["runs"] == 1
  response = admin.delete(f'/api/v1/admin/storage-locations/{location["id"]}')
  assert response.status_code == 409 and response.get_json()["reason"] == "has_runs"
  assert admin.delete(f'/api/v1/admin/storage-locations/{location["id"]}?force=1').get_json()["runs"] == 1


def test_not_found(admin, root):
  assert admin.post('/api/v1/admin/storage-locations/123', json={}).status_code == 404
  assert admin.delete('/api/v1/admin/storage-locations/123').status_code == 404


def test_the_cli(root):
  result = run('storage-locations', 'add', 's3://team-a/', str(root / "team-a"), '--project', 'team-a/')
  assert result.exit_code == 0, result.output
  result = run('storage-locations', 'add', 's3://elsewhere/', '/etc')
  assert result.exit_code != 0 and "storage roots" in result.output
  result = run('storage-locations', 'add', 's3://missing/', str(root / "missing"))
  assert result.exit_code != 0 and "--no-check" in result.output
  assert run('storage-locations', 'add', 's3://missing/', str(root / "missing"), '--no-check').exit_code == 0
  result = run('storage-locations', 'set', 's3://team-a/', '--no-projects')
  assert result.exit_code == 0, result.output
  result = run('storage-locations', 'list')
  assert "s3://team-a/" in result.output and "(none: no new runs go there)" in result.output
  assert f"(default)\n  path: {root / 'uploads'}" in result.output
  assert run('storage-locations', 'remove', 's3://team-a/').exit_code == 0
  assert {e.actor_label for e in events() if e.action.startswith('storage_location.')} == {'qaboard-admin'}


def test_older_locations_outside_the_storage_roots_are_flagged(admin, root, tmp_path):
  from backend.database import db_session
  from backend.models import StorageLocation
  db_session.add(StorageLocation(url="s3://old/", path=str(tmp_path), projects=[], options={}))
  db_session.commit()
  assert admin.get('/api/v1/admin/storage-locations').get_json()["locations"][0]["outside_storage_roots"] is True
  assert "WARNING: outside $QABOARD_STORAGE_ROOTS" in run('storage-locations', 'list').output
