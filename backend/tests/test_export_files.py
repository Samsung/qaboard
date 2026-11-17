"""backend/api/export_files.py: the web app says how to name files, the server lists, names and links them"""
import os
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
  plan = export_api.make_plan([export_api.Item(run, 'new', {})], '*', '{file}', '_', folders=False)
  assert [f['to'] for f in plan['files']] == ['out.png'] and plan['folders_skipped'] == 1
  plan = export_api.make_plan([export_api.Item(run, 'new', {'settings': 'x' * 300})], '*.png', '{settings}_{file}', '_')
  assert plan['files'] == [] and list(plan['errors']) and 'too long' in list(plan['errors'])[0]
  with pytest.raises(export_api.ExportError):
    export_api.check_pattern('../*.png')
  with pytest.raises(export_api.ExportError):
    export_api.check_pattern('**.png/x')


def test_folders_are_exported_with_their_files(export_api, tmp_path):
  """A pattern that matches a folder, e.g. "dma_out": the folder is named like a file, its files keep their names"""
  new = stored_run(tmp_path, 1, 'scenes/night.dng', files=('dma_out/frame_0.bin', 'dma_out/sub/frame:1.bin', 'out.png'))
  ref = stored_run(tmp_path, 2, 'scenes/night.dng', files=('dma_out/frame_0.bin',), hexsha='b' * 40)
  items = [export_api.Item(new, 'new', {'side': 'new'}), export_api.Item(ref, 'reference', {'side': 'ref'})]
  plan = export_api.make_plan(items, 'dma_out', '{input}__{file}__{side}', '_')
  assert [f['to'] for f in plan['files']] == [
    'scenes_night__dma_out__new/frame_0.bin', 'scenes_night__dma_out__new/sub/frame-1.bin', 'scenes_night__dma_out__ref/frame_0.bin']
  assert plan['nb_folders'] == 2 and plan['nb_in_folders'] == 3 and plan['folders_skipped'] == 0 and plan['collisions'] == []
  assert plan['files'][1]['file'] == 'dma_out/sub/frame:1.bin' and plan['files'][1]['folder'] == {'to': 'scenes_night__dma_out__new', 'file': 'dma_out'}
  # one folder per run: like one file, names can leave it out
  plan = export_api.make_plan(items, 'dma_out', '{input}__{file}__{side}', '_', file_in_names='auto')
  assert plan['files'][0]['to'] == 'scenes_night__new/frame_0.bin' and plan['file_in_names'] is False
  # "*": the files, and the folders, whole
  plan = export_api.make_plan(items[:1], '*', '{file}__{side}', '_', windows=False)
  assert [f['to'] for f in plan['files']] == ['dma_out__new/frame_0.bin', 'dma_out__new/sub/frame:1.bin', 'out__new.png']
  # "**/*" matches the folders' files: they're exported, not the folders
  plan = export_api.make_plan(items[:1], '**/*', '{file}__{side}', '_')
  assert sorted(f['to'] for f in plan['files']) == ['dma_out_frame_0__new.bin', 'dma_out_sub_frame-1__new.bin', 'out__new.png'] and plan['nb_folders'] == 0
  # without folders
  plan = export_api.make_plan(items, 'dma_out', '{input}__{file}__{side}', '_', folders=False)
  assert plan['files'] == [] and plan['folders_skipped'] == 2 and plan['runs_without_files'] == 2
  # exported as real folders of hard links, that Windows shares open
  folder = tmp_path / 'export'
  folder.mkdir()
  plan = export_api.make_plan(items, 'dma_out', '{input}__{file}__{side}', '_')
  exported, skipped, problems = export_api.execute(plan, folder, 'link', None, replace=True, items=items)
  assert problems.count == 0 and len(exported) == 3 and not any(f.get('symlink') for f in exported)
  linked = folder / 'scenes_night__dma_out__new' / 'sub' / 'frame-1.bin'
  assert not linked.parent.is_symlink() and linked.samefile(new.output_dir / 'dma_out/sub/frame:1.bin')


def test_links_say_when_they_are_symbolic(export_api, tmp_path, monkeypatch):
  """Hard links don't cross filesystems: symbolic links instead, that Windows shares often can't open"""
  run = stored_run(tmp_path, 1, 'a.raw')
  items = [export_api.Item(run, 'new', {})]
  plan = export_api.make_plan(items, '*.png', '{file}', '_')
  monkeypatch.setattr(export_api.os, 'link', lambda *args: (_ for _ in ()).throw(OSError(18, 'Invalid cross-device link')))
  folder = tmp_path / 'export'
  folder.mkdir()
  exported, _, problems = export_api.execute(plan, folder, 'link', None, replace=True, items=items)
  assert problems.count == 0 and exported[0]['symlink'] and (folder / 'out.png').is_symlink()


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
  exported, skipped, problems = export_api.execute(plan, export_dir, 'link', None, replace=True)
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
  assert [(p['step'], p['actor'], p['code'], p['count'], p['examples'][0]['error']) for p in problems.describe(export_dir)] == [
    ('crop', 'server', 'ValueError', 1, 'region far is outside the image (100x50)')] and skipped == []
  # crops are new files, never links; whole files are links
  crop_path = export_dir / 'scenes_a__out__new__roi.png'
  assert not crop_path.is_symlink() and crop_path.stat().st_nlink == 1
  assert (export_dir / 'scenes_a__out__new.png').samefile(run.output_dir / 'out.png')
  # in our folders, crops are replaced, else kept
  exported, skipped, _ = export_api.execute(plan, export_dir, 'link', None, replace=True)
  assert len(exported) == len(plan['files']) - 1 and skipped == []
  exported, skipped, _ = export_api.execute(plan, export_dir, 'link', None, replace=False)
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


def test_reference_from_another_project(export_api, tmp_path, dummy_app, monkeypatch):
  """Runs compared with a reference from another project: both are exported, and the link back keeps the comparison"""
  from flask import g
  new = stored_run(tmp_path, 1, 'scenes/a.raw')
  ref = stored_run(tmp_path, 2, 'scenes/a.raw', hexsha='b' * 40)
  ref.batch.ci_commit.project_id = 'other/proj'
  # users act on the project's runs, and only need to see the reference's
  asked = []
  monkeypatch.setattr(export_api, 'require_project_access', lambda user, project, permission='runs.act': asked.append((project, permission)))
  monkeypatch.setattr(export_api, 'Output', MagicMock())
  export_api.Output.query.options.return_value.filter.return_value.all.return_value = [new, ref]
  monkeypatch.setattr(export_api, 'check_folder', lambda export_dir: (not export_dir.exists(), True))
  sides = {"new": {"project": "proj", "commit": "a" * 40, "batch": "default"},
           "reference": {"project": "other/proj", "commit": "b" * 40, "batch": "default"}}
  body = {
    "project": "proj", "files": "*.png", "folder": {"path": str(tmp_path / 'export'), "id": "0123abcd"}, "sides": sides,
    "runs": [{"id": 1, "side": "new", "fields": {"side": "new"}}, {"id": 2, "side": "reference", "fields": {"side": "v1"}}],
  }
  with dummy_app.test_request_context('/api/v1/exports', method='POST', json=body):
    g.user = {"user_name": "alice"}
    g.actor = SimpleNamespace(user=None)
    result = export_api.export_runs().get_json()
  assert [f['to'] for f in result['files']] == ['scenes_a__out__new.png', 'scenes_a__out__v1.png'] and result['nb_files_exported'] == 2
  assert ('proj', 'runs.act') in asked and ('other/proj', 'project.read') in asked and ('other/proj', 'runs.act') not in asked
  url = (tmp_path / 'export' / '0.qa.url').read_text()
  assert f"reference={'b' * 40}" in url and 'ref_project=other%2Fproj' in url
  # in the same project, the link doesn't say it
  assert 'ref_project' not in export_api.page_url({**sides, "reference": {**sides['reference'], "project": "proj"}})


def by_side(export_api, tmp_path):
  """"A folder for new, one for reference": the export makes new/ and reference/ in its folder"""
  new = stored_run(tmp_path, 1, 'scenes/a.raw')
  ref = stored_run(tmp_path, 2, 'scenes/a.raw', hexsha='b' * 40)
  items = [export_api.Item(new, 'new', {'side': 'new'}), export_api.Item(ref, 'reference', {'side': 'reference'})]
  return export_api.make_plan(items, '*.png', '{side}/{input}__{file}', '_')


def test_copies_folders_are_made_as_the_user(export_api, tmp_path, monkeypatch):
  """Copies are written as the user, and so are the folders they go in: the server may not be able to write where the user can"""
  calls = []
  def as_user(user, f, *args, **kwargs):
    calls.append((user, f.__name__, *map(str, args)))
    return f(*args, **kwargs)
  monkeypatch.setattr(export_api, 'as_user', as_user)
  plan = by_side(export_api, tmp_path)
  folder = tmp_path / 'copies'
  folder.mkdir()
  exported, skipped, problems = export_api.execute(plan, folder, 'copy', SimpleNamespace(user_name='alice'), replace=True)
  assert problems.count == 0 and skipped == [] and len(exported) == 2
  assert [c for c in calls if c[1] == 'mkdir_shared'] == [('alice', 'mkdir_shared', str(folder / 'new')), ('alice', 'mkdir_shared', str(folder / 'reference'))]
  assert (folder / 'new' / 'scenes_a__out.png').read_text() == 'out.png'
  # links are made by the server, and so are their folders
  calls.clear()
  folder = tmp_path / 'links'
  folder.mkdir()
  exported, skipped, problems = export_api.execute(plan, folder, 'link', SimpleNamespace(user_name='alice'), replace=True)
  assert problems.count == 0 and len(exported) == 2 and calls == [] and (folder / 'reference' / 'scenes_a__out.png').is_file()


@pytest.mark.skipif(not hasattr(os, 'geteuid') or os.geteuid() != 0, reason="acts as another user: the server runs as root")
def test_copies_and_their_folders_belong_to_the_user(export_api, monkeypatch):
  """For real, as another account: in a folder that belongs to the user, new/ and reference/ are theirs, like the copies"""
  import shutil
  import tempfile
  uid = gid = 54321
  import backend.fs_utils as fs_utils
  monkeypatch.setattr(fs_utils, 'unix_identity', lambda user: (uid, gid, [gid]))
  # the user must reach the runs and the export folder: not in pytest's tmp_path, only root's
  base = Path(tempfile.mkdtemp())
  try:
    base.chmod(0o755)
    plan = by_side(export_api, base / 'runs')
    for path in (base / 'runs').rglob('*'):
      path.chmod(0o755 if path.is_dir() else 0o644)
    (base / 'runs').chmod(0o755)
    folder = base / 'theirs'
    folder.mkdir()
    folder.chmod(0o755)
    os.chown(folder, uid, gid)
    exported, skipped, problems = export_api.execute(plan, folder, 'copy', SimpleNamespace(user_name='alice'), replace=False)
    assert problems.describe(folder) == [] and len(exported) == 2
    for path in ('new', 'reference', 'new/scenes_a__out.png', 'reference/scenes_a__out.png'):
      assert (folder / path).stat().st_uid == uid, path
  finally:
    shutil.rmtree(base)


def failing(export_api, monkeypatch, about='destination', succeed_first=0):
  """Exports where each file fails like it does when the user can't write in the folder, or can't read the runs' files"""
  import errno
  done = []
  def export_file(source, dest, type, user=None):
    if len(done) < succeed_first:
      done.append(dest)
      return
    raise PermissionError(errno.EACCES, 'Permission denied', str(dest if about == 'destination' else source))
  monkeypatch.setattr(export_api, 'export_file', export_file)


def many_runs(export_api, tmp_path, n):
  return [export_api.Item(stored_run(tmp_path, i, f'scenes/{i}.raw'), 'new', {'side': 'new'}) for i in range(n)]


def test_failures_are_grouped_and_explained(export_api, tmp_path, monkeypatch):
  """Users see what went wrong once, with what to do, not one error per file; the first files all fail: we stop"""
  items = many_runs(export_api, tmp_path, 60)
  plan = export_api.make_plan(items, '*.png', '{input}__{file}__{side}', '_')
  folder = tmp_path / 'export'
  folder.mkdir()
  failing(export_api, monkeypatch)
  exported, skipped, problems = export_api.execute(plan, folder, 'copy', SimpleNamespace(user_name='alice'), replace=False, items=items)
  assert exported == [] and problems.count == export_api.GIVE_UP_AFTER and problems.not_attempted == 60 - export_api.GIVE_UP_AFTER
  [problem] = problems.describe(folder)
  assert (problem['step'], problem['actor'], problem['code'], problem['about'], problem['count']) == ('copy', 'alice', 'EACCES', 'destination', 50)
  assert problem['message'] == "Your account (alice) can't write in the export's folder (copying files)."
  assert str(folder) in problem['hint'] and len(problem['examples']) == 3
  assert problem['examples'][0] == {"file": "out.png", "to": "scenes_0__out__new.png", "side": "new",
                                    "error": f"Permission denied: '{folder / 'scenes_0__out__new.png'}'"}
  # scripts read `errors`: one line per problem
  [line] = problems.as_errors(folder)
  assert line.startswith("Your account (alice) can't write in the export's folder (copying files). (50 files) E.g. scenes_0__out__new.png: Permission denied")

  # the runs' files: copies are made as the user, they need to read them
  failing(export_api, monkeypatch, about='source')
  _, _, problems = export_api.execute(plan, folder, 'copy', SimpleNamespace(user_name='alice'), replace=False, items=items)
  [problem] = problems.describe(folder)
  assert problem['about'] == 'source' and problem['message'] == "Your account (alice) can't read these runs' files." and 'export links' in problem['hint']

  # some files are exported: we try them all
  failing(export_api, monkeypatch, succeed_first=1)
  exported, _, problems = export_api.execute(plan, folder, 'copy', SimpleNamespace(user_name='alice'), replace=False, items=items)
  assert len(exported) == 1 and problems.count == 59 and problems.not_attempted == 0


def test_failed_exports_are_reported_once(export_api, tmp_path, dummy_app, monkeypatch, capsys):
  """Admins get the tracebacks in the logs and one Sentry event per export, users a reference to give them"""
  import types
  from contextlib import contextmanager
  from flask import g
  items = many_runs(export_api, tmp_path, 3)
  outputs = [i.output for i in items]
  monkeypatch.setattr(export_api, 'Output', MagicMock())
  export_api.Output.query.options.return_value.filter.return_value.all.return_value = outputs
  monkeypatch.setattr(export_api, 'check_folder', lambda export_dir: (not export_dir.exists(), True))
  monkeypatch.setattr(export_api, 'require_project_access', lambda *args, **kwargs: None)
  monkeypatch.setattr(export_api, 'unix_identity', lambda name: (1000, 100, [100]))
  # what users can do is checked in test_copies_check_what_the_user_can_do
  monkeypatch.setattr(export_api, 'check_copies', lambda *args: {"folder_error": None, "unreadable": []})
  failing(export_api, monkeypatch)
  events = []
  scope = SimpleNamespace(tags={}, contexts={}, fingerprint=None)
  scope.set_tag = lambda key, value: scope.tags.__setitem__(key, value)
  scope.set_context = lambda key, value: scope.contexts.__setitem__(key, value)
  sentry = types.ModuleType('sentry_sdk')
  sentry.is_initialized = lambda: True
  sentry.new_scope = contextmanager(lambda: (yield scope))
  sentry.capture_exception = lambda error: events.append(error)
  monkeypatch.setitem(sys.modules, 'sentry_sdk', sentry)
  body = {"project": "proj", "files": "*.png", "type": "copy", "template": "{input}__{file}__{side}", "folder": {"path": str(tmp_path / 'export'), "id": "0123abcd"},
          "runs": [{"id": o.id, "side": "new", "fields": {"side": "new"}} for o in outputs]}
  with dummy_app.test_request_context('/api/v1/exports', method='POST', json=body):
    g.user = {"user_name": "alice"}
    g.actor = SimpleNamespace(user=SimpleNamespace(user_name='alice'))
    result = export_api.export_runs().get_json()
  assert result['nb_files_exported'] == 0 and result['nb_failed'] == 3 and result['nb_not_attempted'] == 0
  assert re.fullmatch(r'[0-9a-f]{12}', result['reference']) and [p['count'] for p in result['problems']] == [3]
  # no traceback for users
  assert 'Traceback' not in json_text(result)
  logs = capsys.readouterr().out
  assert f"export {result['reference']}: 3 files failed" in logs and 'Traceback' in logs and 'PermissionError' in logs
  assert len(events) == 1 and isinstance(events[0], PermissionError)
  assert scope.tags == {'export.reference': result['reference'], 'export.step': 'copy', 'export.by': 'user', 'export.error': 'EACCES'}
  assert scope.fingerprint == ['qaboard-export-failed', 'copy', 'user', 'EACCES', 'destination']
  context = scope.contexts['export']
  assert context["nb_failed"] == 3 and {k: v for k, v in context["copies_as"].items() if k != "groups_known"} == {"user": "alice", "uid": 1000, "gid": 100, "groups": [100]}
  assert context['folder_stat']['mode'] and context['server']['uid'] == os.geteuid()


def json_text(data):
  import json
  return json.dumps(data)


@pytest.mark.skipif(not hasattr(os, 'geteuid') or os.geteuid() != 0, reason="acts as another user: the server runs as root")
def test_copies_check_what_the_user_can_do(export_api, dummy_app, monkeypatch):
  """Before copying, as the user: can they write in the folder, read the runs' files? Not one error per file after"""
  import shutil
  import tempfile
  from flask import g
  uid = gid = 54321
  import backend.fs_utils as fs_utils
  monkeypatch.setattr(fs_utils, 'unix_identity', lambda user: (uid, gid, [gid]))
  monkeypatch.setattr(export_api, 'unix_identity', lambda user: (uid, gid, [gid]))
  monkeypatch.setattr(export_api, 'groups_known', lambda user: False)
  monkeypatch.setattr(export_api, 'check_folder', lambda export_dir: (not export_dir.exists(), False))
  base = Path(tempfile.mkdtemp())
  try:
    base.chmod(0o755)
    new = stored_run(base / 'runs', 1, 'scenes/a.raw')
    ref = stored_run(base / 'runs', 2, 'scenes/a.raw', hexsha='b' * 40)
    for path in [base / 'runs', *(base / 'runs').rglob('*')]:
      path.chmod(0o755 if path.is_dir() else 0o644)
    # the reference's files: only their owner reads them
    (ref.output_dir / 'out.png').chmod(0o600)
    items = [export_api.Item(new, 'new', {'side': 'new'}), export_api.Item(ref, 'reference', {'side': 'reference'})]
    # the server can write there, the user can't
    folder = base / 'servers'
    folder.mkdir()
    folder.chmod(0o755)
    def run(dry_run):
      with dummy_app.test_request_context('/api/v1/exports', method='POST'):
        g.user = {"user_name": "alice"}
        g.actor = SimpleNamespace(user=SimpleNamespace(user_name='alice'))
        return export_api.run_export(items, project_id='proj', pattern='*.png', template='{side}/{input}__{file}', separator='_', windows=True,
                                     export_type='copy', export_dir=folder, key='0123abcd', dry_run=dry_run, details={}, sides={})
    check = run(dry_run=True)['copy_check']
    assert check['user'] == 'alice' and check['groups_known'] is False and check['nb_checked'] == 2
    assert check['folder_error'] == f"Permission denied: '{folder}'"
    assert check['unreadable'] == [{"side": "reference", "error": f"Permission denied: '{ref.output_dir / 'out.png'}'"}]
    with pytest.raises(export_api.ExportError, match="your account \\(alice\\) can't write in") as e:
      run(dry_run=False)
    assert e.value.status == 403 and list(folder.iterdir()) == []
    # in a folder they can write in, only the files they can't read fail
    folder.chmod(0o777)
    check = run(dry_run=True)['copy_check']
    assert check['folder_error'] is None and len(check['unreadable']) == 1
  finally:
    shutil.rmtree(base)
