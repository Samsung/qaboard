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

from .Batch import aggregated_metrics
from .SlamOutput import SlamOutput, remap_metrics
from ..utils import filter_slam_outputs


class LocalGitCommit():
  def __init__(self, hexsha, message, author, authored_datetime):
    self.id = hexsha
    self.hexsha = hexsha
    self.message = message
    self.author = author
    self.committer = {'name': author}
    self.committer_name = author
    self.authored_datetime = authored_datetime
    self.parents = [self]


class LocalRecording():
  def __init__(self, path):
    self.path = path

  @property
  def output_folder(self):
    """The path without .bin"""
    return self.path[:-4]

  @property
  def filename(self):
    """The path without .bin"""
    return self.path.split('/')[-1]


class LocalSlamOutput():
  def __init__(self, recording, platform, configuration, batch):
    self.id = str(recording.path)
    self.recording = recording
    self.recording_id = 0
    self.platform = platform
    self.configuration = configuration
    self.is_pending = False
    self.is_failed = False
    self.batch = batch
    self.batch_id = 0
    self.parameters = {}

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
    return self.batch.output_dir_url / self.platform / self.configuration / self.recording.output_folder

  def to_dict(self):
    # return {}
    as_dict = {c.name:getattr(self, c.name) for c in SlamOutput.metadata.tables['slam_outputs'].columns if hasattr(self, c.name)}
    return {
      **as_dict,
      'output_dir_url': str(self.output_dir_url),
      'recording_path': str(self.recording.path),
    }

class LocalBatch():
  def __init__(self, ci_commit, label='default'):
    self.ci_commit = ci_commit
    self.ci_commit_id = 0
    self.label = label

  def discover_slam_outputs(self):
    self.slam_outputs = []
    output_dirs = [p.parent for p in self.output_dir.rglob('metrics.json')]
    for output_dir in output_dirs:
      platform, configuration, *rel_recording_path = output_dir.relative_to(self.output_dir).parts
      rel_recording_path = Path(*rel_recording_path)
      rel_recording_path = f'{rel_recording_path}.bin'
      recording = LocalRecording(rel_recording_path)
      slam_output = LocalSlamOutput(
        recording=recording,
        platform=platform,
        configuration=configuration,
        batch=self,
      )
      slam_output.update_metrics_from_file(output_dir/'metrics.json')
      self.slam_outputs.append(slam_output)

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




id_parser = re.compile(r'^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2})__local__(?P<author>[A-Za-z0-9]*)(?:__(?P<message>.*))*')

class LocalCommit():
  def __init__(self, commit_dir):
    # print('getting local commit: ', commit_dir)
    self.type = 'local'
    commit_dir = str(commit_dir)
    commit_dir = commit_dir.replace('\\', '/')
    commit_dir = commit_dir.replace('//', '/')
    if not commit_dir.startswith('/'):
      commit_dir='/'+commit_dir
      print('+++')
    commit_dir = commit_dir.replace('/f2_algo_archive','/net/f2/algo_archive')
    if commit_dir.startswith('/f2'):
      commit_dir = '/net'+commit_dir
    commit_dir = commit_dir.replace('/f2_algo_archive','/net/f2/algo_archive')
    commit_dir = commit_dir.replace('/output', '')
    if not commit_dir.startswith('/net'):
      commit_dir = '/net/f2/algo_archive/PTAM_Results'+commit_dir
    commit_dir = Path(commit_dir)

    self.commit_dir = commit_dir
    self.id = str(self.commit_dir.relative_to('/net/f2/algo_archive/PTAM_Results'))    

    matches = id_parser.match(str(self.id)).groupdict()
    time = matches['time']
    self.authored_datetime = datetime.datetime.strptime(time, '%Y-%m-%d_%H-%M-%S')
    self.time_of_last_batch = self.authored_datetime
    self.branch = f"{matches['author']}'s LOCAL COMMIT"
    self.gitcommit = LocalGitCommit(
      hexsha = str(self.id),
      message = f"LOCAL COMMIT - {matches['message']}",
      author = matches['author'],
      authored_datetime = self.authored_datetime,
    )
    self.committer_name = matches['author']

    self.ci_batch = LocalBatch(self, 'default')
    self.ci_batch.discover_slam_outputs()
    self.latest_gitlab_pipeline = ''

  @property
  def commit_dir_url(self):
    """The URL at which the data about this commit is stored. It's convenient."""
    # FIXME: have nginx server from /net/f2/algo_archive/PTAM_RESULTS
    return '/ss/'/self.commit_dir.relative_to('/net/f2/algo_archive/PTAM_Results')

  def to_dict(self, with_details=False, users_db=None):
    committer_avatar_url = ''
    if users_db:
      name = self.gitcommit.committer['name']
      if name in users_db:
        committer_avatar_url= users_db[name]['avatar_url']
    if with_details:
      print({o.id: o.to_dict() for o in self.slam_outputs})
      details = {
        'slam_outputs': {o.id: o.to_dict() for o in self.slam_outputs}
      }
    else:
      details = {}
    return {
      'id': self.id,
      'branch': self.branch,
      'type': 'local',
      'message': self.gitcommit.message,
      'parents': [],
      'committer_name': self.gitcommit.committer['name'],
      'committer_avatar_url': committer_avatar_url,
      'authored_datetime': self.authored_datetime.isoformat(),
      'authored_date': self.authored_date.isoformat(),
      'commit_dir_url': str(self.commit_dir_url),
      'time_of_last_batch': self.time_of_last_batch.isoformat(),

      'aggregated_metrics': {k:v for k,v in self.ci_batch.aggregated_metrics().items() if v==v}, # => is not NaN
      'valid_slam_outputs': [o.recording.path for o in self.ci_batch.valid_slam_outputs],
      'pending_slam_outputs': [o.recording.path for o in self.ci_batch.pending_slam_outputs],
      'failed_slam_outputs': [o.recording.path for o in self.ci_batch.failed_slam_outputs],
      **details,
    }

  @property
  def output_dir(self):
    """Returns the folder where outputs are stored"""
    return self.commit_dir / 'output'


  @property
  def authored_date(self):
    return self.authored_datetime.date()

