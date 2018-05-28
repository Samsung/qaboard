"""
Hacky-soon-to-be-removed version of our models that lets us
display results computed outside of the CI.
It's slow, not integrated into the database, missing some data, but it does the job.
"""
import datetime
import re
import json
from pathlib import Path

from .Batch import aggregated_metrics
from .Output import Output
from ..utils import filter_outputs

class Committer():
  def  __init__(self, name):
    self.name = name

class LocalGitCommit():
  def __init__(self, hexsha, message, author, authored_datetime):
    self.id = hexsha
    self.hexsha = hexsha
    self.message = message
    self.author = author
    self.committer = Committer(author)
    self.committer_name = author
    self.authored_datetime = authored_datetime
    self.authored_date = authored_datetime
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


class LocalOutput():
  def __init__(self, recording, platform, configuration, batch):
    self.id = str(recording.path)
    self.recording = recording
    self.recording_id = 0
    self.platform = platform
    self.configuration = configuration
    self.extra_parameters = {}
    self.is_pending = False
    self.is_running = False
    self.is_failed = False
    self.batch = batch
    self.batch_id = 0
    self.parameters = {}

  @property
  def foldername(self):
    return Path(self.platform) / self.configuration / self.recording.output_folder

  @property
  def output_dir(self):
    return self.batch.output_dir / self.foldername

  @property
  def output_dir_url(self):
    return self.batch.output_dir_url / self.foldername

  def update_metrics(self, filepath):
    """Updates the metrics from a file"""
    try:
      with filepath.open() as f:
        metrics = json.load(f)
    except:
      print(f'WARNING: failed to read {filepath}')
      metrics = {'is_failed': True}
    setattr(self, 'metrics', metrics)
    self.is_pending = False
    self.is_running = False

  def to_dict(self):
    # return {}
    as_dict = {c.name: getattr(self, c.name)
               for c in Output.metadata.tables['outputs'].columns
               if hasattr(self, c.name)
              }
    return {
        **as_dict,
        'output_dir_url': str(self.output_dir_url),
        'recording_path': str(self.recording.path),
    }

class LocalBatch():
  def __init__(self, ci_commit, label='default', created_date=datetime.datetime.now()):
    self.ci_commit = ci_commit
    self.ci_commit_id = 0
    self.id = 0
    self.label = label
    self.created_date = created_date
    self.outputs = []

  @property
  def output_dir(self):
    return self.ci_commit.commit_dir / 'output'

  @property
  def output_dir_url(self):
    return self.ci_commit.commit_dir_url / 'output'

  def discover_outputs(self):
    output_dirs = [p.parent for p in self.output_dir.rglob('metrics.json')]
    for output_dir in output_dirs:
      platform, configuration, *rel_recording_path = output_dir.relative_to(self.output_dir).parts
      rel_recording_path = Path(*rel_recording_path)
      rel_recording_path = f'{rel_recording_path}.bin'
      recording = LocalRecording(rel_recording_path)
      output = LocalOutput(
          recording=recording,
          platform=platform,
          configuration=configuration,
          batch=self,
      )
      output.update_metrics(output_dir/'metrics.json')
      self.outputs.append(output)

  def to_dict(self, with_details=False):
    if with_details:
      details = {
          'outputs': {o.id: o.to_dict() for o in self.outputs},
      }
    else:
      details = {}
    return {
        'id': self.id,
        'commit_id': self.ci_commit_id,
        'label': self.label,
        'created_date': self.created_date.isoformat(),
        'aggregated_metrics': {k: v for k, v in self.aggregated_metrics().items() if v == v},
        'valid_outputs': len(self.valid_outputs),
        'pending_outputs': len(self.pending_outputs),
        'running_outputs': len(self.pending_outputs),
        'failed_outputs': len(self.failed_outputs),
        **details,
    }

  @property
  def valid_outputs(self):
    return [o for o in self.outputs if not o.is_failed and not o.is_pending]

  @property
  def pending_outputs(self):
    return [o for o in self.outputs if o.is_pending]

  @property
  def running_outputs(self):
    return [o for o in self.outputs if o.is_running]

  @property
  def failed_outputs(self):
    return [o for o in self.outputs if o.is_failed]


  def failures_count(self):
    """Returns an estimate of the number of failed runs"""
    return len([o for o in self.outputs if o.is_failed])

  def aggregated_metrics(self, filename_filter='', filename_exclude=''):
    return aggregated_metrics(filter_outputs(
        self.valid_outputs, filename_filter, filename_exclude)
                             )

  def metrics(self, metric, outputs=None):
    """Returns a list of results - for a chosen metric - over the commit's outputs.
    The optionnal `outputs` parameter makes it almost like a static method.
    It helps with scope issues in the templates.
    """
    if not outputs:
      outputs = self.outputs
    return [getattr(o, metric) for o in outputs if hasattr(o, metric)]




id_parser = re.compile('^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2})__local__(?P<author>[A-Za-z0-9]*)(?:__(?P<message>.*))*')

class LocalCommit():
  def __init__(self, commit_dir):
    # print('getting local commit: ', commit_dir)
    self.type = 'local'
    commit_dir = str(commit_dir)
    commit_dir = commit_dir.replace('\\', '/')
    commit_dir = commit_dir.replace('//', '/')
    if not commit_dir.startswith('/'):
      commit_dir = '/'+commit_dir
    commit_dir = commit_dir.replace('/f2_algo_archive', '/net/f2/algo_archive')
    if commit_dir.startswith('/f2'):
      commit_dir = '/net'+commit_dir
    commit_dir = commit_dir.replace('/f2_algo_archive', '/net/f2/algo_archive')
    commit_dir = commit_dir.replace('/output', '')
    if not commit_dir.startswith('/net'):
      commit_dir = f'/net/f2/algo_archive/PTAM_Results{commit_dir}'
    commit_dir = Path(commit_dir)

    self.commit_dir = commit_dir
    self.id = str(self.commit_dir.relative_to('/net/f2/algo_archive/PTAM_Results'))

    matches = id_parser.match(str(self.id)).groupdict()
    time = matches['time']
    self.authored_datetime = datetime.datetime.strptime(time, '%Y-%m-%d_%H-%M-%S')
    self.time_of_last_batch = self.authored_datetime
    self.branch = f"{matches['author']}'s LOCAL COMMIT"
    self.gitcommit = LocalGitCommit(
        hexsha=str(self.id),
        message=f"LOCAL COMMIT - {matches['message']}",
        author=matches['author'],
        authored_datetime=self.authored_datetime,
    )
    self.committer_name = matches['author']

    self.batches = [LocalBatch(self, 'default', self.authored_datetime)]
    self.batches[0].discover_outputs()
    self.latest_gitlab_pipeline = ''

  @property
  def commit_dir_url(self):
    """The URL at which the data about this commit is stored. It's convenient."""
    return '/s/'/self.commit_dir.relative_to('/net/f2')

  def to_dict(self, with_details=False, users_db=None):
    committer_avatar_url = ''
    if users_db:
      name = self.gitcommit.committer.name
      if name in users_db:
        committer_avatar_url = users_db[name]['avatar_url']
    return {
        'id': self.id,
        'branch': self.branch,
        'type': 'local',
        'message': self.gitcommit.message,
        'parents': [],
        'committer_name': self.gitcommit.committer.name,
        'committer_avatar_url': committer_avatar_url,
        'authored_datetime': self.authored_datetime.isoformat(),
        'authored_date': self.authored_date.isoformat(),
        'commit_dir_url': str(self.commit_dir_url),
        'time_of_last_batch': self.time_of_last_batch.isoformat(),
        'batches': {b.label: b.to_dict(with_details=with_details) for b in self.batches},
    }

  @property
  def authored_date(self):
    return self.authored_datetime.date()
