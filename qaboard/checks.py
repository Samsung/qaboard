"""
What `qa doctor` reports: one Check per thing that must work to run batches (config, server, storage, runner...).
Runners add their own checks with BaseRunner.doctor().
"""
from dataclasses import dataclass
from typing import Optional


OK = 'ok'
WARNING = 'warning'
ERROR = 'error'
SKIPPED = 'skipped'


@dataclass
class Check():
  # Short, e.g. "Kubernetes: permissions in namespace algo-qa"
  name: str
  # OK | WARNING | ERROR | SKIPPED
  status: str
  # What we found, in a sentence: "Can't create jobs: forbidden"
  message: str = ''
  # How to fix it, for the user or to send to their admins: commands, a qaboard.yaml snippet, RBAC YAML...
  # Can be multi-line. Shown as-is.
  fix: Optional[str] = None

  @property
  def failed(self) -> bool:
    return self.status == ERROR
