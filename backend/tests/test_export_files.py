"""backend/api/export_files.py: the web app says how to name files, the server lists, names and links them"""
import re
import sys
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def export_api(monkeypatch):
  """Loads the real backend/api/export_files.py"""
  monkeypatch.setattr(sys.modules['sqlalchemy.orm'], 'joinedload', MagicMock(), raising=False)
  path = Path(__file__).parent.parent / "backend" / "api" / "export_files.py"
  spec = importlib.util.spec_from_file_location("backend.api._export_files_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


def stored_run(tmp_path, id, input_path, files=('out.png',), configurations=('base',), extra_parameters=None, hexsha='a' * 40):
  """A run with files in its folder"""
  output_dir = tmp_path / str(id)
  for f in files:
    (output_dir / f).parent.mkdir(parents=True, exist_ok=True)
    (output_dir / f).write_text(f)
  commit = SimpleNamespace(hexsha=hexsha, project_id='proj')
  test_input = SimpleNamespace(abs_path=Path('/db') / input_path, path=Path(input_path), database=Path('/db'), data={})
  return SimpleNamespace(id=id, output_dir=output_dir, deleted=False, platform='linux', configurations=list(configurations),
                         extra_parameters=extra_parameters or {}, is_pending=False, test_input=test_input,
                         batch=SimpleNamespace(label='default', ci_commit=commit))


def test_plan_names_files_like_the_web_app(export_api, tmp_path):
  new = stored_run(tmp_path, 1, 'scenes/night.dng', files=('out.png', 'debug/mask.png', 'log.txt'))
  ref = stored_run(tmp_path, 2, 'scenes/night.dng', hexsha='b' * 40)
  items = [export_api.Item(new, 'new', {'side': 'new'}), export_api.Item(ref, 'reference', {'side': 'v1'})]
  plan = export_api.make_plan(items, '**/*.png', '{input}__{file}__{side}', '_')
  assert sorted(f['to'] for f in plan['files']) == ['scenes_night__debug_mask__new.png', 'scenes_night__out__new.png', 'scenes_night__out__v1.png']
  assert plan['collisions'] == [] and plan['runs'] == 2 and plan['runs_without_files'] == 0
  # without {side}, the new and reference files have the same names
  plan = export_api.make_plan(items, '*.png', '{input}__{file}', '_')
  assert [[f['to'] for f in same] for same in plan['collisions']] == [['scenes_night__out.png', 'scenes_night__out.png']]
  # a reference run named like several new runs is the same file under several names; the same file twice isn't a collision
  plan = export_api.make_plan([items[1], items[1]], '*.png', '{file}', '_')
  assert len(plan['files']) == 1 and plan['collisions'] == []


def test_plan_reports_what_it_cant_do(export_api, tmp_path):
  run = stored_run(tmp_path, 1, 'a.raw', files=('out.png', 'frames/1.png'))
  plan = export_api.make_plan([export_api.Item(run, 'new', {})], '*', '{file}', '_')
  assert [f['to'] for f in plan['files']] == ['out.png'] and plan['folders_skipped'] == 1
  plan = export_api.make_plan([export_api.Item(run, 'new', {'settings': 'x' * 300})], '*.png', '{settings}_{file}', '_')
  assert plan['files'] == [] and list(plan['errors']) and 'too long' in list(plan['errors'])[0]
  with pytest.raises(export_api.ExportError):
    export_api.check_pattern('../*.png')
  with pytest.raises(export_api.ExportError):
    export_api.check_pattern('**.png/x')


def test_windows_compatible_names(export_api, tmp_path):
  """By default, names must work on Windows: case-insensitive, and full paths under 260 characters"""
  new = stored_run(tmp_path, 1, 'a.raw', files=('Out.png',))
  ref = stored_run(tmp_path, 2, 'a.raw', files=('out.png',), hexsha='b' * 40)
  items = [export_api.Item(new, 'new', {}), export_api.Item(ref, 'reference', {})]
  assert len(export_api.make_plan(items, '*.png', '{file}', '_')['collisions']) == 1
  assert export_api.make_plan(items, '*.png', '{file}', '_', windows=False)['collisions'] == []
  # the folder's path counts, as Windows users see it
  folder = Path('/storage/' + 'x' * 240)
  long_settings = [export_api.Item(new, 'new', {'settings': 'gain=4,iso=100'})]
  plan = export_api.make_plan(long_settings, '*.png', '{input}__{settings}__{file}', '_', folder=folder)
  assert [length for length, _ in plan['too_long']] == [len(str(folder)) + 1 + len('a__gain=4,iso=100__Out.png')]
  assert export_api.make_plan(long_settings, '*.png', '{input}__{settings}__{file}', '_', folder=folder, windows=False)['too_long'] == []
  assert export_api.make_plan(long_settings, '*.png', '{file}', '_', folder=Path('/storage/short'))['too_long'] == []
  # characters Windows doesn't allow
  odd = [export_api.Item(new, 'new', {'settings': 'mode:"a|b"'})]
  assert export_api.make_plan(odd, '*.png', '{settings}_{file}', '_')['files'][0]['to'] == 'mode--a-b-_Out.png'
  assert export_api.make_plan(odd, '*.png', '{settings}_{file}', '_', windows=False)['files'][0]['to'] == 'mode:"a|b"_Out.png'


def test_copies_need_the_users_unix_account(export_api, monkeypatch):
  """Copies are made as the user: without their Unix account, the preview says so, before the export fails file after file"""
  monkeypatch.setattr(export_api, "unix_identity", lambda name: (1000, 100, [100]) if name == "alice" else (_ for _ in ()).throw(export_api.UnknownAccountError(name)))
  export_api.check_can_copy(SimpleNamespace(user_name="alice"))
  with pytest.raises(export_api.ExportError, match="doesn't know their Unix account") as e:
    export_api.check_can_copy(SimpleNamespace(user_name="ci[bot]"))
  assert e.value.status == 403
  with pytest.raises(export_api.ExportError):
    export_api.check_can_copy(None)


def gradient(path, size=(100, 50), mode='RGB'):
  """A real image whose pixel (x, y) is (x, y, 7): crops can be checked by their first pixel"""
  from PIL import Image
  image = Image.new(mode, size)
  image.putdata([(x, y, 7) if mode == 'RGB' else (x, y, 7, 255) for y in range(size[1]) for x in range(size[0])])
  path.parent.mkdir(parents=True, exist_ok=True)
  image.save(path)
  return path


def with_images(run, *files, **kwargs):
  for f in files:
    gradient(run.output_dir / f, **kwargs)
  return run


def region(name='roi', x=10, y=5, w=20, h=10, **kwargs):
  return {'name': name, 'x': x, 'y': y, 'w': w, 'h': h, 'unit': 'px', 'image_width': None, 'image_height': None, 'file': None, **kwargs}


def test_file_in_names_auto(export_api, tmp_path, monkeypatch):
  """With "auto", names leave out the file when each run has one, unless different files would get the same name"""
  a = stored_run(tmp_path, 1, 'scenes/a.raw', files=('out.png',))
  b = stored_run(tmp_path, 2, 'scenes/b.raw', files=('out.png',))
  items = [export_api.Item(a, 'new', {'side': 'new'}), export_api.Item(b, 'new', {'side': 'new'})]
  template = '{input}__{file}__{side}'
  plan = export_api.make_plan(items, '*.png', template, '_', file_in_names='auto')
  assert [f['to'] for f in plan['files']] == ['scenes_a__new.png', 'scenes_b__new.png']
  assert plan['file_in_names'] is False and plan['max_files_per_run'] == 1
  # by default, names have the file, like before
  plan = export_api.make_plan(items, '*.png', template, '_')
  assert [f['to'] for f in plan['files']] == ['scenes_a__out__new.png', 'scenes_b__out__new.png'] and plan['file_in_names'] is True
  # a run with two files: names keep the file
  two = stored_run(tmp_path, 3, 'scenes/c.raw', files=('out.png', 'mask.png'))
  plan = export_api.make_plan([*items, export_api.Item(two, 'new', {'side': 'new'})], '*.png', template, '_', file_in_names='auto')
  assert 'scenes_c__mask__new.png' in [f['to'] for f in plan['files']] and plan['file_in_names'] is True and plan['max_files_per_run'] == 2
  # different files with the same name without the file: names keep the file, and the runs are listed once
  listed = []
  list_files = export_api.list_files
  monkeypatch.setattr(export_api, 'list_files', lambda output, pattern: listed.append(output.id) or list_files(output, pattern))
  other = stored_run(tmp_path, 4, 'scenes/a.raw', files=('mask.png',))
  plan = export_api.make_plan([items[0], export_api.Item(other, 'new', {'side': 'new'})], '*.png', template, '_', file_in_names='auto')
  assert [f['to'] for f in plan['files']] == ['scenes_a__out__new.png', 'scenes_a__mask__new.png'] and plan['collisions'] == []
  assert plan['file_in_names'] is True and sorted(listed) == [1, 4]
  # names can't be made without the file
  plan = export_api.make_plan(items[:1], '*.png', '{file}', '_', file_in_names='auto')
  assert [f['to'] for f in plan['files']] == ['out.png'] and plan['file_in_names'] is True and not plan['errors']


def test_crops_of_regions(export_api, tmp_path):
  """Regions of interest of images are exported as crops, named with {region}"""
  run = with_images(stored_run(tmp_path, 1, 'scenes/a.raw', files=('out.png', 'out.raw', 'other.png')), 'out.png', 'other.png')
  regions = [
    region('roi', x=10, y=5, w=20, h=10, file='out.png'),
    region('half', x=0.5, y=0.5, w=0.25, h=0.5, unit='fraction', file='out.png'),
    # drawn on an image half the size
    region('scaled', x=10, y=5, w=10, h=5, image_width=50, image_height=25, file='out.png'),
    region('clamped', x=90, y=40, w=50, h=50, file='out.png'),
    region('far', x=200, y=0, w=10, h=10, file='out.png'),
    # every matching file
    region('all', x=0, y=0, w=1, h=1),
  ]
  items = [export_api.Item(run, 'new', {'side': 'new'}, regions)]
  plan = export_api.make_plan(items, '*', '{input}__{file}__{side}', '_')
  names = [(f['to'], f['region']['name'] if f['region'] else None) for f in plan['files']]
  assert names == [
    ('scenes_a__other__new.png', None), ('scenes_a__other__new__all.png', 'all'),
    ('scenes_a__out__new.png', None), ('scenes_a__out__new__roi.png', 'roi'), ('scenes_a__out__new__half.png', 'half'),
    ('scenes_a__out__new__scaled.png', 'scaled'), ('scenes_a__out__new__clamped.png', 'clamped'), ('scenes_a__out__new__far.png', 'far'),
    ('scenes_a__out__new__all.png', 'all'),
    ('scenes_a__out__new.raw', None),
  ]
  assert plan['nb_crops'] == 7 and plan['not_croppable'] == ['out.raw'] and plan['collisions'] == []
  # only the crops, named where the template says
  plan = export_api.make_plan(items, '*', '{input}__{region}__{file}', '_', whole_files=False)
  assert [f['to'] for f in plan['files']][:2] == ['scenes_a__all__other.png', 'scenes_a__roi__out.png'] and plan['nb_crops'] == len(plan['files'])

  export_dir = tmp_path / 'export'
  export_dir.mkdir()
  plan = export_api.make_plan(items, '*.png', '{input}__{file}__{side}', '_')
  exported, skipped, errors = export_api.execute(plan, export_dir, 'link', None, replace=True)
  from PIL import Image
  def crop(name):
    with Image.open(export_dir / f'scenes_a__out__new__{name}.png') as image:
      return image.size, image.getpixel((0, 0))
  assert crop('roi') == ((20, 10), (10, 5, 7))
  assert crop('half') == ((25, 25), (50, 25, 7))
  assert crop('scaled') == ((20, 10), (20, 10, 7))
  assert crop('clamped') == ((10, 10), (90, 40, 7))
  assert {f['region']['name']: f['crop'] for f in exported if f['region'] and f['file'] == 'out.png'} == {
    'roi': '10,5,20,10', 'half': '50,25,25,25', 'scaled': '20,10,20,10', 'clamped': '90,40,10,10', 'all': '0,0,1,1'}
  assert errors == ["Error when exporting out.png as scenes_a__out__new__far.png: region far is outside the image (100x50)"] and skipped == []
  # crops are new files, never links; whole files are links
  crop_path = export_dir / 'scenes_a__out__new__roi.png'
  assert not crop_path.is_symlink() and crop_path.stat().st_nlink == 1
  assert (export_dir / 'scenes_a__out__new.png').samefile(run.output_dir / 'out.png')
  # in our folders, crops are replaced, else kept
  exported, skipped, errors = export_api.execute(plan, export_dir, 'link', None, replace=True)
  assert len(exported) == len(plan['files']) - 1 and skipped == []
  exported, skipped, errors = export_api.execute(plan, export_dir, 'link', None, replace=False)
  assert len(skipped) == plan['nb_crops'] - 1 and len(exported) == 2

  # where crops come from
  exported, _, _ = export_api.execute(plan, export_dir, 'link', None, replace=True)
  mapping = export_api.write_mapping(export_dir, '0123abcd', exported, items, {}, replace=True)
  import csv
  with open(export_dir / mapping) as f:
    rows = {r['name']: r for r in csv.DictReader(f)}
  assert (rows['scenes_a__out__new__roi.png']['region'], rows['scenes_a__out__new__roi.png']['crop']) == ('roi', '10,5,20,10')
  assert (rows['scenes_a__out__new.png']['region'], rows['scenes_a__out__new.png']['crop']) == ('', '')


def test_crops_keep_the_images_format(export_api, tmp_path):
  from PIL import Image
  source = tmp_path / 'deep.png'
  Image.new('I;16', (40, 30), 1000).save(source)
  data, box = export_api.crop_image(source, region(x=0, y=0, w=10, h=10), '.png')
  (tmp_path / 'crop.png').write_bytes(data)
  with Image.open(tmp_path / 'crop.png') as image:
    assert image.size == (10, 10) and image.mode.startswith('I') and image.getpixel((0, 0)) == 1000
  # JPEGs can't have transparency
  rgba = gradient(tmp_path / 'rgba.png', mode='RGBA')
  data, box = export_api.crop_image(rgba, region(x=10, y=5, w=20, h=10), '.jpg')
  (tmp_path / 'crop.jpg').write_bytes(data)
  with Image.open(tmp_path / 'crop.jpg') as image:
    assert image.format == 'JPEG' and image.mode == 'RGB' and image.size == (20, 10)


def test_preview_says_where_files_come_from(export_api, tmp_path):
  run = with_images(stored_run(tmp_path, 1, 'a.raw', files=('out.png', 'log.bin')), 'out.png')
  items = [export_api.Item(run, 'new', {'side': 'new'}), export_api.Item(run, 'reference', {'side': 'v1'}, [region('roi'), region('roi', x=0)])]
  plan = export_api.make_plan(items, '*', '{file}__{region}', '_', file_in_names='auto')
  # the same file under the same name is exported once
  preview = export_api.describe(plan, items, tmp_path / 'export', True, True)
  assert [(f['to'], f['item'], f['region']) for f in preview['files']] == [
    ('log.bin', 0, None), ('out.png', 0, None), ('out__roi.png', 1, 'roi'), ('out__roi.png', 1, 'roi')]
  assert preview['nb_crops'] == 2 and preview['nb_not_croppable'] == 1 and preview['not_croppable'] == ['log.bin']
  assert preview['file_in_names'] is True and preview['max_files_per_run'] == 2
  # two different crops of the same file with the same name
  assert preview['nb_collisions'] == 1 and [s['region'] for s in preview['collisions'][0]['sources']] == ['roi', 'roi']


def test_regions_are_checked(export_api):
  ok = export_api.check_regions([{'name': ' roi ', 'x': 1, 'y': 2, 'w': 3, 'h': 4}], 0)
  assert ok == [{'name': 'roi', 'x': 1, 'y': 2, 'w': 3, 'h': 4, 'image_width': None, 'image_height': None, 'unit': 'px', 'file': None, 'label': None, 'source': None}]
  assert export_api.check_regions(None, 0) == []
  for regions, message in [
    ([{'x': 1, 'y': 2, 'w': 3, 'h': 4}], 'need a `name`'),
    ([{'name': '  ', 'x': 1, 'y': 2, 'w': 3, 'h': 4}], 'need a `name`'),
    ([{'name': 'a', 'x': float('nan'), 'y': 2, 'w': 3, 'h': 4}], '`x` must be a number'),
    ([{'name': 'a', 'x': '1', 'y': 2, 'w': 3, 'h': 4}], '`x` must be a number'),
    ([{'name': 'a', 'x': 1, 'y': 2, 'w': 0, 'h': 4}], 'must be positive'),
    ([{'name': 'a', 'x': 1, 'y': 2, 'w': 3, 'h': 4, 'unit': 'cm'}], '`unit`'),
    ([{'name': 'a', 'x': 1, 'y': 2, 'w': 3, 'h': 4, 'file': 3}], '`file`'),
    ([{'name': 'a', 'x': 1, 'y': 2, 'w': 3, 'h': 4}] * 501, 'at most 500 regions'),
    ({'name': 'a'}, 'a list'),
  ]:
    with pytest.raises(export_api.ExportError, match=message) as e:
      export_api.check_regions(regions, 3)
    assert e.value.status == 400 and 'runs[3]' in str(e.value)


def test_the_export_is_what_was_previewed(export_api, tmp_path, dummy_app, monkeypatch):
  """POST /api/v1/exports/preview then /api/v1/exports, with the new keys"""
  import json
  from flask import g
  a = with_images(stored_run(tmp_path, 1, 'scenes/a.raw', files=('out.png',)), 'out.png')
  b = with_images(stored_run(tmp_path, 2, 'scenes/b.raw', files=('out.png',)), 'out.png')
  monkeypatch.setattr(export_api, 'Output', MagicMock())
  export_api.Output.query.options.return_value.filter.return_value.all.return_value = [a, b]
  monkeypatch.setattr(export_api, 'check_folder', lambda export_dir: (not export_dir.exists(), True))
  # alice may act on the project: access rules are tested in test_security.py
  monkeypatch.setattr(export_api, 'require_project_access', lambda *args, **kwargs: None)
  folder = tmp_path / 'export'
  body = {
    "project": "proj", "files": "*.png", "template": "{input}__{file}__{side}", "folder": {"path": str(folder), "id": "0123abcd"},
    "file_in_names": "auto",
    "runs": [{"id": 1, "side": "new", "fields": {"side": "new", "region": "not-this"}, "regions": [{"name": "roi", "x": 10, "y": 5, "w": 20, "h": 10}]},
             {"id": 2, "side": "new", "fields": {"side": "new"}}],
  }
  def post(path, body):
    with dummy_app.test_request_context(path, method='POST', json=body):
      g.user = {"user_name": "alice"}
      g.actor = SimpleNamespace(user=None)
      response = export_api.export_runs()
      response, status = response if isinstance(response, tuple) else (response, 200)
      return status, response.get_json()
  status, preview = post('/api/v1/exports/preview', body)
  assert status == 200, preview
  assert [(f['to'], f['item'], f['region']) for f in preview['files']] == [
    ('scenes_a__new.png', 0, None), ('scenes_a__new__roi.png', 0, 'roi'), ('scenes_b__new.png', 1, None)]
  assert preview['file_in_names'] is False and preview['max_files_per_run'] == 1 and preview['nb_crops'] == 1 and not folder.exists()
  status, result = post('/api/v1/exports', body)
  assert status == 200, result
  assert result['nb_files_exported'] == 3 and result['errors'] == [] and [f['to'] for f in result['files']] == [f['to'] for f in preview['files']]
  details = json.loads((folder / '0.export.json').read_text())
  assert details['nb_crops'] == 1 and details['file_in_names'] is False and details['whole_files'] is True
  assert [(r['name'], r['crop']) for r in details['files']][:2] == [('scenes_a__new.png', ''), ('scenes_a__new__roi.png', '10,5,20,10')]
  # what's checked
  for changes, message in [({"file_in_names": "yes"}, "file_in_names"), ({"runs": [{"id": 1, "regions": [{"x": 1}]}]}, "runs\\[0\\].regions\\[0\\]")]:
    status, error = post('/api/v1/exports/preview', {**body, **changes})
    assert status == 400 and re.search(message, error['error']), error
  monkeypatch.setattr(export_api, 'MAX_CROPS', 0)
  status, error = post('/api/v1/exports/preview', body)
  assert status == 400 and 'Too many crops' in error['error']
