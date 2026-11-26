"""
Tests for backend/data_folders.py: folders QA-Board reads (thumbnails, the file viewer) but never changes.
The split that matters: files.is_readable includes them, storage.check_storage_path (writes, deletes, cleanups) never.
"""
from pathlib import Path

import pytest

from backend import data_folders, files, storage, settings
from backend.data_folders import DataFolderError, check_path


@pytest.fixture
def folders(tmp_path, monkeypatch):
  """A storage root, a datasets folder outside it, the server's own folders, all under tmp_path"""
  for d in ["storage/project", "datasets/a", "server/data", "server/home", "elsewhere", "system/etc"]:
    (tmp_path / d).mkdir(parents=True)
  (tmp_path / "datasets/a/0001.png").write_bytes(b"png")
  private = [tmp_path / "server/data", tmp_path / "server/home", tmp_path / "datasets/a/.server"]
  monkeypatch.setattr(files, "storage_roots", [tmp_path / "storage"])
  monkeypatch.setattr(files, "private_dirs", lambda: private)
  monkeypatch.setattr(files.locations, "paths", lambda: [])
  monkeypatch.setattr(storage, "storage_roots", [tmp_path / "storage"])
  monkeypatch.setattr(storage, "private_dirs", lambda: private)
  monkeypatch.setattr(data_folders, "SYSTEM_DIRS", (tmp_path / "system/etc",))
  current = []
  monkeypatch.setattr(data_folders, "paths", lambda: list(current))
  current.append(str(tmp_path / "datasets"))
  return tmp_path, current


def test_data_folders_are_readable(folders):
  tmp_path, _ = folders
  assert files.is_readable(str(tmp_path / "datasets"))
  assert files.is_readable(str(tmp_path / "datasets/a/0001.png"))
  assert files.is_readable(str(tmp_path / "storage/project"))
  assert not files.is_readable(str(tmp_path / "elsewhere"))
  assert not files.is_readable(str(tmp_path / "datasets-other"))
  # the previous name reads the same
  assert files.is_listable(str(tmp_path / "datasets/a"))


def test_data_folders_are_never_managed(folders):
  """What writes, deletes, cleans, scans or counts storage checks storage.check_storage_path: never the data folders"""
  tmp_path, _ = folders
  for path in ("datasets", "datasets/a", "datasets/a/0001.png"):
    assert not storage.is_storage_path(tmp_path / path), path
    with pytest.raises(storage.UnsafePathError):
      storage.check_storage_path(tmp_path / path)
  # what jobs.common.storage_root, uploads and scans start from
  assert tmp_path / "datasets" not in storage.all_storage_roots()
  assert storage.is_storage_path(tmp_path / "storage/project")


def test_the_servers_folders_stay_unreadable_in_a_data_folder(folders):
  tmp_path, current = folders
  (tmp_path / "datasets/a/.server").mkdir()
  assert not files.is_readable(str(tmp_path / "datasets/a/.server"))
  # a data folder that contains them (e.g. /home): they stay unreadable
  current.append(str(tmp_path / "server"))
  assert files.is_readable(str(tmp_path / "server"))
  assert not files.is_readable(str(tmp_path / "server/home/.ssh/id_rsa"))


def test_symlinks_out_of_a_data_folder_are_not_followed(folders):
  tmp_path, current = folders
  (tmp_path / "datasets/escape").symlink_to(tmp_path / "elsewhere")
  (tmp_path / "datasets/system").symlink_to(tmp_path / "system/etc")
  assert not files.is_readable(str(tmp_path / "datasets/escape"))
  assert not files.is_readable(str(tmp_path / "datasets/system/passwd"))
  # a data folder replaced by a symlink to a system folder reads nothing
  (tmp_path / "swapped").symlink_to(tmp_path / "system/etc")
  current.append(str(tmp_path / "swapped"))
  assert not files.is_readable(str(tmp_path / "swapped/passwd"))


@pytest.mark.parametrize("path, expected", [
  ("/mnt/nas/datasets/", "/mnt/nas/datasets"),
  ("/mnt/nas//datasets/x/..", "/mnt/nas/datasets"),
  ("//mnt/nas", "/mnt/nas"),
  ("  /mnt/nas ", "/mnt/nas"),
])
def test_paths_are_normalized(path, expected):
  assert check_path(path, check=False) == expected


@pytest.mark.parametrize("path", [
  "", None, 3, "relative/datasets", "~/datasets", "/", "//", "/mnt/..", "/tmp", "/var",
  "/etc", "/etc/ssl", "/proc/self", "/proc", "/sys", "/dev", "/run/secrets", "/usr", "/var/lib/postgresql",
])
def test_invalid_or_forbidden_paths(path):
  with pytest.raises(DataFolderError):
    check_path(path, check=False)


def test_the_servers_own_folders_are_refused(folders):
  tmp_path, _ = folders
  for path in ("server/data", "server/data/cache", "server/home/.ssh", "datasets/a/.server/x"):
    with pytest.raises(DataFolderError) as e:
      check_path(str(tmp_path / path), check=False)
    assert e.value.reason == 'forbidden'
  for path in ("system", "system/etc", "system/etc/x"):
    with pytest.raises(DataFolderError):
      check_path(str(tmp_path / path), check=False)
  # one that contains them is fine: they stay unreadable
  assert check_path(str(tmp_path / "server"), check=False) == str(tmp_path / "server")


def test_the_servers_code_is_refused():
  with pytest.raises(DataFolderError):
    check_path(str(data_folders.CODE_DIR / "backend"), check=False)


def test_the_folder_must_exist_unless_asked(folders):
  tmp_path, _ = folders
  with pytest.raises(DataFolderError) as e:
    check_path(str(tmp_path / "missing"))
  assert e.value.reason == 'not_a_folder'
  assert check_path(str(tmp_path / "missing"), check=False) == str(tmp_path / "missing")


def test_the_setting_checks_its_folders(folders):
  tmp_path, _ = folders
  assert settings.validate(data_folders.KEY, [str(tmp_path / "datasets"), " /mnt/nas "]) == [str(tmp_path / "datasets"), "/mnt/nas"]
  for value in ([str(tmp_path / "system/etc")], ["/"], ["relative"], "/mnt/nas"):
    with pytest.raises(ValueError):
      settings.validate(data_folders.KEY, value)


def test_the_setting_is_edited_in_the_storage_page(monkeypatch):
  """Not in Admin → Settings: each change is a data_folder.* audit event. No environment variable either"""
  definition = settings.DEFINITIONS[data_folders.KEY]
  assert definition.edited_in and definition.env is None
  monkeypatch.setattr(settings, "_database_rows", lambda: {})
  monkeypatch.setattr(settings, "_user_names", lambda: {})
  keys = {s["key"] for s in settings.describe_all()}
  assert data_folders.KEY not in keys and 'storage.exports_root' in keys


def test_add_and_remove_record_audit_events(folders, monkeypatch):
  tmp_path, current = folders
  current.clear()
  saved, events = [], []
  def save(key, value, by=None):
    saved.append((key, value))
    current[:] = value or []
  monkeypatch.setattr(settings, "save", save)
  record = lambda action, **kwargs: events.append((action, kwargs["target_label"]))
  datasets = str(tmp_path / "datasets")
  assert data_folders.add(datasets + "/", record=record) == datasets
  assert saved == [(data_folders.KEY, [datasets])]
  with pytest.raises(DataFolderError) as e:
    data_folders.add(datasets, record=record)
  assert e.value.reason == 'exists'
  with pytest.raises(DataFolderError) as e:
    data_folders.add(str(tmp_path / "system/etc"), record=record)
  assert data_folders.remove(datasets + "/", record=record) == datasets
  assert saved[-1] == (data_folders.KEY, None)
  with pytest.raises(DataFolderError) as e:
    data_folders.remove(datasets, record=record)
  assert e.value.reason == 'not_found'
  assert events == [('data_folder.add', datasets), ('data_folder.remove', datasets)]


def test_serialize(folders, monkeypatch):
  tmp_path, _ = folders
  monkeypatch.setattr(storage, "all_storage_roots", lambda: [tmp_path / "storage"])
  assert data_folders.serialize(str(tmp_path / "datasets")) == {"path": str(tmp_path / "datasets"), "reachable": True, "in_storage": False}
  assert data_folders.serialize(str(tmp_path / "storage/project"))["in_storage"] is True
  assert data_folders.serialize(str(tmp_path / "missing"))["reachable"] is False
