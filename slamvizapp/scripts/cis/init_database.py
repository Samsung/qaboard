"""
Imports the CIS CI results.
"""
import datetime
import json
from pathlib import Path

from sqlalchemy.orm.exc import NoResultFound
from slamvizapp.database import Session

from .utils import parse_ci_dir, ci_dirs, parse_project_path, parse_cis_input_path
from slamvizapp.config import cis_ci_directory
from slamvizapp.models.LocalMocks import LocalGitCommit
from slamvizapp.models import CiCommit, Project, TestInput, Output
from slamvizapp.models import Batch


def init_cis_database(verbose):
  session = Session()

  n = 0
  for ci_dir_info in ci_dirs(cis_ci_directory, max_depth=3):
    project_path = ci_dir_info['path'].parent.relative_to(cis_ci_directory)
    author, project_id = parse_project_path(project_path)
    project = Project.get_or_create(session=session, id=project_id)
    commit_id = f"{project.id}/{ci_dir_info['path'].name}"

    # https://bitbucket.org/zzzeek/alembic/issues/405/altering-columns-to-add-on-delete-cascade
    # cis_outputs = (session
    #   .query(Output)
    #   .filter_by(platform='CDE')
    #   .delete()
    # )
    # cis_commits = (session
    #   .query(CiCommit)
    #   .filter(CiCommit.project_id != 'dvs/psp_swip')
    # )
    # for cis_commit in cis_commits:
    #   q = session.query(Batch).filter(Batch.ci_commit_id == cis_commit.id).delete()
    # session.commit()
    # cis_commits = (session
    #   .query(CiCommit)
    #   .filter(CiCommit.project_id != 'dvs/psp_swip')
    #   .delete()
    # )
    # session.commit()
    # return

    try:
      ci_commit = (session
        .query(CiCommit)
        .filter_by(
          id=commit_id,
          project=project,
        )
        .one()
      )
    except NoResultFound:
      try:
        message = ci_dir_info['version'].replace('_', ' ')
        commit = LocalGitCommit(commit_id, message, author, ci_dir_info['authored_datetime'])
        ci_commit = CiCommit(commit, project=project, branch=author, commit_type='local')

        ci_commit.time_of_last_batch = ci_dir_info['authored_datetime'].astimezone()
        ci_commit.ci_batch.created_date = ci_dir_info['authored_datetime'].astimezone()
        ci_commit.commit_dir_override = str(ci_dir_info['path'])

        print('[InitDatabase] new CIS commit')
      except ValueError:
        print(f"[InitDatabase] WARNING: could not create a commit for {project.id} {ci_dir_info['path'].name}.")
        continue
      if ci_commit is None: # something is wrong
        print('[InitDatabase] WARNING: ci_commit is None')
        continue


    ci_batch = ci_commit.ci_batch
    now = datetime.datetime.now().astimezone()
    could_be_pending_results = datetime.datetime.now().astimezone() - ci_commit.time_of_last_batch < datetime.timedelta(hours=3)
    has_pending = len([o for o in ci_batch.outputs if o.is_pending])
    has_failed = len([o for o in ci_batch.outputs if o.is_failed])
    # if not ci_batch.outputs or could_be_pending_results:
    # if not ci_batch.outputs:
    if True:
      try:
        discover_outputs(ci_batch, session)
        if verbose: print(ci_commit)
      except Exception as e:
        print(e)
        continue
      session.add(ci_batch)
      session.commit()

    session.add(ci_commit)
    session.commit()

    # repo???
    n += 1
    # if n>1: break

  print(n)


def discover_outputs(batch, session):
  """Find outputs saved on the disk to initialize the database"""
  # TODO: get workspace, get conf.json in ci_commmit and return details in the API call
  # maybe use it to compute metrics...

  # make sure we get the milstones, and reference...
  # http://dvs:5000/s/algo_data/igal/GM3ContinuousIntegration/NRv4/
  outputs_dir = Path(batch.ci_commit.commit_dir_override)
  for output_description in outputs_dir.glob('*_job_description.json'):
    with output_description.open('r') as f:
      data = json.load(f)
      # print(data)
      # {'status': 'running',
      # 'username': 'roee',
      # 'started_at': '2017/07/17_15:31:32',
      # 'submission_time': '2017/07/17_15:30:24'
      # 'out_regs_file': 'frame_9962_out_regs.txt'
      # 'first_frame': 0,
      # 'output_folder_path': '\\\\netapp2\\algo_data\\Roee\\RCCC\\170717_automotive_rccc_CI\\2017_07_17_constant_drc_gain',
      # 'output_picture_format': 'frame_9962.bmp',
      # 'save_config_folder_name': 'frame_9962',
      # 'linux_executable': 'CDELinuxSim_144178.exe',
      # 'configuration': '2017_07_17_constant_drc_gain_frame_9962'}
      database, path = parse_cis_input_path(data['input_picture_path_format'])
      # print(database, path)
      test_input = TestInput.get_or_create(session, database=database, path=path)
      output = Output.get_or_create(session,
                                           batch=batch,
                                           test_input=test_input,
                                           output_type='cis/image',
                                           platform='CDE',
                                           configuration=data['configuration'],
                                           extra_parameters={},
                                          )
      output.output_dir_override = str(outputs_dir)
      output.output_type = 'cis/image'
      output.data = {
        'output_picture_format': data['output_picture_format'],
        'out_regs_file': data['out_regs_file'],
        'config_folder': data['save_config_folder_name'],
        'first_frame': data['first_frame'],
      }
      # print(output)
      session.add(output)
      session.commit()




