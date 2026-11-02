"""
Measures what deleted runs left on disk (soft deletes keep the manifests, and the files they don't list), for runs
deleted before QA-Board measured it when deleting: users see it in "Storage usage", next to their deleted runs.
Folders that are gone count as nothing left, checked once per batch (common.Folders).
"""
from sqlalchemy import text
from sqlalchemy.orm import joinedload

from ..database import db_session
from ..models import Output, Batch
from .. import storage_usage
from . import params as p
from .common import Folders, matching_projects
from .report import Reporter


PARAMS = ('projects', 'exclude_projects')
PAGE = 1000


def validate(params: dict) -> dict:
  p.known_keys(params, PARAMS)
  return {
    "projects": p.globs(params.get('projects'), 'projects', default=['*']),
    "exclude_projects": p.globs(params.get('exclude_projects'), 'exclude_projects'),
  }


def describe(params: dict) -> str:
  return f"Measure what the deleted runs of {', '.join(params['projects'])}{' except ' + ', '.join(params['exclude_projects']) if params['exclude_projects'] else ''} left on disk"


def run(params: dict, report: Reporter):
  everything = params['projects'] == ['*'] and not params['exclude_projects']
  projects = None if everything else matching_projects(params)
  folders = Folders()
  last_id = (report.progress.get('resume') or {}).get('output_id', 0)
  while not report.should_stop():
    query = """
      SELECT o.id FROM outputs o
      {join}
      WHERE o.deleted IS TRUE AND (o.data->>'storage_left') IS NULL AND o.id > :last {where}
      ORDER BY o.id LIMIT :page"""
    join, where = ("", "") if projects is None else (
      "JOIN batches b ON b.id = o.batch_id JOIN ci_commits c ON c.id = b.ci_commit_id", "AND c.project_id = ANY(:projects)")
    ids = [i for (i,) in db_session.execute(text(query.format(join=join, where=where)), {"last": last_id, "page": PAGE, "projects": projects or []})]
    if not ids:
      break
    last_id = ids[-1]
    outputs = (db_session.query(Output).filter(Output.id.in_(ids))
               .options(joinedload(Output.batch).joinedload(Batch.ci_commit)).all())
    batch_ids = set()
    for output in outputs:
      try:
        output_dir = output.output_dir
        missing = not folders.exists(output_dir, outside_storage=True)
      except Exception as e:
        # e.g. the storage isn't mounted: we'll measure it next time
        report.error('storage', f"run {output.id}: {e}", output_id=output.id, path=getattr(e, 'path', None))
        continue
      if missing:
        data = dict(output.data or {})
        data['storage_left'] = 0
        output.data = data
        report.add(runs_without_files=1)
      else:
        output.measure_left(output_dir)
        report.add(runs_measured=1, bytes_left=output.data['storage_left'])
      batch_ids.add(output.batch_id)
    db_session.commit()
    storage_usage.refresh_batches(batch_ids)
    report.add(runs_checked=len(ids))
    report.set(resume={"output_id": last_id})
    db_session.expunge_all()
