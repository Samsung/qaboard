"""
Imports the CIS CI results.
"""
from .utils import *
from slamvizapp.config import cis_ci_directory
from slamvizapp.models.LocalMocks import LocalGitCommit
from slamvizapp.models import CiCommit


def init_cis_database(verbose):
  n = 0
  for ci_dir_info in ci_dirs(cis_ci_directory, max_depth=3):
    project_path = ci_dir_info['path'].parent.relative_to(cis_ci_directory)
    author, project = parse_project_path(project_path)
    # time_of_last_batch = 
    # print(ci_dir_info['path'])
    print(f"{project} by {author}: {ci_dir_info['authored_datetime']:%D %H:%M} -- {ci_dir_info['version']}")
    commit = LocalGitCommit(ci_dir_info['path'].name, ci_dir_info['version'], author, ci_dir_info['authored_datetime'])
    ci_commit = CiCommit(commit, project=project, branch='<NA>', commit_type='<NA>')
    print(ci_commit)
    # repo???
    n += 1
    if n>10: break

  print(n)