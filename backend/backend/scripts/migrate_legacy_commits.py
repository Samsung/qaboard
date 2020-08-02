import re
import datetime

import click
from click import secho
from sqlalchemy import func, and_, asc, or_

from backend.database import db_session, Session
from backend.models import Project, CiCommit, Batch, Output

# select
#   projects.id as project_id,
#   ci_commits.message, ci_commits.hexsha, ci_commits.project_id as ci_commits_project_id
# from ci_commits
# full outer join projects on ci_commits.project_id = projects.id
# where project_id is NULL;

# select
#   -- projects.id as project_id,
#   -- ci_commits.message, ci_commits.hexsha, ci_commits.project_id as ci_commits_project_id
#   DISTINCT ci_commits.project_id
# from ci_commits
# left join projects on ci_commits.project_id = projects.id
# where projects.id is NULL;

projects = [
    # "4ABReconst",
    # "ASPv2_GammaTest",
    # "ArielOForAlon",
    # "DVS/AF",
    # "DVS/AntiFlicker_Gen3",
    # "DVS/Depth",
    # "DVS/Framer",
    # "DVS_disparity",
    # "DespeckleConfigurations",
    # "DisparityChain",
    # "FastChecks/DVS_disparity",
    # "FastDepth",
    # "Inpaint",
    # "Kalman_filter",
    # "MotionDetection",
    # "PSP/WDR_DRC",
    # "PSPv21Huawei_HDRPSPv21_BW",
    # "Queue",
    # "SW_TNR",
    # "SebastienHandPoseDetectClean",
    # "TNR",
    "igorf/HW_ALG_poc3",
    "igorf/HW_ALG_poc3/CIS",
    "igorf/HW_ALG_poc3/CIS/tests/Amir/GW1_Amir",
    "igorf/HW_ALG_poc3/CIS/tests/playground/Amir/GW1_Amir",
    "igorf/HW_ALG_poc3/CIS/tests/products/2X5",
    "igorf/HW_ALG_poc3/CIS/tests/products/GW1",
    "igorf/HW_ALG_poc3/CIS/tests/products/HM1",
    "igorf/HW_ALG_poc3/KITT_ISP",
    "igorf/HW_ALG_poc3/KITT_ISP/tests/products/KITT_v1p0",
    "igorf/HW_ALG_poc3/PSP_2x",
    "igorf/HW_ALG_poc3/projects/CIS",
    "igorf/HW_ALG_poc3/projects/CIS/tests/products/2X5",
    "igorf/HW_ALG_poc3/scripts",

    "TNRtmp",
    "VINS/DataSet_02",
    "arthurf/cis",
    "arthurf/simulations/products/CIS",
    "chromatix_tail",
]
# projects = [
#     "CDE-Users/HW_ALG/FIMC_50/tests/products",
#     "CDE-Users/HW_ALG/FIMC_50",
#     "CDE-Users/HW_ALG/CIS/tests/scripts/NonaXTC",
#     "arthurf/simulations",
#     "CDE-Users/HW_ALG/KITT_ISP/tests/products/KITT_v2p1",
#     "CDE-Users/HW_ALG/ALG_GEN/tests/blocks/YRGB_COMBINE/workspace",
#     "CDE-Users/HW_ALG/CIS/tests/scripts/stitch_correction",
#     "CDE-Users/HW_ALG/CIS/tests2/tests/products",
#     "CIS_ISP_Algorithms/drc-autotune",
#     "CDE-Users/HW_ALG/ALG_GEN/tests/blocks/STREAM_PACKER/workspace",
#     "CDE-Users/HW_ALG/ALG_GEN/tests/blocks/format_adapter_16",
#     "CDE-Users/HW_ALG/ALG_GEN/tests/blocks/CBINNSTITCH/workspace",
#     "CDE-Users/HW_ALG/FIMC_50/tests/products/FIMC_v5p1",
# ]
for project_id in projects:
    project = Project.get_or_create(db_session, id=project_id)
    if not project.data:
        project.data = {} # "git": {}, "qatools_config": {}, "qatools_metrics": {}}
    db_session.add(project)
    db_session.commit()
exit(0)


# .order_by(CiCommit.authored_datetime.desc())
for c in db_session.query(CiCommit).all():
    if c.project is None:
        print(c.project_id, c.hexsha)
    # c.project_id = 'LSC/Calibration'
exit(0)



commits = (
    db_session.query(CiCommit)
    .filter(CiCommit.project_id == 'LSC\\Calibration')
)
print(commits.count())
# exit(0)
for c in commits.all():
    c.project_id = 'LSC/Calibration'
    db_session.add(c)
    db_session.commit()
exit(0)



# OLD PROJECTS
outputs = (
    db_session.query(Output)
    .filter(Output.platform == 'CDE')
)
for o in outputs.all():
    ci_commit = o.batch.ci_commit
    if ci_commit.project is None:
        ci_commit.project = Project.get_or_create(db_session, id=ci_commit.project_id)
        ci_commit.project.data = {"legacy": True, "git": {}, "qatools_config": {}, "qatools_metrics": {}}
        print(ci_commit)
        print(ci_commit.project)
        db_session.add(ci_commit)
        db_session.commit()
exit(0)
# print(outputs.count())
# output = outputs.first()
# print(output)
# print(output.batch)
# # print(output.batch.ci_commit)
# print(output.batch.ci_commit.project_id)
# # print(output.batch.ci_commit.project)
# exit(0)


# now = datetime.datetime.utcnow()
commits = (
    db_session.query(CiCommit)
    .filter(CiCommit.project_id != None)
    # .order_by(CiCommit.authored_datetime.desc())
)
print(commits.count())
exit(0)

for commit in commits.all():
  print(commit.hexsha)
  try:
    project_id, hexsha = commit.hexsha.split('/', maxsplit=1)
  except:
    pass
  if not hexsha:
    continue
  print(project_id, hexsha)
  project = Project.get_or_create(project_id)
  print(project)
  commit.project = project
  db_session.add(commit)
  db_session.commit()