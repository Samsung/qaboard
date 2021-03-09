import os
import pwd
import shutil
import pickle
from pathlib import Path

import requests
import click






def rm_files_not_listed_in_manifests(deleted_output_dir: Path):
  """Deletes files from output directories that are not listed in output-manifest files."""
  for path in deleted_output_dir.iterdir():
    if path.name in ('log.txt', 'manifest.inputs.json', 'manifest.outputs.json'):
      continue
    if path.is_file():
      path.unlink()
    else:
      shutil.rmtree(path)




def valid(username):
  return Path(f"/home/{username}").exists()


# Some emails from git cannot be mapped to user names
# You can add more to the list...b
usernames = {
  "chenrimoch@samsung.com": "chenr",
  "royyam@samsung.com": "royy",
  "j.y.shin@samsung.com": "sircdevops",
  "heyabcd.yang@samsung.com": "sircdevops",
  "heyabcd.yang@samsungds.net": "sircdevops",
  "omeralon@gmail.com": "alon",
  "avi.zanko@samsung.com": "aviza",
  "yotamater@mail.tau.ac.il": "yotama",
  "yotamater@mail.tau.ac.il": "yotama",
  "$amsonite3": "ayalg",
  "$amsonite2": "ayalg",
  "ayal.green#samsung.com": "ayalg",
  "=": "ayalg",
}

def get_username(ci_commit):
  try:
    committer_email = ci_commit.project.repo.commit(ci_commit.hexsha).committer.email
  except Exception as e:
    click.secho(str(e), fg='red')
    try:
      owner = ci_commit.artifacts_dir.owner()
    except:
      owner = "sircdevops"
    print(f"??? {owner}")
    # return None if owner in ['sircdevops', 'ispq'] else owner
    return owner
  if committer_email in usernames:
    return usernames[committer_email]

  try:
    username, _ = committer_email.split('@')
  except:
    raise ValueError((committer_email, ci_commit.project.repo.commit(ci_commit.hexsha).committer))
  if not valid(username):
    r = requests.post("http://itweb/tel/mail2user.php", {"mail": committer_email})
    username_from_it = r.text.strip()
    if username_from_it:
      username = username_from_it
    else:
      try: # try the default user naming convention at SIRC
        first, second = username.split('.')
        username = f"{first}{second[0]}"
      except:
        pass
      if not valid(username):
        click.secho(f"Missing username for {committer_email}", fg='red')
        return None
    click.secho(f"❓ {ci_commit.committer_name} -> {committer_email} -> {username}", fg='yellow')
    usernames[committer_email] = username
    return username
  else:
    return username