"""
Tests for backend/locations.py: runs store their full location, storage locations say how the server reaches them.
"""
from pathlib import Path

import pytest

from backend import locations
from backend.locations import Location, UNREACHABLE


@pytest.fixture
def known(monkeypatch, tmp_path):
  """Storage locations, as if admins added them"""
  def set_locations(*items):
    monkeypatch.setattr(locations, "_load", lambda: locations.sort(items))
    locations.invalidate()
  set_locations(
    Location("s3://team-a/qaboard/", tmp_path / "team-a", ("team-a/",), id=1),
    Location("s3://team-a/qaboard/special/", tmp_path / "special", ("team-a/special",), id=2),
    Location("gs://public/", tmp_path / "public", ("*",), id=3),
  )
  yield set_locations
  locations.invalidate()


def test_paths_are_where_they_say(known):
  assert locations.local_path("/mnt/qaboard/a/b") == Path("/mnt/qaboard/a/b")
  assert locations.local_path("file:///mnt/disk2/a%20b") == Path("/mnt/disk2/a b")


def test_urls_are_where_their_location_is_mounted(known, tmp_path):
  assert locations.local_path("s3://team-a/qaboard/proj/-/01/run") == tmp_path / "team-a/proj/-/01/run"
  assert locations.local_path("s3://team-a/qaboard/special/x/y") == tmp_path / "special/x/y"  # the most specific
  assert locations.local_path("s3://team-a/qaboard") == tmp_path / "team-a"
  assert locations.local_path("s3://team-a/qaboard/a%20b/c") == tmp_path / "team-a/a b/c"


def test_unknown_locations_are_unreachable(known):
  for location in ("s3://team-b/qaboard/run", "s3://team-a/qaboardx/run", "s3://team-a/qaboard/../../etc", "s3://team-a/qaboard/a/../../b"):
    assert locations.local_path(location).is_relative_to(UNREACHABLE), location
    assert not locations.is_reachable(location)


def test_editing_a_location_moves_its_runs_not_what_they_say(known, tmp_path):
  run = "s3://team-a/qaboard/proj/-/01/run"
  known(Location("s3://team-a/qaboard/", tmp_path / "elsewhere", ("team-a/",), id=1))
  assert locations.local_path(run) == tmp_path / "elsewhere/proj/-/01/run"
  known()
  assert not locations.is_reachable(run)


def test_what_runs_store(known, tmp_path):
  assert locations.location_of(tmp_path / "team-a/proj/-/a b") == "s3://team-a/qaboard/proj/-/a%20b"
  assert locations.location_of(tmp_path / "special/x") == "s3://team-a/qaboard/special/x"
  assert locations.location_of("/var/qaboard/uploads/proj") == "/var/qaboard/uploads/proj"
  for path in (tmp_path / "team-a/proj/-/a b", tmp_path / "special/x/é"):
    assert locations.local_path(locations.location_of(path)) == path


@pytest.mark.parametrize("url", ["/mnt/x", "s3://a/b?c", "s3://a/../b", "s3://a/b#c", "bucket/x"])
def test_invalid_urls(url):
  with pytest.raises(ValueError):
    locations.normalize_url(url)


def test_normalized_urls():
  assert locations.normalize_url("S3://team-a/qaboard") == "s3://team-a/qaboard/"
  assert locations.normalize_url("file:///mnt/disk2/") == "file:///mnt/disk2/"


def test_where_projects_runs_go(known):
  assert [l.id for l in locations.for_project("team-a/special")] == [2, 1, 3]
  assert [l.id for l in locations.for_project("team-a/proj")] == [1, 3]
  assert [l.id for l in locations.for_project("team-ab/proj")] == [3]
  known()
  assert locations.for_project("team-a/proj") == []


def test_without_the_table_the_server_works():
  # backend.models is mocked here: like a server whose database doesn't have the table yet
  locations.invalidate()
  assert locations.locations() == ()
  assert locations.local_path("s3://x/y").is_relative_to(UNREACHABLE)
  locations.invalidate()


@pytest.fixture
def storage(monkeypatch, tmp_path):
  """A storage root, with an upload root in it"""
  from backend import config
  root = tmp_path / "storage"
  (root / "uploads").mkdir(parents=True)
  monkeypatch.setattr(config, "storage_roots", [root])
  monkeypatch.setattr(config, "upload_root", root / "uploads")
  return root


def test_the_upload_root_is_the_default_location(known, storage, tmp_path):
  default = locations.default()
  assert default.is_default and default.path == storage / "uploads"
  # last: after the locations that list the project, "*" included
  assert [l.id for l in locations.for_project("team-b/proj")] == [3, None]
  assert [l.id for l in locations.for_project("team-a/proj")] == [1, 3, None]
  known(Location("s3://team-a/qaboard/", tmp_path / "team-a", ("team-a/",), id=1))
  assert locations.for_project("team-b/proj") == [default]
  assert storage / "uploads" in locations.paths() and tmp_path / "team-a" in locations.paths()
  # its runs store paths
  assert locations.location_of(storage / "uploads/proj/-/01") == str(storage / "uploads/proj/-/01")


def test_without_an_upload_root_there_is_no_default_location(known, monkeypatch):
  from backend import config
  monkeypatch.setattr(config, "upload_root", None)
  assert locations.default() is None
  assert [l.id for l in locations.for_project("team-b/proj")] == [3]
  known()
  assert locations.for_project("team-b/proj") == []


def test_locations_must_be_in_the_storage_roots(storage, tmp_path):
  (storage / "team-a").mkdir()
  assert locations.check_path(f"{storage}/team-a/") == str(storage / "team-a")
  outside = tmp_path / "elsewhere"
  outside.mkdir()
  for path in (outside, "/etc", f"{storage}/../elsewhere"):
    with pytest.raises(locations.LocationError) as e:
      locations.check_path(str(path))
    assert e.value.reason == "outside_storage_roots", path
  # symlinks are resolved
  (storage / "link").symlink_to(outside, target_is_directory=True)
  with pytest.raises(locations.LocationError):
    locations.check_path(str(storage / "link"))
  assert locations.outside_storage_roots(outside) and not locations.outside_storage_roots(storage / "team-a")


def test_location_paths_are_folders_the_server_sees(storage):
  with pytest.raises(locations.LocationError) as e:
    locations.check_path(str(storage / "not-mounted"))
  assert e.value.reason == "not_a_folder"
  assert locations.check_path(str(storage / "not-mounted"), check=False) == str(storage / "not-mounted")
  with pytest.raises(locations.LocationError):
    locations.check_path("relative/path")


@pytest.mark.parametrize("projects", ["team-a/", [""], [1], ["  "]])
def test_invalid_projects(projects):
  with pytest.raises(locations.LocationError):
    locations.check_projects(projects)


def test_projects_are_cleaned():
  assert locations.check_projects([" team-a/ ", "*", "team-a/"]) == ["team-a/", "*"]
  assert locations.check_projects(None) == []
