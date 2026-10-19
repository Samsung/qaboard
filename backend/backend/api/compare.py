"""
GET /api/v1/commit/<sha>/compare?project=&reference=&batch=

A commit's runs against a reference, with the numbers of the commit page's Summary and Metrics Diff views:
the median of each metric and its change, each run next to its reference run, and how many runs failed.
`qa gate` uses it, and so can scripts and agents. See backend/backend/compare.py for the numbers.

Query parameters:
- `project` (required)
- `batch`: the batch label, default `default` (the CI batch, shown as "CI": `ci` also names it)
- `reference`: a shared milestone (its label, or `#<id>` for any milestone), a commit sha or a branch (its latest commit with runs in the batch).
   Default: the commit's `gate.reference` in qaboard.yaml, else `project.reference_branch`.
- `reference_batch`: the reference's batch label, default `batch` (for a milestone: its batch)
- `metrics`: a comma-separated list of metrics, default all those with numbers in the commit's runs
- `bit_accuracy`: `true` to compare the runs' output files, like `qa check-bit-accuracy`
"""
import re
import json

from flask import request, jsonify

from backend import app, db_session
from .auth import is_authorized_user
from ..models import CiCommit, Batch, Milestone
from ..compare import compare_outputs, run_counts, manifests_mismatch
from ..storage import is_storage_path


def is_ci_alias(label: str) -> bool:
  """The CI batch's label is `default`, and the web app shows it as "CI" """
  return label.lower() == 'ci'


def find_batch(commit, label: str):
  """The commit's batch with this label. `ci` names the CI batch, unless a batch is labelled `ci`."""
  batches = {b.label: b for b in commit.batches}
  if label in batches:
    return batches[label]
  if is_ci_alias(label):
    return batches.get('default')
  return None


def find_commit(project_id: str, hexsha: str):
  """The commit with this sha (or the start of its sha) in the project, or None"""
  return (db_session
          .query(CiCommit)
          .filter(CiCommit.project_id == project_id, CiCommit.hexsha.startswith(hexsha))
          .order_by(CiCommit.authored_datetime.desc())
          .first())


def has_results(batch) -> bool:
  """Runs that finished without failing, or still running"""
  return any(o.is_pending or not o.is_failed for o in batch.outputs)


def find_branch_commit(project_id: str, branch: str, label: str, commit):
  """
  The latest commit on the branch with runs in the batch, other than `commit`.
  When `commit` is itself on that branch, the latest one before it.
  """
  from sqlalchemy import or_
  branches = [branch, f'origin/{branch}']
  labels = [label, 'default'] if is_ci_alias(label) else [label]
  query = (db_session
           .query(CiCommit)
           .join(Batch, Batch.ci_commit_id == CiCommit.id)
           .filter(
             CiCommit.project_id == project_id,
             or_(*[CiCommit.branch == b for b in branches]),
             Batch.label.in_(labels),
             CiCommit.id != commit.id,
           ))
  if commit.branch in branches and commit.authored_datetime:
    query = query.filter(CiCommit.authored_datetime <= commit.authored_datetime)
  for candidate in query.order_by(CiCommit.authored_datetime.desc()).limit(50):
    batch = find_batch(candidate, label)
    if batch and has_results(batch):
      return candidate
  return None


def milestones_of(project_id: str, milestone_id=None):
  """The project's shared milestones, the most recently saved first. With an id, that milestone, shared or not."""
  query = Milestone.query.filter(Milestone.project_id == project_id)
  if milestone_id is not None:
    return query.filter(Milestone.id == milestone_id).all()
  # not updated_at: editing an older milestone's notes must not change which one a label means
  return query.filter(Milestone.shared == True).order_by(Milestone.created_at.desc()).all()


def find_milestone(project_id: str, reference: str):
  """
  The shared milestone with this label (the latest if there are several), or with this id: `#12`, from its link.
  Keys of milestones from before October 2026 ("project/commit/batch") still work.
  """
  by_id = re.fullmatch(r'#(\d+)', reference)
  if by_id:
    return next(iter(milestones_of(project_id, int(by_id.group(1)))), None)
  milestones = milestones_of(project_id)
  return (next((m for m in milestones if m.label == reference), None)
          or next((m for m in milestones if (m.data or {}).get('legacy_key') == reference), None))


def commit_config(commit) -> dict:
  return (commit.data or {}).get('qatools_config') or (commit.project.data or {}).get('qatools_config') or {}


def default_reference(commit) -> str:
  config = commit_config(commit)
  reference = (config.get('gate') or {}).get('reference') or (config.get('project') or {}).get('reference_branch')
  return str(reference) if reference else 'master'


def resolve_reference(commit, reference: str, label: str):
  """The reference commit (or None), and how we found it"""
  info = {'requested': reference, 'type': 'branch', 'milestone': None}
  milestone = find_milestone(commit.project_id, reference)
  if milestone:
    info.update(type='milestone', milestone=milestone.label or reference, milestone_batch=milestone.batch or 'default', milestone_filter=milestone.filter or '')
    sha = str(milestone.commit_hexsha or '')
    found = find_commit(milestone.commit_project_id or commit.project_id, sha) if re.fullmatch(r'[0-9a-fA-F]{4,64}', sha) else None
    return found, info
  if re.fullmatch(r'[0-9a-fA-F]{7,64}', reference):
    found = find_commit(commit.project_id, reference)
    if found:
      info['type'] = 'commit'
      return found, info
  return find_branch_commit(commit.project_id, reference, label, commit), info


def describe_commit(commit) -> dict:
  return {
    'id': commit.hexsha,
    'branch': re.sub('^origin/', '', commit.branch) if commit.branch else '',
    'message': commit.message,
    'committer_name': commit.committer_name,
    'authored_datetime': commit.authored_datetime.isoformat() if commit.authored_datetime else None,
  }


def read_manifest(output):
  """The output's manifest.outputs.json, None if it is missing or outside the storage"""
  try:
    output_dir = output.output_dir
    if not is_storage_path(output_dir):
      return None
    with (output_dir / 'manifest.outputs.json').open() as f:
      manifest = json.load(f)
    return manifest if isinstance(manifest, dict) else None
  except Exception:
    return None


def compare_bit_accuracy(tests, new_outputs, ref_outputs, config) -> dict:
  """Fills each test's bit_accurate: whether its output files are the same as its reference run's"""
  by_id = {o.id: o for o in [*new_outputs, *ref_outputs]}
  counts = {'checked': 0, 'mismatched': 0, 'unavailable': 0}
  for test in tests:
    if test['reference_id'] is None:
      continue
    manifest_new = read_manifest(by_id[test['id']])
    manifest_ref = read_manifest(by_id[test['reference_id']])
    if manifest_new is None or manifest_ref is None:
      counts['unavailable'] += 1
      continue
    mismatch = manifests_mismatch(manifest_new, manifest_ref, config.get('bit_accuracy'))
    test['bit_accurate'] = not mismatch
    test['bit_accuracy_mismatch'] = mismatch[:20]
    counts['checked'] += 1
    counts['mismatched'] += bool(mismatch)
  return counts


@app.route("/api/v1/commit/<commit_id>/compare", methods=['GET'])
@app.route("/api/v1/commit/<commit_id>/compare/", methods=['GET'])
def compare_commit(commit_id):
  project_id = request.args.get('project')
  if not project_id:
    return jsonify({'error': 'Missing the ?project= parameter'}), 400
  if not is_authorized_user(None, project_id):
    return jsonify({'error': "Forbidden: You don't have permission to access this project"}), 403
  if not re.fullmatch(r'[0-9a-fA-F]{4,64}', commit_id):
    return jsonify({'error': f'Not a commit sha: {commit_id}'}), 400
  commit = find_commit(project_id, commit_id)
  if not commit:
    return jsonify({'error': f'No results for commit {commit_id} in project {project_id}'}), 404

  label = request.args.get('batch') or 'default'
  explicit_ref_label = request.args.get('reference_batch')
  ref_label = explicit_ref_label or label
  reference = request.args.get('reference') or default_reference(commit)
  metrics = [m.strip() for m in request.args['metrics'].split(',') if m.strip()] if request.args.get('metrics') else None

  messages = []
  batch = find_batch(commit, label)
  new_outputs = [o for o in batch.outputs] if batch else []
  if not new_outputs:
    messages.append(f'No runs in the batch "{label}" of this commit.')

  ref_commit, ref_info = resolve_reference(commit, reference, ref_label)
  # warnings that don't make the comparison incomplete
  notes = []
  if ref_info['type'] == 'milestone':
    # a milestone is a batch: unless asked otherwise, we compare with it
    ref_label = explicit_ref_label or ref_info['milestone_batch']
    if ref_info['milestone_filter']:
      notes.append(f'The filter of the milestone "{reference}" ({ref_info["milestone_filter"]}) is not applied: all the runs of its batch are compared.')
  ref_batch = find_batch(ref_commit, ref_label) if ref_commit else None
  ref_outputs = [o for o in ref_batch.outputs] if ref_batch else []
  if not ref_commit:
    if ref_info['type'] == 'milestone':
      messages.append(f'The commit of the milestone "{reference}" has no results.')
    else:
      messages.append(f'No reference: no milestone or commit "{reference}", and no commit on the branch "{reference}" has runs in the batch "{ref_label}".')
  elif not ref_outputs:
    messages.append(f'No runs in the batch "{ref_label}" of the reference.')
  elif not has_results(ref_batch):
    messages.append(f'All the runs failed in the batch "{ref_label}" of the reference.')

  new_dicts = [o.to_dict() for o in new_outputs]
  ref_dicts = [o.to_dict() for o in ref_outputs]
  new_counts = run_counts([o for o in new_dicts if o.get('output_type') != 'optim_iteration'])
  ref_counts = run_counts(ref_dicts)
  if messages:
    status = 'missing'
  elif new_counts['pending'] or ref_counts['pending']:
    status = 'running'
    messages.append('Some runs are still running: the numbers may change.')
  else:
    status = 'complete'
  messages += notes

  # The metrics' definitions, like the web app: the batch's, else the commit's, else the project's
  metrics_definitions = (
    ((batch.data or {}).get('qatools_metrics') if batch else None) or
    (commit.data or {}).get('qatools_metrics') or
    (commit.project.data or {}).get('qatools_metrics') or
    {}
  )
  comparison = compare_outputs(new_dicts, ref_dicts, metrics_definitions.get('available_metrics'), metrics)

  bit_accuracy = None
  if request.args.get('bit_accuracy', '').lower() in ('1', 'true', 'yes'):
    bit_accuracy = compare_bit_accuracy(comparison['tests'], new_outputs, ref_outputs, commit_config(commit))

  return jsonify({
    'project': project_id,
    'status': status,
    'messages': messages,
    'commit': {**describe_commit(commit), 'batch': batch.label if batch else label, 'runs': new_counts},
    'reference': {
      **ref_info,
      **(describe_commit(ref_commit) if ref_commit else {'id': None}),
      'batch': ref_batch.label if ref_batch else ref_label,
      'runs': ref_counts,
    },
    'metrics': comparison['metrics'],
    'tests': comparison['tests'],
    'bit_accuracy': bit_accuracy,
  })
