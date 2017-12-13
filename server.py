#!/usr/bin/env python3
"""
Web-app showing SLAM results in a digestible form.
"""
import json
import subprocess

from flask import Flask
from flask import request, render_template, redirect, send_from_directory, flash
app = Flask(__name__)
app.secret_key = 'A0Zr98j/3yX R~JHCXQ!fgdsrtgLWX/,?RT'

from git import Repo
from models import CiCommit, get_users_per_name
from git_utils import git_pull, list_commits
from config import *





## syncing with git ###########################################################

try:
  repo = Repo("psp_swip")
except:
  print("Error: First initialize with `git clone git@gitlab-srv:dvs/psp_swip.git`")

git_pull(repo)


@app.route('/gitlab_webhook', methods=['GET', 'POST'])
def gitlab_webhook():
  """Gitlab calls this endpoint every push. We use it to stay in sync."""
  print(json.loads(request.data))
  git_pull()
  return("{status:'OK'}")


## application ################################################################
@app.route('/s/<path:filename>')
def serve_static(filename):
  """Serve static files: images, csv files, videos..."""
  # we avoid a file download, it's better to display in the browser
  if filename.endswith('lsf.log'):
    return send_from_directory(str(ci_commits_directory), filename, mimetype="text/plain")
  return send_from_directory(str(ci_commits_directory), filename)



@app.route("/")
@app.route("/commits")
@app.route("/commits/")
@app.route("/branch/<path:branch>") # can contain slashes..!
@app.route("/branch/<path:branch>/")
def show_commits(branch=None, search=None):
  """ Renders an index page of the commits in the branch organized by date."""
  # this will only work nicely when displaying the commits in one branch...
  max_count = int(request.args.get('count', 20))
  page = int(request.args.get('page', 0))
  ci_commits = [CiCommit(c) for c in list_commits(branch, page, max_count)]

  # we filter those who did not even start CI performance tests...

  search = request.args.get('search', None)
  if search is not None:
    ci_commits = [c for c in ci_commits if search.lower() in c.gitcommit.message.lower()+c.gitcommit.author.name.lower()]

  return render_template('list.html',
              ci_commits=ci_commits,
              search=search,
              branch_label=branch if branch is not None else "All branches", branches=repo.refs,
              users=get_users_per_name(""), page=page, min_page=max(0,page-2), branch=branch)


def latest_successful_commit(branch='origin/develop'):
  latest_commits = repo.iter_commits(branch, max_count=10)
  latest_commit = CiCommit(next(latest_commits))
  print(latest_commit)
  while not latest_commit.outputs():
    latest_commit = CiCommit(next(latest_commits))
  if latest_commit.outputs():
    return latest_commit
  else:
    return None

@app.route("/commit/<hexsha>", methods=["GET", "DELETE"])
@app.route("/commit/<hexsha>/", methods=["GET", "DELETE"])
@app.route("/commit/<hexsha>/<filename_filter>")
def render_commit(hexsha, filename_filter=None):
  """ Renders a page showing the results with a given code commit. """
  try:
    ci_commit = CiCommit(repo.commit(hexsha))
    hexsha_ref = request.args.get('reference', None)
    ci_commit_ref = CiCommit(repo.commit(hexsha_ref)) if hexsha_ref else latest_successful_commit()
  except:
    return "Commit id not found", 404

  if request.method == 'GET':
    outputs = ci_commit.outputs()
    outputs_ref = ci_commit_ref.outputs() if ci_commit_ref else {}
    if (filename_filter):
      outputs = {k:v for k,v in outputs.items() if filename_filter in k}
      outputs_ref = {k:v for k,v in outputs_ref.items() if filename_filter in k}


    with batches_filepath.open() as f:
      batches = f.read()
    return render_template('results-single.html',
                           commit=ci_commit, commit_ref=ci_commit_ref,
                           outputs=outputs, outputs_ref=outputs_ref,
                           branch=ci_commit.branch(), batches=batches)
  # delete the outputs...
  if request.method == 'DELETE':
      ci_commit.delete()
      return "{message: 'OK'}"





batches_filepath = Path('data/extra-batches.yml').resolve()

@app.route("/batch/<hexsha>/", methods=['POST'])
def run_extra_batches(hexsha):
  commit = CiCommit(repo.commit(hexsha))
  batch = request.form.get('batch', None)
  batches = request.form.get('batches', None)
  overwrite = '--overwrite' if request.form.get('overwrite', 'off')=='on' else ''

  if batches:
    with batches_filepath.open('w') as f:
      f.write(batches)
      flash('Updated batches!')

  if batch:
    commit.update()
    cmd = ' '.join([
      f'ssh arthurf-vdi "cd {ci_directory}/branches/feature-ci-better-time-sync/psp_swip/swip_slam/UnitTests;',
      f'setenv SAMSUNG_CI_COMMIT_DIR \'{commit.commit_dir}\';',
      f'python tools/run.py batch --batchfile {str(batches_filepath)} --batch {batch} {overwrite}"'
    ])
    print(cmd)
    # it will only work with my /home/arthurf/.cshrc file
    # it sets ENV variables as needed....
    subprocess.run(cmd, shell=True,
                   encoding='utf-8',
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    flash(cmd)
    flash('Results should arrive soon....')
  return redirect('commit/'+hexsha)




# @app.route("/teamcity-ci/httpAuth/app/rest/builds/<branch>,#<sha>", methods=['GET','POST', 'PUT'])
# def build_info(branch, sha):
#   print(f"#{sha} from {branch}")
#   print(request.data)
#   print(request.form)
#   data = xmltodict.parse(request.data)['xml']
#   print(data)
#   return "OK"

# import xml.etree.ElementTree as ET

# @app.route("/viewLog.html")
# def build_page():
#   hexsha = request.args.get('buildId', None)
#   build_type = request.args.get('buildTypeId', None)
#   print(sha, build_type)
#   redirect('/commit/'+hexsha)

# @app.route("/teamcity-ci/httpAuth/app/rest/buildQueue", methods=['GET','POST', 'PUT'])
# def build_queue():
#   print(request.form)

#   print(request.data)
#   build = ET.fromstring(request.data)
#   branch_name = build.attrib['branchName']
#   print(branch_name)
#   return "{status: 'running'}"


#     // "failed", "canceled", "running", "pending", "success", "success_with_warnings", "skipped", "not_found"

# import requests
# project_id = 73 # or dvs%2Fpsp_swip

# @app.route("/test")
# def test():
#   hexsha = "7da445b9896425b5f3b16b5ab511396c10e40da6"
#   data = update_status(hexsha)
#   return str(data)

# def update_status(hexsha, state='success'):
#   headers = {'Private-Token': os.environ['GITLAB_ACCESS_TOKEN']}
#   gitlab_api = "http://gitlab-srv/api/v4"
#   target_url = 'http://gpu09-dt:5000/commit/{hexsha}'
#   r = requests.post(f'{gitlab_api}/projects/{project_id}/statuses/{hexsha}',
#     headers=headers,
#     params={'state':state, 'target_url': target_url}
#   )
#   return r.json()
