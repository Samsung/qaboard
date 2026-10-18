"""
What milestones are, without the database: validating what clients send, importing the milestones of older
versions, and what we answer. The API is in api/milestones.py, the model in models/Milestone.py.
"""
import re
import datetime
from typing import Optional, Tuple, Dict, Set, Iterable


MAX_LABEL = 200
MAX_GROUP = 200
MAX_NOTES = 20_000
# What the commit was, when the milestone was saved
COMMIT_INFO_KEYS = ('branch', 'committer_name', 'message')


def _text(value, max_length: int, name: str) -> Tuple[Optional[str], Optional[str]]:
  if value is None:
    return '', None
  if not isinstance(value, str):
    return None, f"`{name}` must be a string"
  value = value.strip()
  if len(value) > max_length:
    return None, f"`{name}` is too long (at most {max_length} characters)"
  return value, None


def normalize_group(group: str) -> str:
  """ " tuning / denoiser/ " => "tuning/denoiser" """
  return '/'.join(part.strip() for part in group.split('/') if part.strip())


def clean_fields(body: dict, partial: bool = False) -> Tuple[dict, Optional[str]]:
  """
  The columns to set from what a client sent, or an error message.
  `partial`: an update, only what's in the body changes. Else a new milestone: it needs a commit.
  """
  if not isinstance(body, dict):
    return {}, "Expected a JSON object"
  fields = {}
  for name, max_length in (('label', MAX_LABEL), ('group', MAX_GROUP), ('notes', MAX_NOTES)):
    if name in body or not partial:
      value, error = _text(body.get(name), max_length, name)
      if error:
        return {}, error
      fields[name] = normalize_group(value) if name == 'group' else value
  if 'shared' in body or not partial:
    fields['shared'] = body.get('shared') in (True, 'true')

  # What results: on updates too, e.g. to point a "best tuning so far" milestone to a better batch
  if 'commit' in body or not partial:
    commit = body.get('commit')
    if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-zA-Z._/-]{1,100}', commit.strip()):
      return {}, "`commit` is required: the commit's id"
    fields['commit_hexsha'] = commit.strip()
  if 'batch' in body or not partial:
    batch, error = _text(body.get('batch') or 'default', 500, 'batch')
    if error:
      return {}, error
    fields['batch'] = batch or 'default'
  if 'filter' in body or not partial:
    filter_, error = _text(body.get('filter'), 2000, 'filter')
    if error:
      return {}, error
    fields['filter'] = filter_
  if 'commit_project' in body or not partial:
    commit_project = body.get('commit_project') or None
    if commit_project is not None and not isinstance(commit_project, str):
      return {}, "`commit_project` must be a string"
    fields['commit_project_id'] = commit_project
  commit_info = {k: body[k] for k in COMMIT_INFO_KEYS if isinstance(body.get(k), str)}
  if commit_info:
    fields['commit_info'] = commit_info
  return fields, None


def to_date(value) -> Optional[datetime.datetime]:
  """Dates of older milestones: ISO strings, as saved by browsers"""
  if not isinstance(value, str) or not value:
    return None
  try:
    date = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
  except ValueError:
    return None
  if date.tzinfo is not None:
    date = date.astimezone(datetime.timezone.utc).replace(tzinfo=None)
  return date


def from_legacy(key: str, milestone: dict, project_id: str) -> Optional[dict]:
  """
  The columns of a milestone saved by older versions: in Project.data['milestones'] (shared ones), or in browsers
  (private ones), under keys like "project/commit/batch". None if it doesn't say what results it is.
  The owner is up to the caller.
  """
  if not isinstance(milestone, dict) or not isinstance(milestone.get('commit'), str) or not milestone['commit']:
    return None
  commit_project = milestone.get('project')
  date = to_date(milestone.get('date'))
  data = {k: milestone[k] for k in ('branch', 'committer_name') if isinstance(milestone.get(k), str)}
  data['legacy_key'] = key
  owners = [o for o in milestone.get('owners') or [] if isinstance(o, dict) and o.get('user_name')]
  if owners:
    data['legacy_owners'] = owners
  return {
    'project_id': project_id,
    'label': str(milestone.get('label') or '')[:MAX_LABEL],
    'group': '',
    'notes': str(milestone.get('notes') or '')[:MAX_NOTES],
    'commit_hexsha': milestone['commit'],
    'commit_project_id': commit_project if isinstance(commit_project, str) and commit_project != project_id else None,
    'batch': str(milestone.get('batch') or 'default'),
    'filter': str(milestone.get('filter') or ''),
    'data': data,
    **({'created_at': date, 'updated_at': date} if date else {}),
  }


def same_results(a: dict, b: dict) -> bool:
  """Whether two milestones (their columns) are the same, to import milestones only once"""
  keys = ('project_id', 'commit_hexsha', 'batch', 'filter', 'label')
  return all((a.get(k) or '') == (b.get(k) or '') for k in keys) and (a.get('commit_project_id') or None) == (b.get('commit_project_id') or None)


def can_edit(owner_id: Optional[int], user_id: Optional[int], data: Optional[dict] = None, user_name: Optional[str] = None) -> bool:
  """
  Owners edit their milestones. Imported milestones without owner can be edited by any logged-in user,
  or, if they had owners we don't know as users yet, by them.
  """
  if not user_id:
    return False
  if owner_id is not None:
    return owner_id == user_id
  legacy_owners = [o.get('user_name') for o in (data or {}).get('legacy_owners', [])]
  return not legacy_owners or user_name in legacy_owners


def can_see(owner_id: Optional[int], shared: bool, user_id: Optional[int]) -> bool:
  """Whether we list it for the user. Their link works for everyone who can see the project."""
  return bool(shared) or owner_id is None or (user_id is not None and owner_id == user_id)


def slugify(label: str) -> str:
  """For links: /<project>/milestone/<id>-<slug>. Only the id matters: renaming a milestone keeps its links."""
  slug = re.sub(r'[^\w]+', '-', label.lower(), flags=re.UNICODE).strip('-')
  return slug[:60].strip('-')


def serialize(milestone, user_id: Optional[int] = None, favorite_ids: Iterable[int] = (), user_name: Optional[str] = None) -> dict:
  data = milestone.data or {}
  owner = milestone.user
  return {
    'id': milestone.id,
    'project': milestone.project_id,
    'label': milestone.label or '',
    'group': milestone.group or '',
    'notes': milestone.notes or '',
    'shared': bool(milestone.shared),
    'commit': milestone.commit_hexsha,
    'commit_project': milestone.commit_project_id,
    'batch': milestone.batch or 'default',
    'filter': milestone.filter or '',
    'branch': data.get('branch'),
    'committer_name': data.get('committer_name'),
    'message': data.get('message'),
    'owner': {'user_name': owner.user_name, 'full_name': owner.full_name} if owner else None,
    'is_mine': user_id is not None and milestone.user_id == user_id,
    'can_edit': can_edit(milestone.user_id, user_id, data, user_name),
    'is_favorite': milestone.id in set(favorite_ids),
    'slug': slugify(milestone.label or ''),
    'created_at': milestone.created_at.isoformat() + 'Z' if milestone.created_at else None,
    'updated_at': milestone.updated_at.isoformat() + 'Z' if milestone.updated_at else None,
  }


def milestone_batches(milestones: Iterable) -> Dict[Tuple[str, str], Set[str]]:
  """(results project, commit) => the labels of its batches that are milestones. The cleanup keeps them."""
  batches: Dict[Tuple[str, str], Set[str]] = {}
  for m in milestones:
    project_id = m.commit_project_id or m.project_id
    batches.setdefault((project_id, m.commit_hexsha), set()).add(m.batch or 'default')
  return batches


def batches_of_commit(batches: Dict[Tuple[str, str], Set[str]], project_id: str, hexsha: str) -> Set[str]:
  """The milestone batches of a commit. Milestones may use a short commit id."""
  labels = set(batches.get((project_id, hexsha), set()))
  for (p, sha), commit_labels in batches.items():
    if p == project_id and sha != hexsha and len(sha) >= 7 and hexsha.startswith(sha):
      labels |= commit_labels
  return labels
