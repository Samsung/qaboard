"""
"""
import datetime
import json
import shutil
import re
import sys
import pickle

import numpy as np

from utils import cache, is_new
from utils import get_users_per_name
from git_utils import find_branch, list_commits
from config import *


@cache(minutes=5)
def recordings(directory=default_recordings_directory):
    return [p.relative_to(directory) for p in directory.glob('**/*.bin')]


@cache(func_skip_cache=is_new)
class CiCommit():
    def __init__(self, commit):
        self.gitcommit = commit
        self.commit_dir = ci_commits_directory / f'{commit.authored_date}__git__{commit.hexsha[:8]}'
        self.output_dir = self.commit_dir / 'output'
        self.commit_dir_url = '/s'/self.commit_dir.relative_to(ci_commits_directory)

        # we use this to group commits together easily on index pages
        self.authored_date = self.gitcommit.authored_datetime.date()

        self._branch = None
        self._outputs = {}
        self._metrics = {}

        self._failed = False # build failure or else...
        self.ci_run_datetime = commit.authored_datetime

    def updating(self):
        return datetime.datetime.now().astimezone()-self.ci_run_datetime<datetime.timedelta(hours=1)


    def update(self):
        self.ci_run_datetime = datetime.datetime.now().astimezone()


    def build_succeeded(self):
        lsf_logs = ci_commits_directory / self.folder() /"lsf.log"
        return lsf_logs.exists()

    def number_failures(self):
        lsf_logs = ci_commits_directory / self.folder() /"lsf.log"
        with lsf_logs.open('r') as f:
            failures = 0
            for line in f:
                if re.search("Exited with exit code", line):
                    failures += 1
        return failures

    def folder(self):
        short_hash = self.gitcommit.hexsha[:8]
        return f"{self.gitcommit.authored_date}__git__{short_hash}"

    def username(self):
        return self.gitcommit.author.name

    def branch(self):
        self._branch = find_branch(self.gitcommit.hexsha)
        return self._branch

    def outputs(self):
        """ Gather the available results."""
        if not self._failed and not self._outputs or self.updating():
            self._outputs = {}
            self._metrics = {}
            print('getting outputs:', self.gitcommit.hexsha)
            output_dirs = [p.parent for p in self.output_dir.glob('**/camera_poses_debug.csv')]
            for output_dir in output_dirs:
                rel_recording_path = str(output_dir.relative_to(self.output_dir))+'.bin'
                rel_folderpath = str(output_dir.relative_to(ci_commits_directory))

                metrics_file = (output_dir/'metrics.json')
                if not metrics_file.exists(): 
                  # we changed the name of the metrics file at some point... sorry!
                  metrics_file = (output_dir/'lost-metrics.json')
                  if not metrics_file.exists():
                    continue
                with metrics_file.open() as f:
                    try:
                      metrics = json.load(f)
                    except:
                      print(f"bad json: {metrics_file}")
                      metrics = {"compute_time": 1, "duration": 1, "nb_lost": 0, "total_time_lost_pc":0}

                metrics_s8_file = output_dir/'metrics_s8.json'
                if (metrics_s8_file).exists():
                    with metrics_s9_file.open() as f:
                        metrics_s8 = json.load(f)
                else:
                    metrics_s8 = {}

                self._outputs[str(rel_recording_path)] = {
                    'output_dir': output_dir,
                    'output_dir_url': f'/s/{rel_folderpath}/', # URL at which the outputs are accessible
                    'rel_filepath': str(rel_recording_path),
                    'metrics': metrics,
                    'metrics_s8': metrics_s8,
                }

            get_rmse = lambda o: -o[1]['metrics']['translation_rmse'] if 'translation_rmse' in o[1]['metrics'] else 0
            self._outputs = {k:v for k,v in sorted(self._outputs.items(), key=get_rmse)}

            if not self._outputs and not is_new(self.gitcommit):
                self._failed = True
        return self._outputs


    def metrics(self):
        if not self._metrics:
            self._metrics = aggregated_metrics(self.outputs())
        return self._metrics

    def rmses(self):
        return [o['metrics']['translation_rmse'] for o in self.outputs().values() if 'translation_rmse' in o['metrics']]
    def aapes(self):
        return [o['metrics']['aape'] for o in self.outputs().values() if 'aape' in o['metrics']]
    def final_drifts_pc(self):
        return [o['metrics']['final_drift_pc'] for o in self.outputs().values() if 'final_drift_pc' in o['metrics']]

    def delete(self):
        print(f"removing {self.commit_dir}")
        shutil.rmtree(self.commit_dir)


def aggregated_metrics(outputs):
    metrics = [o['metrics'] for o in outputs.values()]
    compute_time = [m['compute_time']/m['duration'] for m in metrics if 'compute_time ' in m]
    rmse = [m['translation_rmse'] for m in metrics if 'translation_rmse' in m]
    aape = [m['aape'] for m in metrics if 'aape' in m]
    final_drift_pc = [m['final_drift_pc'] for m in metrics if 'final_drift_pc' in m]

    rmse_is_bad = [m['translation_rmse']>0.005 for m in metrics if 'translation_rmse' in m]
    aape_is_bad = [m['aape']>0.005 for m in metrics if 'aape' in m]
    final_drift_pc_is_bad = [m['final_drift_pc']>0.01 for m in metrics if 'final_drift_pc' in m]

    return {
        'compute_time_median': 1000*np.median(compute_time),
        'pc_where_lost_at_least_once': np.mean([m['nb_lost']>0 for m in metrics]),
        'total_time_lost_pc_mean': np.mean([m['total_time_lost_pc'] for m in metrics]),

        'rmse_median': np.median(rmse),
        'rmse_pc_bad': np.mean(rmse_is_bad),
        'aape_median': np.median(aape),
        'aape_pc_bad': np.mean(aape_is_bad),

        'final_drift_pc_median': np.median(final_drift_pc),
        'final_drift_pc_bad': np.mean(final_drift_pc_is_bad),
    }


def latest_successful_commit(branch='origin/develop'):
  """Returns the latest commit on a given branch where we got outputs."""
  # one of those should be successful
  ci_commits = [CiCommit(c) for c in list_commits(branch, page=0, max_count=20)]
  print(ci_commits)
  # likely we fetched the outputs before so it should be fast
  ci_commits = [c for c in ci_commits if c.outputs()]
  return ci_commits[0] if ci_commits else None 

def parent_successful_commit(ci_commit):
  """Returns a commit's latest successful parent."""
  # we don't handle merges that well
  parent = CiCommit(commit.gitcommit.parents[0])
  while not parent.outputs():
    parent = CiCommit(parent.gitcommit.parents[0])
  return parent

