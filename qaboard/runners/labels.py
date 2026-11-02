"""
Kubernetes label values, from names we don't control (users, projects, command ids).
Shared by the kubernetes runner and the server: the same input always gives the same label.
"""
import re
import hashlib

_label_value = re.compile(r'(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')


def is_label_value(value) -> bool:
  return isinstance(value, str) and len(value) <= 63 and bool(_label_value.fullmatch(value))


def label_value(value) -> str:
  """
  A valid label value: at most 63 characters, [A-Za-z0-9_.-], starting and ending with an alphanumeric.
  Valid values are kept. Otherwise invalid characters become '-', and a short hash of the value is added,
  so that different values (e.g. "a/b" and "a-b") never get the same label.
  """
  value = str(value)
  if is_label_value(value):
    return value
  digest = hashlib.sha256(value.encode('utf-8')).hexdigest()[:8]
  cleaned = re.sub(r'[^A-Za-z0-9_.-]', '-', value)
  cleaned = re.sub(r'^[^A-Za-z0-9]+', '', cleaned)[:63 - len(digest) - 1]
  cleaned = re.sub(r'[^A-Za-z0-9]+$', '', cleaned)
  return f'{cleaned}-{digest}' if cleaned else digest
