"""
"""
import datetime
import json
import shutil
import re
import sys
import pickle

import numpy as np

from utils import cache
from utils import get_users_per_name
from git_utils import find_branch, list_commits
from config import *


@cache(minutes=5)
def recordings(directory=default_recordings_directory):
    return [p.relative_to(directory) for p in directory.glob('**/*.bin')]


def is_new(commit, hours=1):
    return datetime.datetime.now().astimezone()-commit.authored_datetime < datetime.timedelta(hours=hours)


@cache(func_skip_cache=is_new)
class CiCommit():
    """Represents a commit on which we ran the CI."""
    def __init__(self, commit):
        # gitpython Commit
        self.gitcommit = commit

        # Other members provide a way to know on which movies we ran the SLAM, get metrics...
        self.folder = f'{commit.authored_date}__git__{commit.hexsha[:8]}'
        self.commit_dir = ci_directory / 'commits' / self.folder
        self.lsf_logs = self.commit_dir / 'lsf.log'
        self.output_dir = self.commit_dir / 'output'
        # URL when we want to read specific files from the web
        self.commit_dir_url = '/s/'/self.commit_dir.relative_to(ci_directory)

        self.authored_date = self.gitcommit.authored_datetime.date()

        self._branch = None
        self._outputs = {}
        self._metrics = {}

        self._failed = False # build failure or else...
        self.ci_run_datetime = commit.authored_datetime




    def run_parameters(self):
        parameter_file = self.commit_dir /"params.json"
        if parameter_file.exists():
            with parameter_file.open() as f:
                return json.load(f)
        else:
            return {}

    def number_failures(self):
        """Returns an estimate of the number of failed runs from the LSF logs"""
        if not self.lsf_logs.exists():
            return '[ALL]'
        with self.lsf_logs.open('r') as f:
            failures = 0
            for line in f:
                if re.search("Exited with exit code", line):
                    failures += 1
        return failures

    # Finding to branch to which a commit belongs is ... a guess
    # and it can be slow, so we cache the results
    def branch(self):
        self._branch = find_branch(self.gitcommit.hexsha)
        return self._branch

    # Without a database, listing the recordings for which we have outputs (metrics, etc) is slow
    def updating(self):
        """If there is no SLAM run currently being computed, we can safely cache the results."""
        return datetime.datetime.now().astimezone()-self.ci_run_datetime<datetime.timedelta(hours=1)

    def outputs(self, filename_filter='', filename_exclude=''):
        """ Gather the available results for this commit."""
        # if we ask a specific filter, we don't use the cache
        if (filename_filter or filename_exclude) and self._outputs:
            return filter_dict(self._outputs, filename_filter, filename_exclude)

        # if we haven't already cached results, or we're still computing them, or we gave up hope
        if not self._failed and not self._outputs or self.updating():
            print('getting outputs:', self.gitcommit.hexsha)
            self._outputs = {}
            self._metrics = {}

            # Those files are the SLAM results
            output_dirs = [p.parent for p in self.output_dir.rglob('camera_poses_debug.csv')]
            for output_dir in output_dirs:
                rel_recording_path = str(output_dir.relative_to(self.output_dir))+'.bin'
                rel_folderpath = str(output_dir.relative_to(ci_commits_directory))

                metrics_file = (output_dir/'metrics.json')
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

            # we sort the dict by success
            get_rmse = lambda o: -o[1]['metrics']['aape'] if 'aape' in o[1]['metrics'] else 0
            self._outputs = {k:v for k,v in sorted(self._outputs.items(), key=get_rmse)}

            if not self._outputs and not is_new(self.gitcommit):
                self._failed = True
        return self._outputs


    def aggregated_metrics(self, filename_filter='', filename_exclude=''):
        # in this case we avoid any caching
        if filename_filter or filename_exclude:
            outputs = self.outputs(filename_filter, filename_exclude)
            return aggregated_metrics(outputs)

        if not self._metrics:
            self._metrics = aggregated_metrics(self.outputs())
        return self._metrics

    def metrics(self, metric, outputs=None):
        """Returns a list of results - for a chosen metric - over the commit's outputs.
        The optionnal `outputs` parameter makes it almost like a static method. It helps with scope issues in the templates.
        """
        if not outputs:
            outputs = self.outputs()
        return [o['metrics'][metric] for o in outputs.values() if metric in o['metrics']]



# this is so ugly
def aggregated_metrics(outputs):
    metrics = [o['metrics'] for o in outputs.values()]
    compute_time = [m['compute_time']/m['duration'] for m in metrics if 'compute_time ' in m]

    translation_rmse = [m['translation_rmse'] for m in metrics if 'translation_rmse' in m]
    rotation_rmse = [m['rotation_rmse'] for m in metrics if 'rotation_rmse' in m]
    rotation_mean = [m['rotation_mean'] for m in metrics if 'rotation_mean' in m]
    final_drift_pc = [m['final_drift_pc'] for m in metrics if 'final_drift_pc' in m]
    aape = [m['aape'] for m in metrics if 'aape' in m]

    translation_rmse_is_bad = [m['translation_rmse']>0.01 for m in metrics if 'translation_rmse' in m]
    rotation_rmse_is_bad = [m['rotation_rmse']>1.5 for m in metrics if 'rotation_rmse' in m]
    rotation_mean_is_bad = [m['rotation_mean']>1.5 for m in metrics if 'rotation_mean' in m]
    final_drift_pc_is_bad = [m['final_drift_pc']>0.01 for m in metrics if 'final_drift_pc' in m]
    aape_is_bad = [m['aape']>0.01 for m in metrics if 'aape' in m]

    return {
        'compute_time_median': 1000*np.median(compute_time),
        'pc_where_lost_at_least_once': np.mean([m['nb_lost']>0 for m in metrics]),
        'total_time_lost_pc_mean': np.mean([m['total_time_lost_pc'] for m in metrics]),

        'translation_rmse_median': np.median(translation_rmse),
        'translation_rmse_average': np.mean(translation_rmse),
        'translation_rmse_pc_bad': np.mean(translation_rmse_is_bad),

        'rotation_rmse_median': np.median(rotation_rmse),
        'rotation_rmse_average': np.mean(rotation_rmse),
        'rotation_rmse_pc_bad': np.mean(rotation_rmse_is_bad),


        'rotation_mean_median': np.median(rotation_mean),
        'rotation_mean_average': np.mean(rotation_mean),
        'rotation_mean_pc_bad': np.mean(rotation_mean_is_bad),

        'aape_median': np.median(aape),
        'aape_pc_bad': np.mean(aape_is_bad),

        'final_drift_pc_median': np.median(final_drift_pc),
        'final_drift_pc_bad': np.mean(final_drift_pc_is_bad),
    }


def latest_successful_commit(branch='origin/develop'):
  """Returns the latest commit on a given branch where we got outputs."""
  # one of those should be successful
  page = 0
  while page<10:
    ci_commits = [CiCommit(c) for c in list_commits(branch, page=page, max_count=20)]
    # likely we fetched the outputs before so it should be fast
    ci_commits = [c for c in ci_commits if len(c.outputs())>10]
    if ci_commits:
      return ci_commits[0]  
    page = page + 1

def parent_successful_commit(ci_commit):
  """Returns a commit's latest successful parent."""
  # we don't handle merges that well
  parent = CiCommit(commit.gitcommit.parents[0])
  while not parent.outputs():
    parent = CiCommit(parent.gitcommit.parents[0])
  return parent

