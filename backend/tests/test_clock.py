import datetime
import re
from pathlib import Path

from backend import clock


def test_utcnow_is_naive_utc():
  now = clock.utcnow()
  assert now.tzinfo is None
  aware = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
  assert abs((aware - now).total_seconds()) < 5


def test_utcfromtimestamp():
  assert clock.utcfromtimestamp(0) == datetime.datetime(1970, 1, 1)
  assert clock.utcfromtimestamp(86400.5) == datetime.datetime(1970, 1, 2, 0, 0, 0, 500000)


def test_the_backend_does_not_use_the_deprecated_utc_functions():
  root = Path(clock.__file__).parent
  deprecated = re.compile(r'^[^#]*\bdatetime\.(utcnow|utcfromtimestamp)\(', re.M)
  offenders = [str(path.relative_to(root)) for path in root.rglob('*.py') if path.name != 'clock.py' and deprecated.search(path.read_text())]
  assert not offenders, f"use backend.clock instead of datetime.datetime.utcnow/utcfromtimestamp in {offenders}"
