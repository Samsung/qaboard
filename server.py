#!/usr/bin/env python3
"""
Flask web-app showing SLAM results in a digestible form.
"""
import json
import subprocess

from flask import Flask
from flask import request, render_template, send_from_directory
from flask import redirect, flash
app = Flask(__name__)
# needed to use flask sessions and eg display flash messages after redirects
app.secret_key = 'A0Zr98j/3yX R~JHCXQ!fgdsrtgLWX/,?RT'

from models import CiCommit, latest_successful_commit, parent_successful_commit
from git_utils import repo, git_pull, list_commits
from utils import get_users_per_name
from config import *


# users can request to run on new recordings - we keep the list of available batches
batches_filepath = Path('data/extra-batches.yml').resolve()


# we fetch the latest commits at startup
git_pull()

@app.route('/gitlab_webhook', methods=['GET', 'POST'])
def gitlab_webhook():
  """Gitlab calls this endpoint every push, it garantees we stay synced."""
  # in the future we may want to remember the commit-branch/tag association
  # json.loads(request.data)
  git_pull()
  return "{status:'OK'}"


@app.route('/s/<path:filename>')
def serve_static(filename):
  """Serve static files: images, csv files, videos..."""
  # without changing the MIME, logs are downloaded and not displayed in the browser
  # note: if we serve static assets with a reverse proxy (eg nginx) we also have to set this
  options = {mimetype: "text/plain"} if filename.endswith('lsf.log') else {}
  return send_from_directory(str(ci_commits_directory), filename, **options)


@app.route("/")
@app.route("/commits")
@app.route("/commits/")
@app.route("/branch/<path:branch>")  # Branch names can contain slashes..
@app.route("/branch/<path:branch>/") # we may want to be OK with the branch name's URL slug
def show_commits(branch=None, search=None):
  """ Renders an index page of the commits in the branch organized by date."""
  max_count = int(request.args.get('count', 20))
  page = int(request.args.get('page', 0))
  # warning: list_commits only works 100% when displaying the commits in a single branch...
  ci_commits = [CiCommit(c) for c in list_commits(branch, page, max_count)]
  # we filter out commits without LSF logs
  ci_commits = [c for c in ci_commits if c.build_succeeded()]

  # to get max_count results per page we should do this within list_commits
  search = request.args.get('search', None)
  if search is not None:
    ci_commits = [c for c in ci_commits if search.lower() in c.gitcommit.message.lower()+c.gitcommit.author.name.lower()]

  return render_template('list.html',
              ci_commits=ci_commits,
              search=search,
              branch=repo.refs[branch] if branch else None, branches=repo.refs,
              users=get_users_per_name(""), page=page, min_page=max(0,page-2))



@app.route("/commit/<hexsha>", methods=["GET", "DELETE"])
@app.route("/commit/<hexsha>/", methods=["GET", "DELETE"])
@app.route("/commit/<hexsha>/<filename_filter>")
def render_commit(hexsha, filename_filter=None):
  """ Renders a page showing the results with a given code commit. """
  try:
    ci_commit = CiCommit(repo.commit(hexsha))
    # we compare versus the latest success commit on origin/develop
    # we could compare versus a parent instead: parent_successful_commit(ci_commit.gitcommit)
    hexsha_ref = request.args.get('reference', None)
    ci_commit_ref = CiCommit(repo.commit(hexsha_ref)) if hexsha_ref else latest_successful_commit('origin/develop')
  except:
    return "Sorry, the commit id was not found", 404

  if request.method == 'GET':
    outputs = ci_commit.outputs()
    outputs_ref = ci_commit_ref.outputs() if ci_commit_ref else {}

    if (filename_filter):
      outputs = {k:v for k,v in outputs.items() if filename_filter in k}
      outputs_ref = {k:v for k,v in outputs_ref.items() if filename_filter in k}

    with batches_filepath.open() as f:
      batches = f.read()

    return render_template('results-single.html',
                           show_table = bool(request.args.get('show_table', False)),
                           commit=ci_commit, commit_ref=ci_commit_ref,
                           outputs=outputs, outputs_ref=outputs_ref,
                           branch=ci_commit.branch(),
                           batches=batches)

  # delete the outputs to save storage
  if request.method == 'DELETE':
      ci_commit.delete()
      return "{message: 'OK'}"





@app.route("/batch/<hexsha>/", methods=['POST'])
def run_extra_batches(hexsha):
  """Allows users to run the SLAM on new recordings."""
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
      f'ssh arthurf-vdi "cd {ci_directory}/branches/develop/psp_swip/swip_slam/UnitTests;',
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



# it works but it is not enabled until we recompute metrics
# while keeping the time it took to run the SLAM
# @app.route("/metrics/<hexsha>", methods=['POST', 'GET'])
# def rerun_metric(hexsha):
#   commit = CiCommit(repo.commit(hexsha))
#   cmd = ' '.join([
#     f'ssh arthurf-vdi "cd {ci_directory}/branches/develop/psp_swip/swip_slam/UnitTests;',
#     f'setenv SLAM_WORKING_DIRECTORY= \'{commit.commit_dir}\';',
#     f'python tools/run.py metrics_for_all"'
#   ])
#   print(cmd)
#   subprocess.run(cmd, shell=True,
#                  encoding='utf-8',
#                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
#   flash(cmd)
#   flash('Results should arrive soon....')
#   return redirect('commit/'+hexsha)
