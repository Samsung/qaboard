"""Where projects save their outputs and artifacts (Project.storage_roots)"""
from pathlib import Path


def test_projects_without_storage_settings_use_the_servers(app, capsys):
  from backend.config import default_outputs_root, default_artifacts_root
  from backend.models import Project
  from backend.models.Project import _storage_roots
  _storage_roots.cache_clear()
  roots = Project(id='group/no-storage', data={}).storage_roots()
  assert roots == {"outputs": default_outputs_root / 'group/no-storage', "artifacts": default_artifacts_root / 'group/no-storage', "subproject": Path()}
  # it used to print "argument of type 'NoneType' is not iterable"
  assert capsys.readouterr().out == ''


def test_projects_with_storage_settings(app):
  from backend.models import Project
  project = Project(id='group/with-storage', data={"qatools_config": {"storage": {"outputs": "/mnt/outputs", "artifacts": "/mnt/artifacts"}}})
  roots = project.storage_roots()
  assert roots["outputs"] == Path('/mnt/outputs/group/with-storage')
  assert roots["artifacts"] == Path('/mnt/artifacts/group/with-storage')
