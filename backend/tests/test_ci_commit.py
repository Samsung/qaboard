"""
Tests for backend/models/CiCommit.py: the commits created when clients (the CLI, scripts...) send results.
"""
import sys
import types
import datetime
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


HEXSHA = "0123456789abcdef0123456789abcdef01234567"
CONFIG = {"project": {"name": "group/project", "reference_branch": "master"}, "outputs": {"visualizations": []}}
NEW_CONFIG = {"project": {"name": "group/project", "reference_branch": "master"}, "outputs": {"visualizations": [{"path": "new.jpg"}]}}
AUTHORED = "2026-10-01T12:00:00+00:00"


@pytest.fixture
def ci_commit_model(monkeypatch):
  """Loads the real backend/models/CiCommit.py, with SQLAlchemy and the other models mocked"""
  # conftest.py replaces sqlalchemy with an empty module
  sa = sys.modules['sqlalchemy']
  for name in ('Column', 'Boolean', 'Integer', 'String', 'DateTime', 'JSON', 'ForeignKey', 'or_', 'UniqueConstraint', 'Index'):
    monkeypatch.setattr(sa, name, MagicMock(), raising=False)
  sa_orm = sys.modules['sqlalchemy.orm']
  monkeypatch.setattr(sa, 'orm', sa_orm, raising=False)
  for name in ('relationship', 'joinedload', 'selectinload'):
    monkeypatch.setattr(sa_orm, name, MagicMock(), raising=False)
  monkeypatch.setattr(sa_orm, 'reconstructor', lambda f: f, raising=False)
  postgresql = types.ModuleType('sqlalchemy.dialects.postgresql')
  postgresql.JSONB = MagicMock()
  monkeypatch.setitem(sys.modules, 'sqlalchemy.dialects', types.ModuleType('sqlalchemy.dialects'))
  monkeypatch.setitem(sys.modules, 'sqlalchemy.dialects.postgresql', postgresql)
  sa_exc = types.ModuleType('sqlalchemy.exc')
  sa_exc.IntegrityError = type('IntegrityError', (Exception,), {})
  monkeypatch.setitem(sys.modules, 'sqlalchemy.exc', sa_exc)

  models = sys.modules['backend.models']
  monkeypatch.setattr(models, 'Base', object, raising=False)
  monkeypatch.setattr(models, 'Project', MagicMock())
  monkeypatch.setattr(models, 'no_stats', {}, raising=False)

  path = Path(__file__).parent.parent / "backend" / "models" / "CiCommit.py"
  spec = importlib.util.spec_from_file_location("backend.models._ci_commit_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  # avatars are looked up on the git hosts
  monkeypatch.setattr(module, "committer_avatar_url", lambda name, git=None, project_url=None: "")
  return module


def make_project(data=None, repo=None):
  return SimpleNamespace(
    id="group/project",
    id_relative="",
    data=data if data is not None else {},
    # no git repository, unless the test says so
    repo=repo,
    storage_roots=lambda config: {"outputs": Path("/mnt/qaboard/outputs"), "artifacts": Path("/mnt/qaboard/artifacts"), "subproject": Path()},
  )


def get_or_create(ci_commit_model, project, data):
  """Creates a new commit for `project`"""
  sys.modules['backend.models'].Project.get_or_create.return_value = project
  session = MagicMock()
  session.query.return_value.filter.return_value.one.side_effect = ci_commit_model.NoResultFound
  return ci_commit_model.CiCommit.get_or_create(session=session, hexsha=HEXSHA, project_id=project.id, data=data)


def cli_data(**data):
  """What the CLI sends about a commit"""
  return {
    "commit_branch": "feature",
    "commit_parents": [],
    "commit_message": "Fix",
    "commit_committer_name": "arthurf",
    "commit_authored_datetime": AUTHORED,
    "project_root": "group/project",
    "qaboard_config": CONFIG,
    "qaboard_metrics": {"available_metrics": {}},
    **data,
  }


# ==========================================
# Project configuration
# ==========================================

def test_first_commit_initializes_project_config(ci_commit_model):
  project = make_project()
  get_or_create(ci_commit_model, project, cli_data(commit_branch="feature"))
  assert project.data["qatools_config"] == CONFIG
  assert project.data["qatools_metrics"] == {"available_metrics": {}}
  assert project.data["git"]["path_with_namespace"] == "group/project"


@pytest.mark.parametrize("branch, config, updated", [
  ("feature", NEW_CONFIG, False),
  ("master", NEW_CONFIG, True),
  # the reference branch is read from the new commit's configuration
  ("main", {**NEW_CONFIG, "project": {"name": "group/project", "reference_branch": "main"}}, True),
  ("master", {**NEW_CONFIG, "project": {"name": "group/project", "reference_branch": "main"}}, False),
])
def test_only_reference_branch_updates_project_config(ci_commit_model, branch, config, updated):
  project = make_project(data={"qatools_config": CONFIG, "qatools_metrics": {"old": True}})
  ci_commit = get_or_create(ci_commit_model, project, cli_data(commit_branch=branch, qaboard_config=config))
  assert project.data["qatools_config"] == (config if updated else CONFIG)
  assert project.data["qatools_metrics"] == ({"available_metrics": {}} if updated else {"old": True})
  # each commit always keeps its own configuration
  assert ci_commit.data["qatools_config"] == config


@pytest.mark.parametrize("stored, kept", [
  # e.g. the commit was opened in the web app before `qa` ran on it
  ({}, CONFIG),
  ({"qatools_config": NEW_CONFIG}, NEW_CONFIG),
])
def test_existing_commit_gets_its_config_once(ci_commit_model, stored, kept):
  existing = SimpleNamespace(hexsha=HEXSHA, data=dict(stored))
  session = MagicMock()
  session.query.return_value.filter.return_value.one.return_value = existing
  ci_commit = ci_commit_model.CiCommit.get_or_create(session=session, hexsha=HEXSHA, project_id="group/project", data=cli_data())
  assert ci_commit.data["qatools_config"] == kept


def test_config_without_project_section(ci_commit_model):
  project = make_project()
  data = cli_data(qaboard_config={"outputs": {}})
  del data["project_root"]
  get_or_create(ci_commit_model, project, data)
  assert project.data["qatools_config"] == {"outputs": {}}


def test_project_name_without_project_root(ci_commit_model):
  project = make_project()
  data = cli_data()
  del data["project_root"]
  get_or_create(ci_commit_model, project, data)
  assert project.data["git"]["path_with_namespace"] == "group/project"


# ==========================================
# Commit metadata, and commits without a branch
# ==========================================

def test_commit_metadata_from_client(ci_commit_model):
  ci_commit = get_or_create(ci_commit_model, make_project(), cli_data(commit_branch="feature", commit_parents=["abc"]))
  assert (ci_commit.branch, ci_commit.parents, ci_commit.message, ci_commit.committer_name, ci_commit.authored_datetime) == ("feature", ["abc"], "Fix", "arthurf", AUTHORED)


@pytest.mark.parametrize("data", [
  {"commit_authored_datetime": AUTHORED},
  {"commit_authored_datetime": AUTHORED, "commit_branch": None, "commit_message": None},
])
def test_commit_without_git_and_branch(ci_commit_model, data):
  # The project has no git repository: the client's data is enough
  ci_commit = get_or_create(ci_commit_model, make_project(), data)
  assert ci_commit.branch is None
  assert ci_commit.message == "<NA>"
  assert ci_commit.committer_name == "unknown"
  assert ci_commit.authored_datetime == AUTHORED


def test_commit_metadata_from_git(ci_commit_model, monkeypatch):
  authored = datetime.datetime(2026, 10, 1, tzinfo=datetime.timezone.utc)
  repo = MagicMock()
  repo.commit.return_value = SimpleNamespace(parents=[SimpleNamespace(hexsha="abc")], message="From git", committer=SimpleNamespace(name="git-user"), authored_datetime=authored)
  monkeypatch.setattr(ci_commit_model, "find_branch", lambda hexsha, repo: "origin/develop")
  ci_commit = get_or_create(ci_commit_model, make_project(repo=repo), {"project": "group/project"})
  repo.commit.assert_called_once_with(HEXSHA)
  assert (ci_commit.branch, ci_commit.parents, ci_commit.message, ci_commit.committer_name, ci_commit.authored_datetime) == ("origin/develop", ["abc"], "From git", "git-user", authored)


def test_commit_unknown_to_client_and_git(ci_commit_model):
  # e.g. a typo in the commit id, without a git repository
  with pytest.raises(Exception):
    get_or_create(ci_commit_model, make_project(), {"project": "group/project"})


@pytest.mark.parametrize("branch, expected", [
  ("feature", "feature"),
  ("origin/develop", "develop"),
  (None, ""),
])
def test_to_dict_branch(ci_commit_model, branch, expected):
  ci_commit = ci_commit_model.CiCommit(HEXSHA, project=make_project(), branch=branch, authored_datetime=datetime.datetime(2026, 10, 1))
  ci_commit.batches = []
  ci_commit.deleted = False
  ci_commit.commit_dir_override = None
  assert ci_commit.to_dict(MagicMock())["branch"] == expected


@pytest.fixture
def api(monkeypatch):
  """Loads the real backend/api/api.py"""
  for name in ('func', 'and_', 'asc', 'or_', 'text'):
    monkeypatch.setattr(sys.modules['sqlalchemy'], name, MagicMock(), raising=False)
  sa_sql = types.ModuleType('sqlalchemy.sql')
  sa_sql.label = MagicMock()
  monkeypatch.setitem(sys.modules, 'sqlalchemy.sql', sa_sql)
  path = Path(__file__).parent.parent / "backend" / "api" / "api.py"
  spec = importlib.util.spec_from_file_location("backend.api._api_branches_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  monkeypatch.setattr(module, "is_authorized_user", lambda user, project: True)
  monkeypatch.setattr(module, "db_session", MagicMock())
  return module


def test_branches_skip_commits_without_branch(api, dummy_app):
  query = api.db_session.query.return_value.filter.return_value.distinct.return_value.order_by.return_value
  query.yield_per.return_value = [("develop",), ("feature",), (None,)]
  with dummy_app.test_request_context("/api/v1/project/branches?project=group/project"):
    assert api.get_branches().get_json() == ["develop", "feature"]
