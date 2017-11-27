#!/usr/bin/env python3
"""
Web-app showing SLAM results in a digestible form.
"""
from itertools import groupby
import json

from flask import Flask
from flask import request, render_template, send_from_directory
app = Flask(__name__)


from git import Repo, Commit, RemoteProgress
from models import CiCommit, get_users_per_name
from config import ci_commits_directory


try:
  repo = Repo("psp_swip")
except:
  print("Error: First initialize with `git clone git@gitlab-srv:dvs/psp_swip.git`")


def git_pull():
  class MyProgressPrinter(RemoteProgress):
    def update(self, op_code, cur_count, max_count=None, message=''):
      print(op_code, cur_count, max_count, cur_count / (max_count or 100.0), message or "NO MESSAGE")
  origin = repo.remotes.origin
  # origin.fetch()
  # origin.pull()
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
@app.route("/branch/<branch>")
@app.route("/branch/<branch>/")
def show_commits(branch=None, search=None):
  """ Renders an index page of the commits in the branch organized by date."""
  # this will only work nicely when displaying the commits in one branch...
  max_count = request.args.get('count', 20)
  page = request.args.get('page', 0)

  ci_commits = []
  branches = [branch] if branch is not None else repo.refs
  for b in branches:
    print(f'Listing <={max_count} commits in `{b}`')
    for c in repo.iter_commits(b, max_count=max_count, skip=page*max_count):
      ci_commits.append(CiCommit(c))

  # we filter those who did not even start CI performance tests...
  ci_commits = [c for c in ci_commits if c.build_succeeded()]
  ci_commits.sort(key=lambda c: c.gitcommit.authored_datetime, reverse=True)

  search = request.args.get('search', None)
  if search is not None:
    ci_commits = [c for c in ci_commits if search.lower() in c.gitcommit.message.lower()+c.gitcommit.author.name.lower()]

  ci_commits_per_day = []
  keyfunc = lambda c: c.gitcommit.authored_datetime.strftime('%Y-%m-%dT')
  for k, g in groupby(ci_commits, keyfunc):
    ci_commits_per_day.append(list(g))
  return render_template('list.html',
              ci_commits_per_day=ci_commits_per_day,
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


def render_commit(ci_commit, filename_filter=None):
  outputs = ci_commit.outputs()
  if (filename_filter):
    outputs = [o for o in outputs if filename_filter in o['rel_filepath']]
  return render_template('results-single.html', commit=ci_commit, outputs=outputs,  metrics=ci_commit.metrics(), branch=ci_commit.branch())




# from models import *
# from models import aggregated_metrics
# from plots import create_curves_comparaison_image



# @app.route("/commit/<branch>/<commit_id>/update")
# def update_commit(branch="develop", commit_id):
#     """ Runs the SLAM on the new movies. """
#     commit = Commit(branch, commit_id)
#     commit.run_new_movies() 
#     return redirect(f"/commit/{commit_id}")


# @app.route("/compare")
# @app.route("/compare/curves")
# def compare_curves():
#     latest_commit_id = latest_commit().id
#     latest_milestone_id = '2017-06-19_13-46-30__local__sebastiend__milestone5 WithBundleAdjustment'
#     # latest_milestone_id = [id for id in all_commit_ids() if 'ilestone' in id][0]

#     commit_ref = Commit(    request.args.get('reference', latest_milestone_id))
#     commit_new = Commit(request.args.get('new', latest_commit_id))
  
#     # we only compare when we have results for both commits
#     recordings_paths = lambda outputs: [o['rel_filepath'] for o in outputs]
#     recordings_ref = set(recordings_paths(commit_ref.outputs()))
#     recordings_new = set(recordings_paths(commit_new.outputs()))
#     recordings_common = recordings_ref & recordings_new

#     # compare outputs
#     outputs_ref = {o['rel_filepath']: o for o in commit_ref.outputs() if o['rel_filepath'] in recordings_common}
#     outputs_new = {o['rel_filepath']: o for o in commit_new.outputs() if o['rel_filepath'] in recordings_common}
#     metrics_ref = aggregated_metrics(outputs_ref.values())
#     metrics_new = aggregated_metrics(outputs_new.values())

#     metrics = {m: {'new': metrics_new[m], 'ref': metrics_ref[m]} for m in metrics_ref}
#     outputs = [{
#         'rel_filepath': r,
#         'new': outputs_new[r],
#         'ref': outputs_ref[r],
#     } for r in recordings_common]
#     outputs = sorted(outputs, key=lambda o: -o['new']['metrics_lost']['drift_pc'])

#     for output in outputs:
#         create_curves_comparaison_image(output['ref']['output_dir'], output['new']['output_dir'], commit_ref.id)
#         output['compare_image_src'] = f"{output['new']['output_dir_url']}curves_vs_{commit_ref.id}.jpg"
#     return render_template('results-compare.html', commits={'new': commit_new, 'ref': commit_ref}, outputs=outputs, metrics=metrics)
