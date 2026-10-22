"""
Tests for backend/storage_usage.py that need no database: finding where folders split, to skip chains of folders
that only lead to one subfolder in Storage usage > Folders.
"""
import sys
import types
from unittest.mock import MagicMock

# conftest.py replaces sqlalchemy with an empty module: the real backend.database can't be imported
if 'backend.database' not in sys.modules:
  sys.modules['backend.database'] = types.ModuleType('backend.database')
  sys.modules['backend.database'].db_session = MagicMock()
sys.modules['sqlalchemy'].text = getattr(sys.modules['sqlalchemy'], 'text', lambda sql: sql)

from backend.storage_usage import deepest_folder  # noqa: E402


def folders(*paths):
  """What the SQL gives: the first and last "<folder>/" in alphabetical order"""
  ends = sorted(f"{p}/" for p in paths)
  return ends[0], ends[-1]


def test_one_folder_is_its_own_deepest():
  assert deepest_folder(*folders('/algo/proj/outputs/alice/batch')) == '/algo/proj/outputs/alice/batch'


def test_chains_lead_to_where_folders_split():
  assert deepest_folder(*folders('/a/b/c/d1', '/a/b/c/d2/e')) == '/a/b/c'
  assert deepest_folder(*folders('/a/b/c', '/a/b/c/d')) == '/a/b/c'


def test_names_that_share_a_prefix_are_different_folders():
  # "b-c" sorts between "b" and "b/e": without the trailing "/", "/a/b" would look like the common folder
  assert deepest_folder(*folders('/a/b', '/a/b-c/d', '/a/b/e')) == '/a'
  assert deepest_folder(*folders('/a/b1', '/a/b2')) == '/a'


def test_the_root():
  assert deepest_folder(*folders('/a/b', '/c/d')) == '/'
  assert deepest_folder(None, None) is None
