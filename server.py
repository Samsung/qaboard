#!/usr/bin/env python3
"""
Web-app showing SLAM results in a digestible form.
"""
import json
import subprocess
from pathlib import Path

from flask import Flask
from flask import request, render_template, redirect, send_from_directory, flash
app = Flask(__name__)
app.secret_key = 'A0Zr98j/3yX R~JHCXQ!fgdsrtgLWX/,?RT'

from git import Repo, Commit, RemoteProgress
from models import CiCommit, get_users_per_name
from config import *


try:
  repo = Repo("psp_swip")
except:
  print("Error: First initialize with `git clone git@gitlab-srv:dvs/psp_swip.git`")


def git_pull():
  class MyProgressPrinter(RemoteProgress):
    def update(self, op_code, cur_count, max_count=None, message=''):
      print(op_code, cur_count, max_count, cur_count / (max_count or 100.0), message or "NO MESSAGE")
  origin = repo.remotes.origin
  for fetch_info in origin.fetch(progress=MyProgressPrinter()):
    print("Updated %s to %s" % (fetch_info.ref, fetch_info.commit))


git_pull()


@app.route('/s/<path:filename>')
def serve_static(filename):
  """
  Serve static files: images, csv files, videos...
  This could (should) be done via a specialized reverse proxy (eg nginx) but we stick to simple things for now.
  """
  if filename.endswith('lsf.log'):
    return send_from_directory(str(ci_commits_directory), filename, mimetype="text/plain")
  return send_from_directory(str(ci_commits_directory), filename)




@app.route('/gitlab_webhook', methods=['GET', 'POST'])
def gitlab_webhook():
  data = json.loads(request.data)
  print(data)
  git_pull()
  return("{status:'OK'}")


@app.route("/")
@app.route("/commits")
@app.route("/commits/")
@app.route("/branch/<path:branch>") # can contain slashes..!
@app.route("/branch/<path:branch>/")
def show_commits(branch=None, search=None):
  """ Renders an index page of the commits in the branch organized by date."""
  # this will only work nicely when displaying the commits in one branch...
  max_count = request.args.get('count', 20)
  page = request.args.get('page', 0)

  commits = []
  branches = [branch] if branch is not None else repo.refs
  for b in branches:
    print(f'Listing <={max_count} commits in `{b}`')
    for c in repo.iter_commits(b, max_count=max_count, skip=page*max_count):
      commits.append(c)

  ci_commits = [CiCommit(c) for c in commits]

  # we filter those who did not even start CI performance tests...
  ci_commits = list(set([c for c in ci_commits if c.build_succeeded()]))
  ci_commits.sort(key=lambda c: c.gitcommit.authored_datetime, reverse=True)

  search = request.args.get('search', None)
  if search is not None:
    ci_commits = [c for c in ci_commits if search.lower() in c.gitcommit.message.lower()+c.gitcommit.author.name.lower()]

  return render_template('list.html',
              ci_commits=ci_commits,
              search=search,
              branch=branch if branch is not None else "All branches", branches=repo.refs,
              users=get_users_per_name(""))


@app.route("/commit/<hexsha>")
@app.route("/commit/<hexsha>/")
@app.route("/commit/<hexsha>/<filename_filter>")
def show_commit(hexsha, filename_filter=None, methods=["GET", "DELETE"]):
  """ Renders a page showing the results with a given code commit. """
  gitcommit = repo.commit(hexsha)
  if request.method == 'GET':
    return render_commit(CiCommit(gitcommit), filename_filter=filename_filter)
  # delete the outputs...
  if request.method == 'DELETE':
      CiCommit(gitcommit).delete()
      return "{message: 'OK'}"

batches_filepath = Path('data/extra-batches.yml').resolve()

def render_commit(ci_commit, filename_filter=None):
  outputs = ci_commit.outputs()
  if (filename_filter):
    outputs = [o for o in outputs if filename_filter in o['rel_filepath']]
  with batches_filepath.open() as f:
    batches = f.read()
  return render_template('results-single.html', commit=ci_commit, outputs=outputs,
                         metrics=ci_commit.metrics(), branch=ci_commit.branch(),
                         batches=batches)




@app.route("/batches/", methods=["GET","POST"])
@app.route("/batches", methods=["GET","POST"])
def extra_batches():
  if request.method == 'GET':
    with batches_filepath.open() as f:
      return f.read()
  if request.method == 'POST':
    return "OK"


@app.route("/batch/<hexsha>/", methods=['POST'])
def run_extra_batches(hexsha):
  commit = CiCommit(repo.commit(hexsha))
  batch = request.form.get('batch', None)
  batches = request.form.get('batches', None)
  print(batch)

  if batches:
    with batches_filepath.open('w') as f:
      f.write(batches)
      flash('Updated batches!')

  if batch:
    cmd = ' '.join([
      f'ssh arthurf-vdi "cd {ci_directory}/branches/develop/psp_swip/swip_slam/UnitTests;',
      f'setenv SAMSUNG_CI_COMMIT_DIR \'{commit.commit_dir}\'',
      f'python tools/run.py batch --batchfile {str(batches_filepath)} --batch {batch}"'
    ])
    # it will only work with my /home/arthurf/.cshrc file
    # it sets ENV variables as needed....
    subprocess.run(cmd, shell=True,
                   encoding='utf-8',
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    flash(cmd)
    flash('Results should arrive soon....')
  return redirect('commit/'+hexsha)
