"""
Represents SLAM runs belonging to the same commit.
It might by a CI job, or tuning experiments.
"""
import re
import datetime
import json
import subprocess
from pathlib import Path
from functools import lru_cache

from requests.utils import quote
import numpy as np
from sqlalchemy import ForeignKey, Integer, String, DateTime, JSON
from sqlalchemy import UniqueConstraint, Column
from sqlalchemy.orm import relationship

from backend.models import Base, Output


def slugify(s : str, maxlength=64):
  """Slugiy a string like they do at Gitlab."""
  # lowercased and shortened to 63 bytes
  slug = s.lower()
  if maxlength:
    slug = slug[:(maxlength - 1)]
  # everything except 0-9 and a-z replaced with -. 
  slug = re.sub('[^0-9a-z.=]', '-', slug)
  slug = re.sub('-{2,}', '-', slug)
  # No leading / trailing -. 
  return slug.strip('-')


class Batch(Base):
  __tablename__ = 'batches'
  id = Column(Integer, primary_key=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow)
  data = Column(JSON(), default={})

  ci_commit_id = Column(Integer(), ForeignKey('ci_commits.id'), index=True)
  ci_commit = relationship("CiCommit", back_populates="batches", foreign_keys=[ci_commit_id])

  # identifies eg whether it is the default CI job, or a tuning experiment...
  label = Column(String(), default="default")

  __table_args__ = (UniqueConstraint('ci_commit_id', 'label', name='_ci_commit__label'),)

  outputs = relationship("Output",
                         back_populates="batch",
                         cascade="all, delete-orphan"
                        )

  @property
  def output_folder(self):
    return Path('output') if self.label == 'default' else Path('tuning') / slugify(self.label)

  @property
  def output_dir(self):
    return self.ci_commit.commit_dir / self.output_folder

  @property
  @lru_cache()
  def output_dir_url(self):
    return f"{self.ci_commit.commit_dir_url}/{quote(str(self.output_folder))}"

  def metrics(self, metric, outputs=None):
    """Returns a list of results - for a chosen metric - over the commit's outputs.
    The optionnal `outputs` parameter makes it almost like a static method.
    It helps with scope issues in the templates.
    """
    if not outputs:
      outputs = self.outputs
    return [getattr(o, metric) for o in outputs if hasattr(o, metric)]

  def to_dict(self, with_outputs=False, with_aggregation=None):
    metrics_to_aggregate  = with_aggregation if with_aggregation else {}
    if with_outputs:
      outputs = {'outputs': {o.id: o.to_dict() for o in self.outputs}}
    else:
      # we don't even supply a key, to make it easier for the JS code to
      # just update the batch properties when it get the full version  
      outputs = {}
    return {
        'id': self.id,
        'commit_id': self.ci_commit.hexsha,
        'label': self.label,
        'created_date': self.created_date.isoformat(),
        'data': self.data if self.data else {}, # None check for old batches (todo: migrate them properly)
        'output_dir_url': self.output_dir_url,

        'aggregated_metrics': aggregated_metrics(self.outputs, metrics_to_aggregate),
        'valid_outputs': len([o for o in self.outputs if not o.is_failed and not o.is_pending]),
        'pending_outputs': len([o for o in self.outputs if o.is_pending]),
        'running_outputs': len([o for o in self.outputs if o.is_running]),
        'failed_outputs': len([o for o in self.outputs if o.is_failed]),
        **outputs,
    }

  def __repr__(self):
    return (f"<Batch commmit='{self.ci_commit.hexsha}' "
            f"label='{self.label}' "
            f"outputs={len(self.outputs)} />")


  def stop(self):
    stdouts = []
    kill_commands = []
    for _, command in self.data.get('commands', {}).items():
      ssh = "LC_ALL=en_US.utf8 LANG=en_US.utf8 ssh -q -tt -i /home/arthurf/.ssh/ispq.id_rsa ispq@ispq-vdi"
      bsub = f"bsub_su {command['user']} -I"
      kill_command = f"{ssh} {bsub} bkill -J '{command['lsf_jobs_prefix']}/*'"
      kill_commands.append(kill_command)
      print(kill_command)
      out = subprocess.run(kill_command, shell=True, encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
      try:
        out.check_returncode()
        print(out.stdout)
        stdouts.append(str(out.stdout))
      except:
        # If LSF can't find the jobs, they are done already
        if 'No match' not in str(out.stdout):
          return {"error": str(out.stdout), "cmd": str(kill_command)}
    # TODO: check it's enough to mark all outputs as is_pending:false !
    return {"cmd": '\n'.join(kill_commands), "stdout": '\n\n'.join(stdouts)}


  def delete(self, session):
    """
    Hard delete the batch and all related outputs.
    Note: You should call .stop() before
    """
    for output in self.outputs:
      output.delete(soft=False)
      session.delete(output)
    session.delete(self)
    session.commit()


# TODO: refactored with proper SQL
def aggregated_metrics(outputs, metrics_to_aggregate):
  if not metrics_to_aggregate:
    return {}

  valid_outputs = [o for o in outputs if not o.is_failed and not o.is_pending]
  aggregated = {}
  for metric, treshold in metrics_to_aggregate.items():
    values = np.array([
        o.metrics[metric] for o in valid_outputs
        if metric in o.metrics and not o.metrics[metric] is None
    ])
    has_values = values.shape[0]>0
    aggregated[f'{metric}_median'] = np.median(values) if has_values else np.NaN
    aggregated[f'{metric}_average'] = np.average(values) if has_values else np.NaN
    # aggregated[f'{metric}_pc_bad'] = np.mean(values < treshold) if has_values else np.NaN
    # TODO: Use qatools to know if smaller_is_better
    # aggregated[f'{metric}_threshold_bad'] = treshold
  # Remove NaN values
  return {k: v for k, v in aggregated.items() if v == v}
