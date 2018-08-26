"""
Legacy
"""
import re
import datetime
from pathlib import Path

from git.exc import BadName
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import repos
from slamvizapp.database import Session
from slamvizapp.models import Base, Project, CiCommit, TestInput, Batch, Output
from slamvizapp.config import ci_directory

import slamvizapp
from slamvizapp.scripts.slam.init_database import discover_outputs

root = Path('/net/f2/algo_archive/PTAM_Results/')
# manual_runs = [
#   ('2018-03-04_13-40-55__local__avis__W9_Android_RT', 'feb2963'),
#   ('2018-03-04_13-40-55__local__avis__W9_Android_RT', 'feb296353ddab8067c9b62a82c00c75299a6d173'),
#   ('2018-03-15_17-23-43__local__avis__6a37ae63_Android_RT', '6a37ae63344ec481e349ef49e15ac483a4363711'),
#   ('2018-04-08_10-26-08__local__irobot__8c049f68_DEMO_Android_RT', '8c049f684411c1f81d23aa8ee7730ed1e3464632'),
#   ('2018-05-14_17-36-57__local__avis__19dade3c_Android_RT', '19dade3c6c367d7f8cb31db216654b443f5fe03e'),
#   ('2018-01-10_10-55-36__local__avis_41e75c0f_Android_RT', '41e75c0f0c2e4d930e75c64cdcc69c45dca6d569'),
#   ('2018-05-28_12-30-16__local__avis__DEMO_Android_RT', '1359ec9f3eea20dfa8bbd0943116c8d0aa03d4ba'),
#   ('2018-05-28_18-47-34__local__avis__DEMO_Android_RT', 'f4d3f4af7f5e0e261cf0676fb48ab149d7e63d71'),
#   ('2018-05-30_09-30-29__local__avis__DEMO_Android_RT', 'db834edb4a9892e659d127402c899c0f3c398f19'),
#   ('2018-06-04_09-35-19__local__avis__DEMO_Android_RT', '9b5eff2de07d211506d0952258f05fb1f79622ff'),
# ]
# def init_slam_manual_runs(verbose=False):
#   for folder, commit_short_id in manual_runs:
#     if verbose: print(f'importing {commit_short_id} in {folder}')
#     import_slam_manual_run(folder, commit_short_id)


# init_slam_manual_runs(verbose=True)
