"""
"Mine": the commits users wrote and the batches they started, so that pages can show them first (scope=mine),
and the filters on where batches come from (origin=webapp,local,ci, see backend/origins.py).

- Commits are mine when their author's email is one of mine: my account's (from the sign-in provider) and the git
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


def batch_is_not_mine(identity: Identity):
  """Everyone else's batches: NULL users aren't mine either"""
  from sqlalchemy import func, false, not_
  return not_(func.coalesce(batch_is_mine(identity), false()))


def commit_is_mine(identity: Identity):
  """
  The ids of my commits, as a union of queries that each use an index (an OR of EXISTS and IN would scan the project's
  whole history): commits with batches I started, that I wrote (by email), or by my name before we saved emails.
  """
  from sqlalchemy import select, union, and_, func
  from sqlalchemy.orm import aliased
  from .models import CiCommit, Batch
  # not correlated with the commits we filter
  commits = aliased(CiCommit)
  parts = []
  if identity.user_id is not None:
    parts.append(select(Batch.ci_commit_id).where(Batch.user_id == identity.user_id))
  if identity.user_name:
    parts.append(select(Batch.ci_commit_id).where(Batch.user_id.is_(None), Batch.user_name == identity.user_name))
  if identity.emails:
    parts.append(select(commits.id).where(commits.author_email.in_(sorted(identity.emails))))
  if identity.names:
    parts.append(select(commits.id).where(and_(commits.author_email.is_(None), func.lower(commits.committer_name).in_(sorted(identity.names)))))
  if not parts:
    from sqlalchemy import false
    return false()
  return CiCommit.id.in_(union(*parts).scalar_subquery() if len(parts) > 1 else parts[0].scalar_subquery())


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
# lists of batches also show everyone else's
BATCH_SCOPES = (*SCOPES, 'others')
