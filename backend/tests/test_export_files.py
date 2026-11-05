"""backend/api/export_files.py: the web app says how to name files, the server lists, names and links them"""
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
