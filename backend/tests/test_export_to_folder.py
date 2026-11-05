"""backend/api/export_to_folder.py: exports runs next to their reference's"""
import sys
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def export_api(monkeypatch):
  """Loads the real backend/api/export_to_folder.py"""
  monkeypatch.setattr(sys.modules['sqlalchemy.orm'], 'joinedload', MagicMock(), raising=False)
  monkeypatch.setattr(sys.modules['backend.models'], 'slugify_hash', MagicMock(), raising=False)
  path = Path(__file__).parent.parent / "backend" / "api" / "export_to_folder.py"
  spec = importlib.util.spec_from_file_location("backend.api._export_to_folder_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


def run(path, input_id=None, configurations=('base',), is_pending=False):
  test_input = SimpleNamespace(abs_path=Path('/db') / path, path=Path(path), data={"id": input_id} if input_id else {})
  return SimpleNamespace(test_input=test_input, configurations=list(configurations), extra_parameters={}, platform='linux', is_pending=is_pending)


def test_runs_on_the_same_input_match(export_api):
  new = run('a.jpg')
  assert export_api.compatible(new, run('a.jpg'))
  assert export_api.compatible(new, run('b.jpg')) is False
  # inputs that moved keep their id
  assert export_api.compatible(run('old/a.jpg', input_id='A'), run('new/a.jpg', input_id='A'))
  assert export_api.compatible(run('old/a.jpg', input_id='A'), run('new/b.jpg', input_id='B')) is False


def test_matching_output(export_api):
  reference = run('new/a.jpg', input_id='A', configurations=['base', 'tuned'])
  moved = run('old/a.jpg', input_id='A', configurations=['base', 'tuned'])
  other = run('old/b.jpg', input_id='B', configurations=['base', 'tuned'])
  assert export_api.matching_output(reference, [other, moved]) is moved
  # the same path first
  same_path = run('new/a.jpg', configurations=['other'])
  assert export_api.matching_output(reference, [moved, same_path]) is same_path
  assert export_api.matching_output(reference, [other, run('new/a.jpg', is_pending=True)]) is None


def test_matching_output_like_the_web_app(export_api):
  reference = run('a.jpg', configurations=['base', {'gain': 3}])
  closer, further = run('a.jpg', configurations=['base', {'gain': 4}]), run('a.jpg', configurations=['base', {'gain': 100}])
  assert export_api.matching_output(reference, [further, closer]) is closer
  # the same platform first
  same_platform, other_platform = run('a.jpg'), run('a.jpg')
  other_platform.platform = 'windows'
  assert export_api.matching_output(run('a.jpg'), [other_platform, same_platform]) is same_platform


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


def test_older_api_names(export_api, tmp_path):
  """Scripts' exports: "new" and "reference", and a short id of the settings when runs share an input"""
  new = [stored_run(tmp_path, 1, 'a.raw', extra_parameters={'gain': 1}), stored_run(tmp_path, 2, 'a.raw', extra_parameters={'gain': 2})]
  ref = [stored_run(tmp_path, 3, 'a.raw', hexsha='b' * 40)]
  items = export_api.legacy_items(new, ref)
  assert [(i.output.id, i.side, i.fields['side']) for i in items] == [(1, 'new', 'new'), (3, 'reference', 'reference'), (2, 'new', 'new'), (3, 'reference', 'reference')]
  assert items[0].fields['settings'] and items[0].fields['settings'] != items[2].fields['settings']
  # reference files are named like the new run they're compared to
  assert items[1].fields['settings'] == items[0].fields['settings']
  plan = export_api.make_plan(items, '*.png', export_api.DEFAULT_TEMPLATE, '_')
  assert plan['collisions'] == [] and len(plan['files']) == 4
  # one run per input, no reference: plain names
  items = export_api.legacy_items(new[:1], [])
  assert export_api.make_plan(items, '*.png', export_api.DEFAULT_TEMPLATE, '_')['files'][0]['to'] == 'a__out.png'
