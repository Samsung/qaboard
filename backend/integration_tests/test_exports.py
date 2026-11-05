"""Exports from the web app (backend/api/export_to_folder.py): the web app says how to name files, the server previews and exports"""
import os
import csv
import json

import pytest

from .test_jobs import World, storage, admin  # noqa: F401 (fixtures)


@pytest.fixture
def world(storage):
  return World(storage)


@pytest.fixture
def setup(world, admin, logged_in, storage):
  """Two new runs, and their reference runs on another commit. Exports go to storage.exports_root"""
  assert admin.post('/api/v1/admin/settings', json={"storage.exports_root": str(storage / 'exports')}).status_code == 200
  new_batch, ref_batch = world.batch('proj'), world.batch('proj', hexsha='b' * 40)
  new = [world.run(new_batch, deleted=False, files=True, size=10) for _ in range(2)]
  ref = [world.run(ref_batch, deleted=False, files=True, size=10) for _ in range(2)]
  world.commit()
  return logged_in('alice'), new, ref


def body(new, ref, **changes):
  """What the web app sends: reference runs are named like the new runs they're compared to"""
  runs = []
  for index, (n, r) in enumerate(zip(new, ref)):
    runs.append({"id": n.id, "side": "new", "fields": {"side": "new", "input": f"scene-{index}"}})
    runs.append({"id": r.id, "side": "reference", "fields": {"side": "v1.0", "input": f"scene-{index}"}})
  return {
    "project": "proj", "runs": runs, "files": "*.png", "template": "{input}__{settings}__{file}__{side}", "separator": "_",
    "type": "link", "folder": {"name": "night review", "id": "0123abcd"},
    "sides": {"new": {"project": "proj", "commit": "a" * 40, "batch": "default", "label": "new"},
              "reference": {"project": "proj", "commit": "b" * 40, "batch": "default", "label": "v1.0"}},
    **changes,
  }


def test_preview_then_export(setup, storage):
  from backend.models import Export
  alice, new, ref = setup
  preview = alice.post('/api/v1/exports/preview?project=proj', json=body(new, ref))
  assert preview.status_code == 200, preview.get_json()
  plan = preview.get_json()
  folder = plan["folder"]
  assert folder.startswith(str(storage / 'exports' / 'alice' / 'proj')) and folder.endswith('-night-review-0123abcd')
  # nothing is written
  assert not os.path.exists(folder)
  assert plan["nb_files"] == 4 and plan["nb_collisions"] == 0 and plan["nb_existing"] == 0 and plan["errors"] == []
  assert sorted(f["to"] for f in plan["files"]) == ['scene-0__image__new.png', 'scene-0__image__v1.0.png', 'scene-1__image__new.png', 'scene-1__image__v1.0.png']

  response = alice.post('/api/v1/exports?project=proj', json=body(new, ref))
  assert response.status_code == 200, response.get_json()
  result = response.get_json()
  assert result["folder"] == folder and result["nb_files_exported"] == 4 and result["errors"] == [] and result["export_id"]
  assert os.path.samefile(f"{folder}/scene-0__image__v1.0.png", ref[0].output_dir / 'image.png')
  # where each file comes from
  with open(f"{folder}/{result['mapping']}") as f:
    rows = list(csv.DictReader(f))
  assert {(r["name"], r["run"], r["side"]) for r in rows} >= {('scene-1__image__new.png', str(new[1].id), 'new')}
  details = json.loads(open(f"{folder}/0.export.json").read())
  assert details["template"] == "{input}__{settings}__{file}__{side}" and details["runs"][str(new[0].id)]["configurations"] == ['base']
  assert 'commit/' + 'a' * 40 in open(f"{folder}/0.qa.url").read()
  export = Export.query.filter(Export.path == folder).one()
  assert export.data["name"] == "night review" and export.created_by == 'alice'
  assert alice.get('/api/v1/storage/exports').get_json()["exports"][0]["name"] == "night review"

  # the same folder again: QA-Board made it, it replaces its files
  again = alice.post('/api/v1/exports/preview?project=proj', json=body(new, ref)).get_json()
  assert again["folder_exists"] and again["existing_policy"] == "replace" and again["nb_existing"] == 4


def test_names_must_be_unique(setup, storage):
  alice, new, ref = setup
  same_names = body(new, ref, template="{file}", folder={"id": "1111aaaa"})
  plan = alice.post('/api/v1/exports/preview?project=proj', json=same_names).get_json()
  assert plan["nb_collisions"] == 1 and plan["collisions"][0]["to"] == "image.png" and plan["collisions"][0]["count"] == 4
  response = alice.post('/api/v1/exports?project=proj', json=same_names)
  assert response.status_code == 409, response.get_json()
  assert not any((storage / 'exports').rglob('*1111aaaa*'))
  # names are case-insensitive, like on Windows shares
  cases = body(new[:1], ref[:1], template="{side}__{file}")
  cases["runs"][1]["fields"]["side"] = "NEW"
  assert alice.post('/api/v1/exports/preview?project=proj', json=cases).get_json()["nb_collisions"] == 1


def test_bad_requests(setup):
  alice, new, ref = setup
  def status(**changes):
    return alice.post('/api/v1/exports/preview?project=proj', json=body(new, ref, **changes)).status_code
  assert status(template="{input}__{nope}") == 400
  assert status(files="../*.png") == 400
  assert status(files="/etc/*") == 400
  assert status(runs=[{"id": 999999, "side": "new"}]) == 404
  assert status(folder={"id": "../../x"}) == 400
  assert status(folder={"path": "/etc"}) == 403
  assert status(type="move") == 400


def test_into_someone_s_folder(setup, storage):
  """In a folder that was there, files are added, and what's there is kept"""
  alice, new, ref = setup
  theirs = storage / 'team'
  theirs.mkdir()
  (theirs / 'scene-0__image__new.png').write_text('precious')
  request = body(new, ref, folder={"path": str(theirs), "id": "2222bbbb"})
  plan = alice.post('/api/v1/exports/preview?project=proj', json=request).get_json()
  assert plan["existing_policy"] == "keep" and plan["existing"] == ['scene-0__image__new.png']
  result = alice.post('/api/v1/exports?project=proj', json=request).get_json()
  assert result["nb_files_exported"] == 3 and result["nb_skipped"] == 1 and result["export_id"] is None
  assert (theirs / 'scene-0__image__new.png').read_text() == 'precious'
  assert (theirs / '0.export.csv').exists()
  # another export there doesn't replace the first one's mapping
  result = alice.post('/api/v1/exports?project=proj', json={**request, "folder": {"path": str(theirs), "id": "3333cccc"}}).get_json()
  assert result["mapping"] == '0.export-3333cccc.csv'


def test_folders_from_the_template(setup, storage):
  alice, new, ref = setup
  request = body(new, ref, template="{side}/{input}__{file}", folder={"id": "4444dddd"})
  result = alice.post('/api/v1/exports?project=proj', json=request).get_json()
  folder = result["folder"]
  assert sorted(os.listdir(f"{folder}/new")) == sorted(os.listdir(f"{folder}/v1.0")) == ['scene-0__image.png', 'scene-1__image.png']


def test_paths_windows_can_open(setup, storage):
  """By default, paths must be short enough for Windows. Users who don't open them on Windows can turn it off"""
  alice, new, ref = setup
  deep = storage / ('very-long-folder-name-' * 10)
  deep.mkdir()
  request = body(new, ref, folder={"path": str(deep), "id": "5555eeee"})
  plan = alice.post('/api/v1/exports/preview?project=proj', json=request).get_json()
  assert plan["windows"] and plan["nb_too_long"] == 4 and plan["too_long"][0]["length"] > plan["max_path"]
  response = alice.post('/api/v1/exports?project=proj', json=request)
  assert response.status_code == 409 and 'too long for Windows' in response.get_json()["error"]
  assert not any(p.name.endswith('.png') for p in deep.iterdir())
  result = alice.post('/api/v1/exports?project=proj', json={**request, "windows": False}).get_json()
  assert result["nb_too_long"] == 0 and result["nb_files_exported"] == 4


def test_the_older_api_is_unchanged(setup, storage):
  """Scripts still call /api/v1/export: same names, same files, and it says it's deprecated"""
  alice, new, ref = setup
  folder = storage / 'v1'
  response = alice.post(f'/api/v1/export/?project=proj&new_commit_id={"a" * 40}&ref_commit_id={"b" * 40}&path=*.png&export_dir={folder}')
  # the reference runs are on other inputs here: only the new runs are exported
  assert response.status_code == 200 and response.get_json()["nb_files_exported"] == 2, response.get_json()
  assert response.headers["Deprecation"] == "true" and '/api/v1/exports' in response.headers["Link"]
  assert (folder / '0.common.json').exists() and not (folder / '0.export.csv').exists()
