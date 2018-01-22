#!/usr/bin/env python3
"""
Flask web-app showing SLAM results in a digestible form.
"""
import datetime
import json
import subprocess

from flask import request, render_template, send_from_directory
from flask import redirect, flash
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import app, repo, db_session
from .models import CiCommit
from .models import latest_successful_commit
from .utils import get_users_per_name, filter_slam_outputs, palette
from .config import *


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
  if not branch:
    ci_commits = CiCommit.query.order_by(CiCommit.authored_datetime.desc()).limit(max_count).offset(page*max_count)
  else:
    commits = repo.iter_commits(branch, max_count=max_count, skip=max_count*page)
    commit_ids = [c.hexsha for c in commits]
    ci_commits = CiCommit.query.filter(CiCommit.id.in_(commit_ids)).order_by(CiCommit.authored_datetime.desc())
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
    commit = repo.commit(hexsha)
    ci_commit = CiCommit.query.filter(CiCommit.id==commit.hexsha).one()
  except NoResultFound:
    return "Sorry, the commit id was not found", 404

  # We compare versus the latest success commit on origin/develop
  # Note: we could compare versus a parent instead: parent_successful_commit(ci_commit.gitcommit)
  hexsha_ref = request.args.get('reference', None)
  try:
    if hexsha_ref: 
      commit_ref = repo.commit(hexsha_ref)
      ci_commit_ref = CiCommit.query.filter(CiCommit.id==commit_ref.hexsha).one()
    else:
      ci_commit_ref = latest_successful_commit('origin/develop')
  except:
    return "sorry there is an issue with the commit used for comparaison..."

  # the user can exlude/filter specific recordings with URL query parameters
  filename_filter = request.args.get('filter', '')
  filename_exclude = request.args.get('exclude', '')
  outputs = filter_slam_outputs(ci_commit.slam_outputs, filename_filter, filename_exclude)
  outputs_ref = filter_slam_outputs(ci_commit_ref.slam_outputs, filename_filter, filename_exclude)
  # for the display it's easier to have a dict of recording.name => output
  outputs = {o.recording.path: o for o in outputs if o.recording}
  outputs_ref = {o.recording.path: o for o in outputs_ref if o.recording}
  # we want it sorted (we could do it from SQL,,,)
  get_rmse = lambda o: -o[1].translation_aape if o[1].translation_aape else 0
  outputs = {k:v for k,v in sorted(outputs.items(), key=get_rmse)}
  outputs_ref = {k:v for k,v in sorted(outputs_ref.items(), key=get_rmse)}

  # we display the batches used when re-running on more movies
  with batches_filepath.open() as f:
    batches = f.read()

  # a lot of stuff needs to be in the template's scope...
  return render_template('commit-results.html',
                         show_table = bool(request.args.get('show_table', False)),
                         palette_deltas = palette,
                         filename_filter=filename_filter, filename_exclude=filename_exclude,
                         commit=ci_commit, commit_ref=ci_commit_ref,
                         outputs=outputs,
                         outputs_ref=outputs_ref,
                         branch=ci_commit.branch,
                         batches=batches)



@app.route("/metrics/<hexsha>", methods=['POST', 'GET'])
@app.route("/metrics/<hexsha>/", methods=['POST', 'GET'])
def rerun_metric(hexsha):
  """
  Re-computes the SLAM metrics for the specified commit using the latest scripts from develop.
  TODO: it should be one of CiCommit's methods.
  """
  try:
    commit = repo.commit(hexsha)
    ci_commit = CiCommit.query.filter(CiCommit.id==commit.hexsha).one()
  except NoResultFound:
    return "Sorry, the commit id was not found", 404
  cmd = ' '.join([
    f'ssh arthurf-vdi "cd {ci_directory}/branches/develop/psp_swip;',
    f'setenv SLAM_WORKING_DIRECTORY \'{ci_commit.commit_dir}\';',
    f'setenv CI_COMMIT_SHA \'{ci_commit.gitcommit.hexsha}\';',
    f'setenv SAMSUNG_CI_COMMIT_DIR \'{ci_commit.commit_dir}\';',
    f'python tools/performance-evaluation/run.py metrics_for_all"'
  ])
  print(cmd)
  flash(cmd)
  out = subprocess.run(cmd, shell=True,
                 encoding='utf-8',
                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
  print(out.stdout)
  print(out.stderr)
  flash(out.stdout)
  flash(out.stderr)
  return redirect('/commit/'+hexsha)


# quick and dirty
@app.route("/clean")
def clean():
  """Gets rid of old commits to save disk space."""
  out = subprocess.run('slamvizapp_clean', shell=True,
                       encoding='utf-8',
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
  print(out.stdout)
  print(out.stderr)
  flash(out.stdout)
  flash(out.stderr)
  return redirect('/')

@app.route("/batch/<hexsha>/", methods=['POST'])
def run_extra_batches(hexsha):
  """Allows users to run the SLAM on new recordings."""
  try:
    commit = repo.commit(hexsha)
    ci_commit = CiCommit.query.filter(CiCommit.id==commit.hexsha).one()
  except NoResultFound:
    return "Sorry, the commit id was not found", 404
  batch = request.form.get('batch', None)
  batches = request.form.get('batches', None)
  overwrite = '--overwrite' if request.form.get('overwrite', 'off')=='on' else ''

  if batches:
    with batches_filepath.open('w') as f:
      f.write(batches)
      flash('Updated batches!')

  if batch:
    ci_commit.time_of_last_slam_job = datetime.datetime.now().astimezone()
    db_session.add(ci_commit)
    db_session.commit()
    cmd = ' '.join([  
      f'ssh arthurf-vdi "cd {ci_directory}/branches/develop/psp_swip;',
      f'setenv SAMSUNG_CI_COMMIT_DIR \'{ci_commit.commit_dir}\';',
      f'setenv CI_COMMIT_SHA \'{ci_commit.gitcommit.hexsha}\';',
      f'python tools/performance-evaluation/run.py batch --batchfile {str(batches_filepath)} --batch {batch} {overwrite}"'
    ])
    print(cmd)
    # it will only work with my /home/arthurf/.cshrc file
    # it sets ENV variables as needed....
    out = subprocess.run(cmd, shell=True,
                   encoding='utf-8',
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    flash(cmd)
    flash(out.stdout)
    flash(out.stderr)
    flash('Results should arrive soon....')
  return redirect('commit/'+hexsha)



## Work in progress ###########################################################
@app.route("/tuning/<hexsha>")
@app.route("/tuning/<hexsha>/")
def tuning_view(hexsha):
  try:
    commit = repo.commit(hexsha)
    ci_commit = CiCommit.query.filter(CiCommit.id==commit.hexsha).one()
  except NoResultFound:
    return "Sorry, the commit id was not found", 404
  return render_template('tuning.html', ci_commit=ci_commit)
