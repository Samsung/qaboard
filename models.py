import datetime
import json
import shutil
import re
import sys
import pickle

import numpy as np

from utils import cache, is_new
from utils import get_users_per_name
from config import *

from git import Repo
repo = Repo("psp_swip")


@cache(minutes=5)
def recordings(directory=default_recordings_directory):
    return [p.relative_to(directory) for p in directory.glob('**/*.bin')]

if not Path('data/commits.pkl').exists():
    commit_branches = {}
    pickle.dump(commit_branches, open('data/commits.pkl', 'wb'))

commit_branches = pickle.load(open('data/commits.pkl', 'rb'))

def find_branch(commit_hash):
    if commit_hash in commit_branches:
      return commit_branches[commit_hash]
    else:
      std_out = repo.git.branch(contains=commit_hash, remotes=True)
      line = std_out.splitlines()[0]
      commit_branches[commit_hash] = line.split(' ')[-1]
      pickle.dump(commit_branches, open('data/commits.pkl', 'wb'))
    return commit_branches[commit_hash]


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
        self._outputs = []
        self._metrics = {}
        self._pending__outputs = set() # available movies not yet SLAM'ed
        self._updating = datetime.datetime.now().astimezone()-commit.authored_datetime<datetime.timedelta(hours=1)
        self._failed = False # build failure or else...

        self.params_path = self.commit_dir / "params.json"
        try:
          with (self.params_path).open() as f:
              self.params = json.load(f)
        except FileNotFoundError:
            self._failed = True

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
        if not self._failed and not self._outputs or self._updating:
            self._outputs = []
            self._metrics = {}
            print('getting outputs:', self.gitcommit.hexsha)
            output_dirs = [p.parent for p in self.output_dir.glob('**/camera_poses_debug.csv')]
            for output_dir in output_dirs:
                rel_recording_path = output_dir.relative_to(self.output_dir).with_suffix('.bin')

                metrics_file = (output_dir/'metrics.json')
                if not metrics_file.exists(): 
                    # we changed the name of the metrics file at some point... sorry!
                    metrics_file = (output_dir/'lost-metrics.json')
                if not metrics_file.exists():
                    self._pending__outputs.add(rel_recording_path)
                    continue
                with metrics_file.open() as f:
                    rel_folderpath = str(output_dir.relative_to(ci_commits_directory))
                    metrics = json.load(f)
                    self._outputs.append({
                        'output_dir': output_dir,
                        'output_dir_url': f'/s/{rel_folderpath}/', # URL at which the outputs are accessible
                        'video_realtime_src': f"/s/{rel_folderpath}/results.mp4", # ?time={os.path.getmtime(video_path)}
                        'tracking_over_time':f'/s/{rel_folderpath}/curves.jpg',
                        '6dof':f'/s/{rel_folderpath}/camera_poses_debug.csv',
                        '6dof_s8':f'/s/{rel_folderpath}/camera_poses_debug_s8.csv',
                        '6dof_groundtruth':f'/s/{rel_folderpath}/GT_final.csv',
                        'rel_filepath': str(rel_recording_path),
                        'metrics': metrics,
                    })
            for o in self._outputs:
                if 'translation_rmse' not in o['metrics']:
                    o['metrics']['translation_rmse'] = 10e6
            self._outputs = sorted(self._outputs, key=lambda o: -o['metrics']['translation_rmse'] )

            if self._pending__outputs:
                self._pending__outputs = self._pending__outputs -  set([o['rel_filepath'] for o in self._outputs])
            else:
                self._updating = False
            if not self._outputs and not is_new(self.gitcommit):
                self._failed = True
        return self._outputs


    def metrics(self):
        if not self._metrics:
            self._metrics = aggregated_metrics(self.outputs())
        return self._metrics

    def rmses(self):
        return [o['metrics']['translation_rmse'] for o in self.outputs()]

    def rmse_histogram(self):
        rmses = self.rmses()
        bins = np.arange(start=0., stop=0.1, step=0.001)
        hist = np.histogram(rmses, bins=bins) #bins='auto',
        return hist[0].tolist(), bins.tolist()

    def delete(self):
        print(f"removing {self.commit_dir}")
        shutil.rmtree(self.commit_dir)


# def run_new_movies(self):
#     for recording in recordings(self.recording_dir):
#         if not (self.output_dir/str(recording)[:-4]/'lost-metrics.json').exists():
#             self._pending__outputs.add(recording)
#             continue
#     self._updating = True
#     subprocess.Popen([sys.executable, str(self.commit_dir/'tests'/'run_tests.py'), "run_benchmark"], shell=True) # Path.cwd()/'..'/'tests'

# import os
# import sys
# import subprocess
# from pathlib import Path

# import pandas as pd
# from utils import read_config

def aggregated_metrics(outputs):
    metrics = [o['metrics'] for o in outputs]
    compute_times = [1000*m['compute_time']/m['duration'] for m in metrics]
    total_time_lost_pcs = [m['total_time_lost_pc'] for m in metrics]
    nb_losts = [m['nb_lost']>0 for m in metrics]
    losts = [m['nb_lost'] for m in metrics]
    # high_drifts = [m['drift_pc']>0.02 for m in metrics]
    high_rmses = [m['translation_rmse']>0.005 for m in metrics]
    return {
        'lost_pc': np.mean(nb_losts),
        'compute_time_mean': np.mean(compute_times),
        'total_time_lost_pc_mean': np.mean(total_time_lost_pcs),
        # 'nb_high_drift': np.mean(high_drifts),
        'nb_high_rmse': np.mean(high_rmses),
    }
