"""backend/database.py's settings"""
import importlib.util
from pathlib import Path

import pytest


def load_database_module():
  path = Path(__file__).parent.parent / "backend" / "database.py"
  spec = importlib.util.spec_from_file_location("backend._database_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  module.engine.dispose()
  return module


@pytest.mark.parametrize("value, echo", [("", False), ("0", False), ("false", False), ("true", True), ("1", True)])
def test_db_echo(monkeypatch, value, echo):
  monkeypatch.setenv('QABOARD_DB_ECHO', value)
  assert load_database_module().engine.echo is echo
