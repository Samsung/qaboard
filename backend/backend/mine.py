"""
"Mine": the commits users wrote and the batches they started, so that pages can show them first (scope=mine),
and the filters on where batches come from (origin=webapp,local,ci, see backend/origins.py).

- Commits are mine when their committer's email is one of mine: my account's (from the sign-in provider) and the git
  emails I added in my preferences (`git_emails`). Commits from before we saved emails match my full name.
- Batches are mine when I started them: the verified user, else the user `qa` said it runs as (QA_USER, $USER).
- Commits with a batch of mine are mine too.
"""
from dataclasses import dataclass, field
from typing import FrozenSet, Optional

from .origins import ORIGINS


@dataclass(frozen=True)
class Identity:
  user_id: Optional[int] = None
  user_name: Optional[str] = None
  emails: FrozenSet[str] = field(default_factory=frozenset)
  names: FrozenSet[str] = field(default_factory=frozenset)


def identity_of(user) -> Optional[Identity]:
  if user is None:
    return None
  emails = {str(e).strip().lower() for e in [user.email, *((user.preferences or {}).get('git_emails') or [])] if e and '@' in str(e)}
  names = {user.full_name.strip().lower()} if (user.full_name or '').strip() else set()
  return Identity(user_id=user.id, user_name=user.user_name, emails=frozenset(emails), names=frozenset(names))


def batch_is_mine(identity: Identity):
  from sqlalchemy import or_, and_, false
  from .models import Batch
  conditions = []
  if identity.user_id is not None:
    conditions.append(Batch.user_id == identity.user_id)
  if identity.user_name:
    # unverified runs: who `qa` said it runs as
    conditions.append(and_(Batch.user_id.is_(None), Batch.user_name == identity.user_name))
  return or_(*conditions) if conditions else false()


def commit_is_mine(identity: Identity):
  from sqlalchemy import or_, and_, func
  from .models import CiCommit
  conditions = [CiCommit.batches.any(batch_is_mine(identity))]
  if identity.emails:
    conditions.append(CiCommit.committer_email.in_(sorted(identity.emails)))
  if identity.names:
    conditions.append(and_(CiCommit.committer_email.is_(None), func.lower(CiCommit.committer_name).in_(sorted(identity.names))))
  return or_(*conditions)


def batch_origin_in(origins):
  """Batches from those origins. Those we don't know yet (just created, before the migration) count as the CI's."""
  from sqlalchemy import func
  from .models import Batch
  return func.coalesce(Batch.origin, 'ci').in_(list(origins))


def parse_origins(value) -> Optional[list]:
  """'webapp,local' => ['webapp', 'local'], '' => None (all). Raises ValueError for unknown origins."""
  origins = [o.strip() for o in (value or '').split(',') if o.strip()]
  unknown = [o for o in origins if o not in ORIGINS]
  if unknown:
    raise ValueError(f"Unknown origin {', '.join(unknown)}: use {', '.join(ORIGINS)}")
  return origins or None


SCOPES = ('all', 'mine')
