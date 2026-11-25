"""
The time in UTC, as the naive datetimes the database columns store.

`datetime.datetime.utcnow()` and `utcfromtimestamp()` are deprecated since Python 3.12.
"""
import datetime


def utcnow() -> datetime.datetime:
  return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


def utcfromtimestamp(timestamp: float) -> datetime.datetime:
  return datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).replace(tzinfo=None)
