"""Data folders, from the admin API and `qaboard-admin data-folders`: readable, never managed (backend/data_folders.py)"""
import pytest

from .test_admin_cli import run, events


@pytest.fixture
def admin(logged_in):
  return logged_in('root', is_admin=True)


@pytest.fixture
def datasets(tmp_path):
  folder = tmp_path / "datasets"
  (folder / "a").mkdir(parents=True)
  (folder / "a" / "0001.txt").write_text("hello")
  yield folder
  from backend import settings
  settings.invalidate_cache()


def test_admins_add_and_remove_data_folders(admin, datasets):
  from backend import files, storage
  assert not files.is_readable(str(datasets / "a"))
  assert admin.get(f'/s{datasets}/a').status_code == 403

  response = admin.post('/api/v1/admin/data-folders', json={"path": f"{datasets}/"})
  assert response.status_code == 201, response.get_json()
  assert response.get_json() == {"path": str(datasets), "reachable": True, "in_storage": False}
  listing = admin.get('/api/v1/admin/data-folders').get_json()
  assert [f["path"] for f in listing["data_folders"]] == [str(datasets)]
  assert listing["storage_roots"]

  # readable right away: the file browser lists it
  response = admin.get(f'/s{datasets}/a')
  assert response.status_code == 200, response.get_json()
  assert [e["name"] for e in response.get_json()["entries"]] == ["0001.txt"]
  # never managed: no writes, deletes or cleanups there
  assert not storage.is_storage_path(datasets / "a")
  assert datasets not in storage.all_storage_roots()

  assert admin.post('/api/v1/admin/data-folders', json={"path": str(datasets)}).status_code == 409
  # not in Admin → Settings, and not changed there
  settings_listing = admin.get('/api/v1/admin/settings').get_json()["settings"]
  assert 'storage.data_folders' not in {s["key"] for s in settings_listing}
  assert admin.post('/api/v1/admin/settings', json={"storage.data_folders": ["/mnt"]}).status_code == 400

  response = admin.delete('/api/v1/admin/data-folders', query_string={"path": str(datasets)})
  assert response.status_code == 200, response.get_json()
  assert admin.get('/api/v1/admin/data-folders').get_json()["data_folders"] == []
  assert admin.get(f'/s{datasets}/a').status_code == 403
  assert admin.delete('/api/v1/admin/data-folders', query_string={"path": str(datasets)}).status_code == 404
  assert [(e.action, e.target_label, e.actor_label) for e in events() if e.action.startswith('data_folder.')] == \
    [('data_folder.add', str(datasets), 'root'), ('data_folder.remove', str(datasets), 'root')]


def test_the_servers_and_systems_folders_are_refused(admin, datasets):
  from backend.config import qaboard_data_dir
  for path in ("/", "/etc", "/proc/self", "/var", str(qaboard_data_dir), f"{qaboard_data_dir}/cache", "relative", ""):
    response = admin.post('/api/v1/admin/data-folders', json={"path": path})
    assert response.status_code == 400, path
  response = admin.post('/api/v1/admin/data-folders', json={"path": str(datasets / "missing")})
  assert (response.status_code, response.get_json()["reason"]) == (400, "not_a_folder")
  assert admin.post('/api/v1/admin/data-folders', json={"path": str(datasets / "missing"), "check": False}).status_code == 201
  assert events('data_folder.add')[0].target_label == str(datasets / "missing")


def test_only_admins(logged_in, client, datasets):
  user = logged_in('alice')
  assert user.get('/api/v1/admin/data-folders').status_code == 403
  assert user.post('/api/v1/admin/data-folders', json={"path": str(datasets)}).status_code == 403
  assert client.post('/api/v1/admin/data-folders', json={"path": str(datasets)}).status_code in (401, 403)
  assert user.delete('/api/v1/admin/data-folders', query_string={"path": str(datasets)}).status_code == 403


def test_the_cli(datasets):
  result = run('data-folders', 'add', str(datasets))
  assert result.exit_code == 0, result.output
  assert run('data-folders', 'list').output.strip() == str(datasets)
  assert run('data-folders', 'add', '/etc').exit_code != 0
  assert run('data-folders', 'remove', str(datasets)).exit_code == 0
  assert run('data-folders', 'list').output.strip() == ''
  assert [(e.action, e.actor_label) for e in events() if e.action.startswith('data_folder.')] == \
    [('data_folder.add', 'qaboard-admin'), ('data_folder.remove', 'qaboard-admin')]
