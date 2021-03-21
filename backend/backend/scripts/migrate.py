#!/usr/bin/env python
"""
Migrates a projects' outputs to their default location.

Usage:
0. Clean old results..
   ssh qa
   docker-compose -f docker-compose.yml -f development.yml -f sirc.yml exec -T  backend qaboard_clean --project 'CDE-Users/HW_ALG/CIS$' --before 3months --can-delete-reference-branch # --can-delete-artifacts
1. Save the remote user list
    $ getent --service=sss passwd >> ./services/backend/passwd
   Manually remove those entries and redo if needed...
2. Needs a server to sync user quotas..
    $ python backend/backend/scripts/user_storage_server.py
    # update the server location in migrate.py with QUOTA_SERVER
3. You'll run the gen_parallel_migration.py in the end...

-- how much left to migrate?
SQL STORAGE
select
    projects.id,
	to_char(sum((outputs.data->>'storage')::text::numeric/1000000000), '9999999999999.99') as storage_GB,
	count(*) as nb
from outputs
  left join batches    on batches.id=outputs.batch_id
  left join ci_commits on ci_commits.id=batches.ci_commit_id
  left join projects   on projects.id=ci_commits.project_id
where
 -- outputs.data->'migrated' is null
 "output_dir_override" is not null
 -- and outputs.created_date < now() - '14 days'::interval
 -- and outputs.deleted=false
 and ("output_dir_override" not like '/algo%')
 -- and ("output_dir_override" like '/stage/algo_data/ci/CDE-Users/HW_ALG/%/KITT_ISP/output%')
 -- and ("output_dir_override" like '/stage/algo_data/ci/CDE-Users/HW_ALG/%/KITT_ISP/output%' or "output_dir_override" like '/algo/KITT_ISP%')
 -- and projects.data->>'legacy' is null
 and (projects.id like '%HW%' or projects.id like '%dvs%' or projects.id like '%tof%')
group by projects.id;
--limit 10;


-- 2 264 674  at 23:30
-- 2 050 619  at 09:08






select to_char(sum((data->>'storage')::text::numeric/1000000000), '9.9') as storage from outputs where ("output_dir_override" like '/stage/algo_data/ci/CDE-Users/HW_ALG/%/CIS/output%') limit 10;

-- wtf...
select count(*) from outputs where "output_dir_override" is NULL limit 10;
select * from outputs where "output_dir_override" is NULL and deleted=false order by created_date desc limit 100;


Usage:
  migrate.py PROJECT [--dry-run]
  e.g.
  migrate.py CDE-Users/HW_ALG/CIS --dry-run


Note:
- Best not run this on the production server, just in case
"""
import os
import re
import sys
import time
import random
import shutil
import traceback
from pathlib import Path
from add_output_data_storage import get_storage

import click
import requests
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import text

from backend.models import Project, CiCommit, Batch, Output
from backend.database import db_session, Session
from backend.fs_utils import as_user, rm_empty_parents

from migration_utils import get_username
from migration_utils import rm_files_not_listed_in_manifests

# TODO
# - [TODO CHECK tmux alginfra1] remove old deleted stuff with delete_remaining_data_from_deleted_runs.py
# - [TODO] ./backend/backend/scripts/gen_parallel_migration.py --all 15
# - [TODO] rg Missing migration
# - [TODO] add missing users in migration_utils.py
# - [TODO] ./backend/backend/scripts/gen_parallel_migration.py --all 15
# - [TODO] add missing users in migration_utils.py
# - [TODO] check in SQL all is done!
# - remove deleted=False filter in the delete, check if there is data, if yes remove completely the folder and parents...
#   /algo/CIS/outputs/nimrodn/CDE-Users/HW_ALG/ed/1f2abce82c7bb2/CIS/output/linux/RV1/tv/tv_RV1_512x256_REMOSAIC_FULL_V1


# Some output directories depend on the current user.
# We'll switch user a lot, so we don't want to cache the current user.
os.environ['QABOARD_NO_CACHE_USER'] = "YES"

# At SIRC we cannot be root on the shared storage, so
# we need to su the proper users in order to migrate their runs.
# This flag controls the extra work to get it right
# at_sirc = False
at_sirc = True


project = os.environ["MIGRATION_PROJECT"] if "MIGRATION_PROJECT" in os.environ else sys.argv[1]
project_name = project.split('/')[-1]
if "ALG_GEN" in project:
  project_name = "CIS"
dryrun = '--dry-run' in sys.argv

# Progress will be printed every batch/100
batch_size = 10_000
start = time.time()

# We parallelize the migration, each worker handles a given idx modulo parts_nbr
parts_nbr = int(os.environ.get('MIGRATION_JOBS', 0))
parts_idx = int(os.environ.get('MIGRATION_INDEX', 0))
if parts_nbr:
  click.secho(f"[Migration Job {parts_idx+1}/{parts_nbr}]", bold=True)

# Everything is simpler if all folders/files are writable by everyone
# We don't have any trust issue, and everything is backed-up, so no need to bother
# Otherwise down the line it's yet more trouble
os.umask(0)


quota_server = os.environ.get('QUOTA_SERVER', "http://qa:3001")
def fetch_quota(user, project):
  r = requests.get(f"{quota_server}/user/{user}/storage/project/{project_name}?proxies=cache-buster")
  try:
    return r.json()
  except Exception as e:
    print(r.text)
    raise e

def add_storage(user, project, storage):
  return requests.get(f"{quota_server}/user/{user}/storage/project/{project_name}/add?usage={storage}").json()


def move_files(before_dir: Path, after_dir: Path, output: Output):
  # print(before_dir, after_dir)
  if before_dir.exists(): # needs_migration
    try:
      # /before/path/a
      # /after/path/b
      after_dir.parent.mkdir(parents=True, exist_ok=True) # /after/path
      if before_dir.name != after_dir.name:
        after_dir = after_dir.parent / before_dir.name
      if not after_dir.exists():
        shutil.move(str(before_dir), str(after_dir.parent))
      else:
        for path in before_dir.iterdir():
          if not (after_dir / path.relative_to(before_dir) ).exists():
            shutil.move(str(path), str(after_dir))
      rm_empty_parents(before_dir)
      # # TODO: we should delete the dirs for very old outputs...
      # if output.deleted:
      #   rm_files_not_listed_in_manifests(after_dir)
    except Exception as e:
      click.secho(f"  ERROR: {e}", bold=True, fg='red')
      traceback.print_exc(file=sys.stdout)
      exit(1)



users_with_max_quota = set()

def migrate_output(output):
  if not output.output_dir_override: 
    print("MISSING output.output_dir_override")
    print("- output.id", output.id)
    print("- output.batch", output.batch)
    print("- output.ci_commit", output.batch.ci_commit)
    print("- output.project", output.batch.ci_commit.project)
    # for those... just delete we alreadt cannot reach them
    return

  before_dir = output.output_dir
  # we unset those to make sure we get the default value 
  output.output_dir_override = None
  output.batch.batch_dir_override = None
  output.batch.ci_commit.commit_dir_override = None
  # get the committer name -> login (here we wish we had saved the email too...)
  if at_sirc:
    username = get_username(output.batch.ci_commit)
    if not username:
      return
  os.environ['LOGNAME'] = username
  after_dir = output.output_dir

  if 'products/HM2P/output/' in str(after_dir):
    after_dir = Path(str(after_dir).replace('/stage/algo_data/ci/CDE-Users/HW_ALG', '/algo/HM2P'))
  if '/HEX/' in str(after_dir):
    after_dir = Path(str(after_dir).replace('/HEX/', '/HP2/'))
  match = re.search("PSP_2x/tests/products/([0-9A-Za-z]+)/output", str(after_dir))
  if match:
    product = match.groups(0)[0]
    if product == 'ASP51':
      product = "ASPv5"
    after_dir = Path(str(after_dir).replace('/stage/algo_data/ci/CDE-Users/HW_ALG', f'/algo/{product}'))
  if '/DVS/tests/products/' in str(after_dir):
    after_dir = Path(str(after_dir).replace('/stage/algo_data/ci/CDE-Users/HW_ALG', '/algo/DVS'))
  if '/tests/common/scripts/SCD/output':
    after_dir = Path(str(after_dir).replace('/stage/algo_data/ci/CDE-Users/HW_ALG', '/algo/CIS'))
  if '/tests/blocks/AAG/output' in str(after_dir) or '/tests/blocks/GBPC/workspace/output' in str(after_dir) or '/tests/blocks/VISION_SCD/output' in str(after_dir):
    after_dir = Path(str(after_dir).replace('/stage/algo_data/ci/CDE-Users/HW_ALG', '/algo/CIS'))
  if '/mnt/qaboard/igorf' in str(after_dir):
    after_dir = Path(str(after_dir).replace('/mnt/qaboard/igorf', '/algo/CIS/outputs/igorf/CDE-Users/HW_ALG'))
    username = 'igorf'
  if '/home/arthurf/ci' in str(after_dir):
    after_dir = Path(str(after_dir).replace('/home/arthurf/ci', '/algo/DVS'))
  if '/home/yotama/ci' in str(after_dir):
    after_dir = Path(str(after_dir).replace('/home/yotama/ci', '/algo/DVS'))
  if '/stage/algo_data/ci/dvs' in str(after_dir):
    after_dir = Path(str(after_dir).replace('/stage/algo_data/ci', '/algo/DVS'))

  # click.secho(str(output))
  click.secho(f"{output.id} {'[deleted]' if output.deleted else ''}")
  click.secho(f"  ♻ {before_dir}", dim=True)
  if '/algo' not in str(after_dir):
    print(after_dir)
    exit(0)

  needs_migration = str(before_dir) != str(after_dir)
  if not needs_migration:
    click.secho(f"  Looks OK!", dim=True)

  if 'storage' not in output.data:
    print("missing storage...")
    try:
      exists = as_user("sircdevops", lambda: output.output_dir.exists())
      if not exists:
        storage = 0
      else:
        owner = as_user("sircdevops", lambda: output.output_dir.owner())
        # print(f"> {owner}")
        # owner = output.output_dir.owner()
        # print("output_dir owner:", owner)
        storage = as_user(owner, get_storage, output)
    except Exception as e:
      print(e)
      exit(0)
      try:
        storage = as_user('sircdevops', get_storage, output)
      except:
        click.secho(f"  .. ERROR permission issue...", dim=True)
        return
    print(storage)
    output.data['storage'] = storage

  storage = float(output.data['storage']) / 1024
  # print(quota, storage)

  click.secho(f"  ✔ {after_dir}")
  if dryrun:
    return

  if not needs_migration:
    return

  # ldapsearch -t -L -H ldap://dc04.transchip.com -b 'dc=transchip,dc=com' -D "cn=Ldap Query,ou=IT,ou=SIRC Users,dc=transchip,dc=com" -x -w LQstc009 -s sub "(memberOf=CN=Sensor_Algorithms,OU=Groups,OU=SIRC Users,DC=transchip,DC=com)" | grep 'sAMAccountName:'
  fillers = ["dima","oded","guy","itail","arielo","haim","igal","galb","yahavs","erand","arthurf","royy","shahafd","rivkae","amichaya","shais","taeerw","royp","matand","davidn","nimrodn","eitanl","matanh","mandyr","talb","eliavm","noar","barakd","itamarp","yoavpi","shaharj","talf","elady","dannyz","yardenr","mayav","bena","eilamg","nitsanr","ronenk","org","adirm","yoramf","ilyar","naomis","ronyg","assafb","alon","adamo","rafir","vladimird","buzzm","noal","lenag","chenr","nadavo","amitkad","orens","omera","sivanm","liranh","raziela"]
  def new_owner_info():
    random.shuffle(fillers)
    for user in [username, *fillers]:
      if user in users_with_max_quota:
        continue
      quota = fetch_quota(user, project_name)
      print(user, "?", quota['used']/1024/1024)
      if quota['used'] > quota['limit'] * 0.79:
        click.secho(f"  😭 {user} full quota", dim=True)
        users_with_max_quota.add(user)
        continue
      if storage and quota['used'] + storage > quota['limit'] * 0.8:
        click.secho(f"  😭 {user} not enough quota: {storage/1024} on {quota['used']/1024/1024}/{quota['limit']/1024/1024}", dim=True)
        continue
      return user, quota

  try:
    print(f"  . Belongs to {username}")
    username, quota = new_owner_info()
    print(f"  . Using {username}")
    # exit(0)
  except Exception as e:
    click.secho(f"  😭😭😭😭 [{e}] skipping, no one has enough quota... ", dim=True)
    exit(0)
  db_session.refresh(output.batch.ci_commit)
  db_session.refresh(output.batch)
  try:
    as_user(username, move_files, before_dir, after_dir, output)
  except Exception as e:
    try: # TODO: try to find as which user to retry...
      as_user('sircdevops', move_files, before_dir, after_dir, output)
    except Exception as e:
      print(f"  ERROR: {e}")
      traceback.print_exc(file=sys.stdout)
      exit(1)
  if not output.deleted:
    add_storage(username, project, storage)


  output.output_dir_override = str(after_dir)
  output.data['migrated'] = True
  flag_modified(output, "data")
  db_session.add(output)
  db_session.commit()
  click.secho("  🆗", fg='green')
  # exit(0)


def migrate(min_id):
  # it's an aweful join...
  all_outputs = (db_session
    .query(Output, Batch, CiCommit)
    .join(Batch.outputs)#, isouter=True)
    .join(CiCommit)#, isouter=True)
    .filter(CiCommit.project_id==project)
  )
  if min_id:
    all_outputs = all_outputs.filter(Output.id >= min_id)
  if parts_nbr:
    all_outputs = all_outputs.filter(Output.id % parts_nbr == parts_idx)
  # ("output_dir_override" like '/stage/algo_data/ci/CDE-Users/HW_ALG%')
  outputs = (all_outputs
    # .filter(text("(outputs.data->'migrated') is null"))
    .filter(text("outputs.output_dir_override is not null"))
    .filter(text("outputs.output_dir_override not like '/algo%'"))
    # .filter(text("outputs.created_date < now() - '15 days'::interval"))
    # .filter(text("output_dir_override like '/stage/algo_data/ci/CDE-Users/HW_ALG/%/CIS/output%'"))
    # .filter(Output.is_pending==False)
    # .order_by(Output.created_date.asc())
    .enable_eagerloads(False)
  )
  # click.secho(f'- outputs total: {all_outputs.count()}', bold=True, fg='blue')
  output_total = outputs.count()
  click.secho(f'- outputs to migrate: {output_total}', bold=True, fg='blue')
  should_continue = output_total > batch_size
  start_batch  = time.time()
  updated = 0
  now = time.time()

  if not output_total:
    for result in all_outputs.limit(1):
      o, batch, commit = result
      print(o)
      print(o.output_dir)
    return updated, None, should_continue

  for idx, result in enumerate(outputs.limit(batch_size)):
      o, batch, commit = result
      # print(o, batch, commit)
      if o.data is None:
        o.data = {}
      ## legacy outputs from the previous CI
      # if '/' in o.batch.ci_commit.hexsha:
      #   continue

      migrate_output(o)
      if idx and idx % batch_size/100 == 0:
          print(o)
          print(o.batch.ci_commit)
          now = time.time()
          print(f"{idx/output_total:.1%} [{batch_size/(now - start_batch):.1f}/s] [est. total left {(now - start_batch) * ((output_total-idx)/batch_size) / 3600:.2f}h] [elapsed time: {now - start:.1f}s]")
          start_batch = now
  return updated, o.id, should_continue


def main():
  # Optionnally, you can give an id to start from...
  # it helps if there are many non-migrated runs that fail because of whatever and
  # you don't want to wait until the migration fails to migrate them again!
  last_id = None #1245250 # None

  should_continue = True
  while should_continue:
    click.secho('Migrating...', bold=True, fg='blue')
    nb_updated, last_id, should_continue = migrate(last_id)
    click.secho(f"nb_updated={nb_updated}, last_id={last_id}, should_continue={should_continue}", fg='blue')
  click.secho('DONE', fg='green')

main()
