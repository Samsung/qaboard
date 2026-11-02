"""
Recomputes the storage usage of every batch (backend/storage_usage.py), chunk by chunk. The worker keeps it up to date
between rebuilds, for the commits that get new runs and what's deleted from QA-Board: rebuilds catch the rest
(e.g. runs deleted by scripts). The worker schedules one every night, and runs one if there was none.
"""
from .. import storage_usage
from . import params as p
from .report import Reporter


PARAMS = ()
BATCHES_PER_CHUNK = 20_000


def validate(params: dict) -> dict:
  p.known_keys(params, PARAMS)
  return {}


def describe(params: dict) -> str:
  return "Compute how much storage the runs of every batch use"


def run(params: dict, report: Reporter):
  end = storage_usage.max_batch_id() + 1
  start = (report.progress.get('resume') or {}).get('batch_id', 0)
  report.set(batches_total=end)
  while start < end:
    if report.should_stop():
      return
    rows = storage_usage.refresh_range(start, start + BATCHES_PER_CHUNK)
    start += BATCHES_PER_CHUNK
    report.add(rows=rows)
    report.set(resume={"batch_id": start}, batches_done=min(start, end))
  report.log(f"{report.progress.get('rows', 0)} batches and users with runs")
