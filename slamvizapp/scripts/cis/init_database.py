"""
Imports the CIS CI results.
"""
import datetime

from sqlalchemy.orm.exc import NoResultFound
from slamvizapp.database import Session

from .utils import parse_ci_dir, ci_dirs, parse_project_path
from slamvizapp.config import cis_ci_directory
from slamvizapp.models.LocalMocks import LocalGitCommit
from slamvizapp.models import CiCommit, Project


def init_cis_database(verbose):
  session = Session()

  n = 0
  for ci_dir_info in ci_dirs(cis_ci_directory, max_depth=3):
    project_path = ci_dir_info['path'].parent.relative_to(cis_ci_directory)
    author, project_id = parse_project_path(project_path)

    project = Project.get_or_create(session=session, id=project_id)

    # time_of_last_batch = 
    # print(ci_dir_info['path'])
    # print(f"{project} by {author}: {ci_dir_info['authored_datetime']:%D %H:%M} -- {ci_dir_info['version']}")

    try:
      ci_commit = (session
        .query(CiCommit)
        .filter_by(
          id=ci_dir_info['path'].name,
          project=project,
        )
        .one()
      )
    except NoResultFound:
      try:
        commit = LocalGitCommit(ci_dir_info['path'].name, ci_dir_info['version'], author, ci_dir_info['authored_datetime'])
        ci_commit = CiCommit(
          commit, project=project, branch=author, commit_type='local')
        ci_commit.time_of_last_batch = ci_dir_info['authored_datetime'].astimezone()
        ci_commit.ci_batch.created_date = ci_dir_info['authored_datetime'].astimezone()
        ci_commit.commit_dir_override = str(ci_dir_info['path'])

        print('[InitDatabase] new CIS commit')
        print(ci_commit)
      except ValueError:
        print(f"[InitDatabase] WARNING: could not create a commit for {project.id} {ci_dir_info['path'].name}.")
        continue
      if ci_commit is None: # something is wrong
        print('[InitDatabase] WARNING: ci_commit is None')
        continue

    print(ci_commit.time_of_last_batch.astimezone())

    ci_batch = ci_commit.ci_batch
    now = datetime.datetime.now().astimezone()
    could_be_pending_results = datetime.datetime.now().astimezone() - ci_commit.time_of_last_batch < datetime.timedelta(hours=3)
    has_pending = len([o for o in ci_batch.outputs if o.is_pending])
    has_failed = len([o for o in ci_batch.outputs if o.is_failed])
    if not ci_batch.outputs or could_be_pending_results:
      ci_batch.discover_outputs(session)
      # session.add(ci_batch)
      # session.commit()
    if verbose: print(ci_commit)

    # session.add(ci_commit)
    # session.commit()

    # repo???
    n += 1
    if n>1: break

  print(n)