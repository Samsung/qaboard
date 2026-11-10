"""
Kubernetes label values, shared by the runners that label what they create (kubernetes, dask on Kubernetes) and the
QA-Board server, that selects them with the same values to stop a batch's jobs: both must sanitize the same way.
"""
import re
import hashlib

MAX_LABEL_VALUE = 63
_valid = re.compile(r'([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?')
_invalid_chars = re.compile(r'[^-A-Za-z0-9_.]')


def label_value(value) -> str:
  """
  `value` as a Kubernetes label value: at most 63 characters among [A-Za-z0-9_.-], starting and ending with an
  alphanumeric character. Valid values are kept as they are. Others get their invalid characters replaced by "-",
  are shortened if needed, and end with a short hash of the original value, so that different values stay different:
      label_value("algo/project") == "algo-project-<8 hex digits>"
  """
  value = '' if value is None else str(value)
  if len(value) <= MAX_LABEL_VALUE and _valid.fullmatch(value):
    return value
  digest = hashlib.sha256(value.encode('utf-8')).hexdigest()[:8]
  cleaned = _invalid_chars.sub('-', value)[:MAX_LABEL_VALUE - len(digest) - 1].strip('-_.')
  return f"{cleaned}-{digest}" if cleaned else digest
