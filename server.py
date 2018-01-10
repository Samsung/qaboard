#!/usr/bin/env python3
"""
Flask web-app showing SLAM results in a digestible form.
"""
import datetime
import json
import subprocess

from flask import Flask
from flask import request, render_template, send_from_directory
from flask import redirect, flash
app = Flask(__name__)
# needed to use flask sessions and eg display flash messages after redirects
app.secret_key = 'A0Zr98j/3yX R~JHCXQ!fgdsrtgLWX/,?RT'

import matplotlib as mpl
import matplotlib.pyplot as plt
import matplotlib.cm as cm

from models import CiCommit, latest_successful_commit, parent_successful_commit
from git_utils import repo, git_pull, list_commits
from utils import get_users_per_name, filter_dict
from config import *


# users can request to run on new recordings - here we keep the list of available batches
batches_filepath = (app_data_directory/'extra-batches.yml').resolve()

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
  options = {"mimetype": "text/plain"} if filename.endswith('lsf.log') else {}
  return send_from_directory(str(ci_directory), filename, **options)


@app.route("/coverage")
def coverage_report():
  return redirect('/s/branches/develop/coverage/index.html')


@app.route("/")
@app.route("/commits")
@app.route("/commits/")
@app.route("/branch/<path:branch>")  # Branch names can contain slashes..
@app.route("/branch/<path:branch>/") # we may want to be OK with the branch name's URL slug
def show_commits(branch=None, search=None):
  """ Renders an index page of the commits in the branch organized by date."""
  max_count = int(request.args.get('count', 20))
  page = int(request.args.get('page', 0))
  # Warning: list_commits only works 100% when displaying the commits in a single branch...
  # To get exactly max_count results per page we should do this within list_commits
  try:
    ci_commits = [CiCommit(c) for c in list_commits(branch, page, max_count)]
    ci_commits = [c for c in ci_commits if c.lsf_logs.exists()]
  except:
    return "please retry in a few moments. Someone likely just pushed a commit."

  search = request.args.get('search', '').lower()
  if search:
    ci_commits = [c for c in ci_commits if search in c.gitcommit.message.lower()+c.gitcommit.author.name.lower()]

  return render_template('list.html',
              ci_commits=ci_commits,
              search=search,
              branch=repo.refs[branch] if branch else None, branches=repo.refs,
              users=get_users_per_name(""), page=page, min_page=max(0,page-2))





@app.route("/commit/<hexsha>")
@app.route("/commit/<hexsha>/")
def render_commit(hexsha):
  """ Renders a page showing the results with a given code commit. """
  try:
    ci_commit = CiCommit(repo.commit(hexsha))
  except:
    return "Sorry, the commit id was not found", 404


  # We compare versus the latest success commit on origin/develop
  # Note: we could compare versus a parent instead: parent_successful_commit(ci_commit.gitcommit)
  hexsha_ref = request.args.get('reference', None)
  ci_commit_ref = CiCommit(repo.commit(hexsha_ref)) if hexsha_ref else latest_successful_commit('origin/develop')
  if not ci_commit_ref:
    return "sorry there is an issue with the commit used for comparaison..."

  # the user can exlude/filter specific recordings with URL query parameters
  filename_filter = request.args.get('filter', '')
  filename_exclude = request.args.get('exclude', '')
  if request.method == 'GET':
    outputs = filter_dict(
      ci_commit.outputs(),
      filename_filter ,
      filename_exclude
    )
    outputs_ref = filter_dict(
      ci_commit_ref.outputs(),
      filename_filter ,
      filename_exclude
    )

    # we display the batches used when re-running on more movies
    with batches_filepath.open() as f:
      batches = f.read()

    # we prepare a color palette to for the summary table
    norm = mpl.colors.Normalize(vmin=-1.2, vmax=1.2)
    m = cm.ScalarMappable(norm=norm, cmap=plt.get_cmap('RdYlGn').reversed() )

    # a lot of stuff needs to be in the template's scope...
    return render_template('commit-results.html',
                           show_table = bool(request.args.get('show_table', False)),
                           palette_deltas = m,
                           filename_filter=filename_filter, filename_exclude=filename_exclude,
                           commit=ci_commit, commit_ref=ci_commit_ref,
                           outputs=outputs, outputs_ref=outputs_ref,
                           branch=ci_commit.branch(),
                           batches=batches)

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
    commit.ci_run_datetime = datetime.datetime.now().astimezone()
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



## Work in progress ###########################################################
@app.route("/tuning/<hexsha>")
@app.route("/tuning/<hexsha>/")
def tuning_view(hexsha):
    ci_commit = CiCommit(repo.commit(hexsha))
    return render_template('tuning.html', ci_commit=ci_commit)

@app.route("/metrics/<hexsha>", methods=['POST', 'GET'])
def rerun_metric(hexsha):
  commit = CiCommit(repo.commit(hexsha))
  cmd = ' '.join([
    f'ssh arthurf-vdi "cd {ci_directory}/branches/develop/psp_swip/swip_slam/UnitTests;',
    f'setenv SLAM_WORKING_DIRECTORY= \'{commit.commit_dir}\';',
    f'python tools/run.py metrics_for_all"'
  ])
  print(cmd)
  subprocess.run(cmd, shell=True,
                 encoding='utf-8',
                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
  flash(cmd)
  flash('Results should arrive soon....')
  return redirect('commit/'+hexsha)
