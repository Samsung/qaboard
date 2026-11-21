"""
What the shims of other trackers' APIs share: saying once what QA-Board doesn't mirror, and listing it at the end.

Code written for another tracker calls what QA-Board can't keep (tables, histograms, a model registry...). We never
fail a training for that: the call does nothing for QA-Board (and still works in the real tracker when we mirror),
the first time we say what was skipped and what to do instead, and when the run ends we list everything skipped.
"""
import sys
import threading
from collections import Counter
from typing import Dict, Optional

QUIET_VALUES = ('1', 'true', 'yes', 'on')


def say(message: str) -> None:
  print(f"qaboard: {message}", file=sys.stderr)


class Unsupported:
  """
  Counts what a shim couldn't mirror, by feature: `warn("wandb.Table", "saved as a JSON file, not shown as a table")`.
  The first call for a feature prints the hint; `report()` prints a summary, e.g. when the run ends.
  """
  def __init__(self, tool: str):
    self.tool = tool
    self.counts: Counter = Counter()
    self.hints: Dict[str, str] = {}
    self._lock = threading.Lock()

  def warn(self, feature: str, hint: str = '') -> None:
    with self._lock:
      first = feature not in self.counts
      self.counts[feature] += 1
      if hint:
        self.hints.setdefault(feature, hint)
    if first:
      say(f"WARNING: {feature} isn't supported by QA-Board{': ' + hint if hint else ''}. Said once; listed when the run ends.")

  def report(self, reset: bool = True) -> Optional[str]:
    """Prints what was skipped since the last report, and returns it. None when nothing was."""
    with self._lock:
      if not self.counts:
        return None
      lines = [f"  - {feature} ({count} call{'s' if count > 1 else ''}){': ' + self.hints[feature] if feature in self.hints else ''}"
               for feature, count in self.counts.most_common()]
      if reset:
        self.counts.clear()
    text = f"what {self.tool} code did that QA-Board didn't keep:\n" + "\n".join(lines)
    say(text)
    return text
