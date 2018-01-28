"""
Hacky-soon-to-be-removed version of CiCommit that lets you display the content of a folder.
It's 
- slow
- not integrate into the database
- missing lots of good date
"""
import datetime
import re
import json
from pathlib import Path

from .CiCommit import aggregated_metrics
from .SlamOutput import remap_metrics
from ..utils import filter_slam_outputs


class LocalGitCommit():
  def __init__(self, hexsha, message, author, authored_datetime):
    self.hexsha = hexsha
    self.message = message
    self.author = author
    self.authored_datetime = authored_datetime
    self.parents = [self]

class LocalRecording():
  def __init__(self, path):
    self.path = path

  @property
  def output_folder(self):
    """The path without .bin"""
    return self.path[:-4]

class LocalSlamOutput():
  def __init__(self, recording, platform, configuration, ci_commit):
    self.recording = recording
    self.platform = platform
    self.configuration = configuration
    self.is_pending = False
    self.is_failed = False
    self.ci_commit = ci_commit

  def update_metrics_from_file(self, filepath):
    """Updates the metrics from a file"""
    try:
      with filepath.open() as f:
        metrics = json.load(f)
    except:
      print(f'WARNING: failed to read {filepath}')
      metrics = {'is_failed': True}
    metrics = remap_metrics(metrics)
    for m in metrics:
      setattr(self, m, metrics[m]) 
    self.is_pending = False

  @property
  def output_dir_url(self):
    return self.ci_commit.commit_dir_url / 'output' / self.recording.output_folder


id_parser = re.compile(r'^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2})__local__(?P<author>[A-Za-z0-9]*)(?:__(?P<message>.*))*')

class LocalCommit():
  def __init__(self, commit_dir):
    print('getting local commit: ', commit_dir)
    commit_dir = '\\f2_algo_archive\\PTAM_Results/2018-01-25_14-13-19__local__elad__DEC_DEMO_Android_RT\StandardConfiguration\output'
    commit_dir = commit_dir.replace('\\', '/')
    commit_dir = commit_dir.replace('//', '/')
    commit_dir = commit_dir.replace('/f2_algo_archive','/net/f2/algo_archive')
    commit_dir = commit_dir.replace('/output', '')
    commit_dir = Path(commit_dir)

    self.commit_dir = commit_dir
    self.id = self.commit_dir.relative_to('/net/f2/algo_archive/PTAM_Results')    

    matches = id_parser.match(str(self.id)).groupdict()
    time = matches['time']
    self.authored_datetime = datetime.datetime.strptime(time, '%Y-%m-%d_%H-%M-%S')
    self.time_of_last_slam_job = self.authored_datetime
    self.branch = f"{matches['author']}'s LOCAL COMMIT"
    self.gitcommit = LocalGitCommit(
      hexsha = str(self.id),
      message = f"LOCAL COMMIT - {matches['message']}",
      author = matches['author'],
      authored_datetime = self.authored_datetime,
    )
    self.discover_slam_outputs()

  def discover_slam_outputs(self):
    self.slam_outputs = []
    output_dirs = [p.parent for p in self.output_dir.rglob('metrics.json')]
    for output_dir in output_dirs:
      print(output_dir)
      rel_recording_path = str(output_dir.relative_to(self.output_dir))+'.bin'
      recording = LocalRecording(rel_recording_path)
      slam_output = LocalSlamOutput(
        recording=recording,
        platform='s8' if 'Android' in str(self.commit_dir.parent.name) else 'lsf',
        configuration=self.commit_dir.name,
        ci_commit=self,
      )
      slam_output.update_metrics_from_file(output_dir/'metrics.json')
      self.slam_outputs.append(slam_output)


  @property
  def commit_dir_url(self):
    """The URL at which the data about this commit is stored. It's convenient."""
    # FIXME: have nginx server from /net/f2/algo_archive/PTAM_RESULTS
    return '/ss/'/self.commit_dir.relative_to('/net/f2/algo_archive/PTAM_Results')







  #############################################################################
  # Straight from CiCommit - maybe we should inherit...
  #############################################################################

  @property
  def output_dir(self):
    """Returns the folder where outputs are stored"""
    return self.commit_dir / 'output'


  @property
  def authored_date(self):
    return self.authored_datetime.date()

  @property
  def valid_slam_outputs(self):
    return [o for o in self.slam_outputs if not o.is_failed and not o.is_pending]

  @property
  def pending_slam_outputs(self):
    return [o for o in self.slam_outputs if o.is_pending]

  @property
  def failed_slam_outputs(self):
    return [o for o in self.slam_outputs if o.is_failed]


  def failures_count(self):
      """Returns an estimate of the number of failed runs"""
      return len([o for o in self.slam_outputs if o.is_failed])

  def aggregated_metrics(self, filename_filter='', filename_exclude=''):
      return aggregated_metrics(filter_slam_outputs(self.valid_slam_outputs, filename_filter, filename_exclude))

  def metrics(self, metric, outputs=None):
      """Returns a list of results - for a chosen metric - over the commit's outputs.
      The optionnal `outputs` parameter makes it almost like a static method. It helps with scope issues in the templates.
      """
      if not outputs:
        outputs = self.slam_outputs
      return [getattr(o, metric) for o in outputs if hasattr(o, metric)]

