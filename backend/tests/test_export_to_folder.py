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
