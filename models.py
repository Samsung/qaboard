import os
import sys
import subprocess
from pathlib import Path
import shutil
import datetime
import json
import re

import numpy as np
import pandas as pd

try:
    from user_config import *
except:
    from config import *


def read_config(path):
    """ Read *.py config files"""
    with path.open() as f:
        config={}
        exec(f.read(), globals(), config)
    return config

# until we get a proper database, we cache things a bit
# to understand the code, there is no need to read the following
# it should be replaced by a proper database :) 
def cache(minutes=1440, func_skip_cache=None):
    """Cache decorator with
    - minutes: time-to-live until the cache is expired. (default: 1day)
    - func_skip_cache: called on args[0], decides if we should skip the cache.
    """
    def cache_ttl_decorator(f):
        _cache = {}
        _last_accesses = {}
        def func_wrapper(*args, **kwargs):
            missing = args[0] not in _cache
            now = datetime.datetime.now()
            expired = missing or now-_last_accesses[args[0]]>datetime.timedelta(minutes=minutes)
            skipped = (func_skip_cache is not None) and func_skip_cache(args[0])
            if skipped or missing or expired:
                _last_accesses[args[0]] = now
                _cache[args[0]] = f(*args, **kwargs)
            return _cache[args[0]]
        return func_wrapper
    return cache_ttl_decorator

@cache(minutes=5)
def recordings(directory=default_recordings_directory):
    return [p.relative_to(directory) for p in directory.glob('**/*.bin')]





def is_new(id):
    time_s, *rest = id.split('__')
    time = datetime.datetime.strptime(time_s, '%Y-%m-%d_%H-%M-%S')
    return datetime.datetime.now()-time<datetime.timedelta(hours=6)


id_parser = re.compile(r'^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2})__(?P<type>[A-Za-z]*)__(?P<user>[A-Za-z0-9]*)(?:__(?P<message>.*))*')

@cache(func_skip_cache=is_new)
class Commit():
    def __init__(self, id):
        if not id:
            id = latest_commit_id()
        # allow to query part of the ID
        matches = ci_commits_directory.glob(f'{id}*') 
        self.commit_dir = sorted(matches, key=lambda p:p.stat().st_mtime)[-1]
        self.output_dir = self.commit_dir/'output'
        self.id = self.commit_dir.stem

        matches = id_parser.match(self.id).groupdict()
        time = matches['time']
        self.time = datetime.datetime.strptime(time, '%Y-%m-%d_%H-%M-%S')
        self.type = matches['type']
        self.user = matches['user'] # or svn revision if type==SVN..... then get user/message from `svn info -r ...`
        self.message = matches['message'] if matches['message'] is not None else 'local'
        self.short_id = "__".join([time, self.type, self.user])

        self._outputs = []
        self._metrics = {}
        self._pending__outputs = set() # available movies not yet SLAM'ed
        self._updating = datetime.datetime.now()-self.time<datetime.timedelta(hours=1)
        self._failed = False # build failure or else...

        try:
          config = read_config(self.commit_dir/'tests'/'config.py')
          self.recording_dir = Path(config['original_recordings_directory'])
          self.paramfile = Path(config['paramfile'])
          if os.name == 'nt':
              self.recording_dir = Path(str(self.recording_dir).replace(drive_mapping['linux'], drive_mapping['windows']))
        except:
          self.recording_dir = None
        # with (self.commit_dir/'mono_slam'/'params_linux.json').open() as f:
        #     self.params = json.load(f)

    def outputs(self):
        """ Gather the available results."""
        if not self._failed and not self._outputs or self._updating:
            self._outputs = []
            self._metrics = {}
            print('getting outputs:', self.id)
            if self.recording_dir is not None:
                recordings_ = recordings(self.recording_dir)
            else:
                recordings_ = [p.parent.with_suffix('.bin').relative_to(self.output_dir) for p in self.output_dir.glob('**/camera_poses_debug.csv')]
            for recording in recordings_:
                output_dir = self.output_dir/str(recording)[:-4] # remove ".bin"
                if not (output_dir/'lost-metrics.json').exists():
                    self._pending__outputs.add(recording)
                    continue
                with (output_dir/'lost-metrics.json').open() as f:
                    rel_folderpath = str(output_dir.relative_to(ci_commits_directory))
                    metrics_lost = json.load(f)
                    self._outputs.append({
                        'output_dir': output_dir,
                        'output_dir_url': f'/outputs/{rel_folderpath}/', # URL at which the outputs are accessible
                        'video_realtime_src': f"/outputs/{rel_folderpath}/results.realtime.mp4", # ?time={os.path.getmtime(video_path)}
                        'tracking_over_time':f'/outputs/{rel_folderpath}/curves.jpg',
                        'rel_filepath': str(recording),
                        'metrics_lost': metrics_lost,
                    })
            self._outputs = sorted(self._outputs, key=lambda o: -o['metrics_lost']['drift_pc'])

            if self._pending__outputs:
                self._pending__outputs = self._pending__outputs -  set([o['rel_filepath'] for o in self._outputs])
            else:
                self._updating = False
            is_old = datetime.datetime.now()-self.time>datetime.timedelta(hours=1)
            if not self._outputs and is_old:
                self._failed = True
        return self._outputs

    def run_new_movies(self):
        for recording in recordings(self.recording_dir):
            if not (self.output_dir/str(recording)[:-4]/'lost-metrics.json').exists():
                self._pending__outputs.add(recording)
                continue
        self._updating = True
        subprocess.Popen([sys.executable, str(self.commit_dir/'tests'/'run_tests.py'), "run_benchmark"], shell=True) # Path.cwd()/'..'/'tests'

    def metrics(self):
        if not self._metrics:
            self._metrics = aggregated_metrics(self.outputs())
        return self._metrics

    def drifts(self):
        return [100*o['metrics_lost']['drift_pc'] for o in self.outputs()]

    def drift_histogram(self):
        drifts = self.drifts()
        bins = np.arange(start=0., stop=100., step=0.5)
        hist = np.histogram(drifts, bins=bins) #bins='auto',
        return hist[0].tolist(), bins.tolist()

    def delete(self):
        print(f"removing {self.commit_dir}")
        shutil.rmtree(self.commit_dir)


def aggregated_metrics(outputs):
    """Computes aggregated metrics from multiple movies"""
    metrics = [o['metrics_lost'] for o in outputs]
    compute_times = [1000*m['compute_time']/m['duration'] for m in metrics]
    total_time_lost_pcs = [m['total_time_lost_pc'] for m in metrics]
    nb_losts = [m['nb_lost']>0 for m in metrics]
    losts = [m['nb_lost'] for m in metrics]
    high_drifts = [m['drift_pc']>0.02 for m in metrics]
    return {
        'lost_pc': np.mean(nb_losts),
        'compute_time_mean': np.mean(compute_times),
        'total_time_lost_pc_mean': np.mean(total_time_lost_pcs),
        'nb_high_drift': np.mean(high_drifts),
    }


def all_commit_ids():
    """Returns the list of all commit IDs"""
    commits_directories = [p for p in ci_commits_directory.iterdir() if p.is_dir()]
    commits_directories = sorted(commits_directories, key=lambda x: x.stat().st_ctime, reverse=True)
    return [c.name for c in commits_directories]

def all_commits():
    """Returns a list of all Commits, the most recents being last."""
    return [Commit(id) for id in all_commit_ids()]


def latest_commit_id():
    return all_commit_ids()[0]

def latest_commit():
    return Commit(latest_commit_id())
