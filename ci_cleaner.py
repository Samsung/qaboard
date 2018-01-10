"""
Removes old commits from the CI database...
This saves a lot of disk space!
"""
import datetime
from pathlib import Path
import subprocess
import shutil
from git import Repo

from models import CiCommit
from config import *

repo = Repo(str(app_data_directory/'psp_swip'))



now = datetime.datetime.now().astimezone()
def is_old(commit):
    threshold = datetime.timedelta(days=7)
    return now - commit.authored_datetime > threshold

protected_refs = set(['origin/develop'])
protected_commits = set()
for ref in protected_refs:
  for c in repo.iter_commits(ref):
    protected_commits.add(c)

# for c in protected_commits:
#   print(f'{c.hexsha} on {c.authored_datetime} by {c.author.name}')
print(f'{len(protected_commits)} protected')


old_commits = set()
for ref in repo.refs:
  for c in repo.iter_commits(ref):
    if is_old(c) and c not in protected_commits:
        old_commits.add(c)
print(f'{len(old_commits)} to be deleted')

for c in old_commits:
    print(f'{c.hexsha} on {c.authored_datetime} by {c.author.name}')
    ci_commit = CiCommit(c)

    if ci_commit.commit_dir.exists():
      # outputs = ci_commit.commit_dir/'output'
      # logs = ci_commit.commit_dir/'lsf.log'
      # command = f'rm -rf {str(outputs)} {str(logs)}'
      command = f'rm -rf {str(ci_commit.commit_dir)}'
      print(command)
      subprocess.Popen([command], shell=True)
