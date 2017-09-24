#!/usr/bin/env python3
"""
Web-app showing SLAM results in a digestible form.
"""
from itertools import groupby

from models import *
from models import aggregated_metrics
from plots import create_curves_comparaison_image
try:
    from user_config import ci_commits_directory
except:
    from config import ci_commits_directory

from flask import Flask
from flask import render_template, request, send_from_directory, redirect
app = Flask(__name__)


@app.route('/outputs/<path:filename>')
def outputs_static(filename):
    """ Serve videos and other output files. """
    return send_from_directory(str(ci_commits_directory), filename)

def render_commit(commit, filename_filter=None):
    outputs = commit.outputs()
    if (filename_filter):
        outputs = [o for o in outputs if filename_filter in o['rel_filepath']]
    return render_template('results-single.html', commit=commit, outputs=outputs,  metrics=commit.metrics())


@app.route("/commit")
@app.route("/commit/<commit_id>", methods=["GET", "DELETE"])
@app.route("/commit/<commit_id>/", methods=["GET", "DELETE"])
@app.route("/commit/<commit_id>/<filename_filter>", methods=["GET"])
def commit(commit_id=None, filename_filter=None):
    """ Renders a page showing the results with a given code commit. """
    if request.method == 'GET':
        commit = latest_commit() if not commit_id else Commit(commit_id)
        return render_commit(commit, filename_filter=filename_filter)
    if request.method == 'DELETE':
        Commit(commit_id).delete()
        return "{message: 'OK'}"


@app.route("/commit/<commit_id>/update")
def update_commit(commit_id):
    """ Runs the SLAM on the new movies. """
    commit = Commit(commit_id)
    commit.run_new_movies() 
    return redirect(f"/commit/{commit_id}")


@app.route("/")
@app.route("/commits")
def list_commits():
    """ Renders an index page of the commits organized by date. """
    commits_per_day = []
    keyfunc = lambda c: c.time.strftime('%Y-%m-%dT')
    commits = all_commits() # [id for id in ids if (os.environ['USER'] in id)]
    search = request.args.get('search', '')
    commits = [c for c in commits if search in c.id]
    for k, g in groupby(commits, keyfunc):
        commits_per_day.append(list(g))
    return render_template('list.html', commits_per_day=commits_per_day)







@app.route("/compare")
@app.route("/compare/curves")
def compare_curves():
    latest_commit_id = latest_commit().id
    latest_milestone_id = '2017-06-19_13-46-30__local__sebastiend__milestone5 WithBundleAdjustment'
    # latest_milestone_id = [id for id in all_commit_ids() if 'ilestone' in id][0]

    commit_ref = Commit(    request.args.get('reference', latest_milestone_id))
    commit_new = Commit(request.args.get('new', latest_commit_id))
    
    # we only compare when we have results for both commits
    recordings_paths = lambda outputs: [o['rel_filepath'] for o in outputs]
    recordings_ref = set(recordings_paths(commit_ref.outputs()))
    recordings_new = set(recordings_paths(commit_new.outputs()))
    recordings_common = recordings_ref & recordings_new

    # compare outputs
    outputs_ref = {o['rel_filepath']: o for o in commit_ref.outputs() if o['rel_filepath'] in recordings_common}
    outputs_new = {o['rel_filepath']: o for o in commit_new.outputs() if o['rel_filepath'] in recordings_common}
    metrics_ref = aggregated_metrics(outputs_ref.values())
    metrics_new = aggregated_metrics(outputs_new.values())

    metrics = {m: {'new': metrics_new[m], 'ref': metrics_ref[m]} for m in metrics_ref}
    outputs = [{
        'rel_filepath': r,
        'new': outputs_new[r],
        'ref': outputs_ref[r],
    } for r in recordings_common]
    outputs = sorted(outputs, key=lambda o: -o['new']['metrics_lost']['drift_pc'])

    for output in outputs:
        create_curves_comparaison_image(output['ref']['output_dir'], output['new']['output_dir'], commit_ref.id)
        output['compare_image_src'] = f"{output['new']['output_dir_url']}curves_vs_{commit_ref.id}.jpg"
    return render_template('results-compare.html', commits={'new': commit_new, 'ref': commit_ref}, outputs=outputs, metrics=metrics)


if __name__ == "__main__":
    app.run(threaded=True, host='0.0.0.0', debug=True)
