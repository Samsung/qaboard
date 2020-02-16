"""
Hacky-soon-to-be-removed version of our models that lets us
display results computed outside of the CI.
It's slow, not integrated into the database, missing some data, but it does the job.
"""
import datetime
import re
import json
from hashlib import md5
from pathlib import Path

from backend import db_session
from .Batch import aggregated_metrics
from .TestInput import TestInput
from .Output import Output
from ..utils import get_users_per_name

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


  @property
  def output_folder(self):
    """The path without .bin"""
    return self.path[:-4]

  @property
  def filename(self):
    """The path without .bin"""
    return self.path.split('/')[-1]


class LocalOutput():
  def __init__(self, test_input, platform, configuration, batch):
    self.id = f'{test_input.id}/{platform}/{configuration}'
    self.output_type = 'slam/6dof'
    self.test_input = test_input
    self.test_input_id = 0
    self.data = {}
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
    return Path(self.platform) / self.configuration / self.test_input.output_folder

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
    cols = [
     'id',
     'output_type',
     'platform',
     'configuration',
     'extra_parameters',
     'metrics',
     'is_failed',
     'is_pending',
     'is_running',
     'data',
    ]
    as_dict = {c: getattr(self, c) for c in cols}
    return {
        **as_dict,
        'output_dir_url': str(self.output_dir_url),
        'test_input_database': str(self.test_input.database),
        'test_input_path': str(self.test_input.path),
        'test_input_tags': self.test_input.data['tags'] if (self.test_input.data and 'tags' in self.test_input.data) else [],
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
      platform, configuration, *rel_input_path = output_dir.relative_to(self.output_dir).parts
      rel_input_path = Path(*rel_input_path)
      rel_input_path = f'{rel_input_path}.bin'
      test_input = TestInput.get_or_create(db_session, database=Path('/net/f2/algo_archive/DVS_SLAM_Database/'), path=rel_input_path)
      output = LocalOutput(
          test_input=test_input,
          platform=platform,
          configuration=configuration,
          batch=self,
      )
      output.update_metrics(output_dir/'metrics.json')
      self.outputs.append(output)

  def to_dict(self, with_outputs=False, with_aggregation=None):
    metrics_to_aggregate  = with_aggregation if with_aggregation else {}
    if with_outputs:
      outputs = {'outputs': {o.id: o.to_dict() for o in self.outputs}}
    else:
      outputs = {'outputs': {}}
    return {
        'id': self.id,
        'commit_id': self.ci_commit_id,
        'label': self.label,
        'created_date': self.created_date.isoformat(),

        'aggregated_metrics': aggregated_metrics(self.outputs, metrics_to_aggregate),
        'valid_outputs': len([o for o in self.outputs if not o.is_failed and not o.is_pending]),
        'pending_outputs': len([o for o in self.outputs if o.is_pending]),
        'running_outputs': len([o for o in self.outputs if o.is_running]),
        'failed_outputs': len([o for o in self.outputs if o.is_failed]),
        **outputs,
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
    return aggregated_metrics(self.valid_outputs)

  def metrics(self, metric, outputs=None):
    """Returns a list of results - for a chosen metric - over the commit's outputs.
    The optionnal `outputs` parameter makes it almost like a static method.
    It helps with scope issues in the templates.
    """
    if not outputs:
      outputs = self.outputs
    return [getattr(o, metric) for o in outputs if hasattr(o, metric)]

  def __repr__(self):
    return (f"<Batch commmit='{self.ci_commit.id}' "
            f"label='{self.label}' "
            f"outputs={len(self.outputs)} />")


id_parser = re.compile('^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2})__local__(?P<author>[A-Za-z0-9]*)(?:__(?P<message>.*))*')

class LocalCommit():
  def __init__(self, commit_dir):
    # print('getting local commit: ', commit_dir)
    self.commit_type = 'local'
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
    self.parents = []
    self.message = f"LOCAL COMMIT - {matches['message']}"
    self.gitcommit = LocalGitCommit(
        hexsha=str(self.id),
        message=self.message,
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


  def to_dict(self, with_aggregation=None, with_batches=None, with_outputs=False):
    users_db = get_users_per_name("")
    committer_avatar_url = ''
    if users_db:
      name = self.committer_name.lower()
      if name in users_db:
        committer_avatar_url = users_db[name]['avatar_url']
      elif name.replace('.', '') in users_db:
        committer_avatar_url = users_db[name.replace('.', '')]['avatar_url']
      elif name.replace(' ', '') in users_db:
        committer_avatar_url = users_db[name.replace('.', '')]['avatar_url']
      else:
        name_hash = md5(name.encode('utf8')).hexdigest()
        committer_avatar_url = f'http://gravatar.com/avatar/{name_hash}'
    return {
        'id': self.id,
        'type': self.commit_type,
        'branch': self.branch,
        'parents': self.parents,
        'message': self.message,
        'committer_name': self.committer_name,
        'committer_avatar_url': committer_avatar_url,
        'authored_datetime': self.authored_datetime.isoformat(),
        'authored_date': self.authored_date.isoformat(),
        'commit_dir_url': str(self.commit_dir_url),
        'batches': {b.label: b.to_dict(with_outputs=with_outputs, with_aggregation=with_aggregation)
                    for b in self.batches
                    if with_batches is None or b.label in with_batches},
        'time_of_last_batch': self.time_of_last_batch.isoformat(),
    }

  @property
  def authored_date(self):
    return self.authored_datetime.date()
