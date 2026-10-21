"""
Updates users' groups, daily (the worker schedules it), and after admins change groups' rules:
1. LDAP: what the directory says of each LDAP account now (users.data: memberOf...), with one connection.
   If it doesn't find too many accounts (a wrong base, a partial outage), nothing changes.
   Accounts it doesn't know anymore lose their directory attributes, and the groups they gave.
2. OIDC providers with `refresh_groups`: each identity's claims, read again with its refresh token. When the IdP
   refuses the token (the user was disabled, or revoked QA-Board), the identity's claims are forgotten, and the
   user's sessions from that provider end: signing in again gives the groups back.
3. Every user's rule memberships, from what we know now (backend/access/groups.py).
"""
from ..database import db_session
from ..models import User, UserIdentity, Group, GroupRule
from ..tokens import utcnow
from . import params as p
from .report import Reporter


PARAMS = ()
# quick: it runs in the worker's interactive lane, it doesn't wait for long maintenance jobs
INTERACTIVE = True
# LDAP doesn't find more than this share of the accounts: something is wrong, we change nothing
MAX_MISSING_SHARE = 0.2
MAX_MISSING_ALWAYS_OK = 3
COMMIT_EVERY = 200
CHANGES_LOGGED = 50


def validate(params: dict) -> dict:
  p.known_keys(params, PARAMS)
  return {}


def describe(params: dict) -> str:
  return "Update users' groups from LDAP and single sign-on"


def sync_ldap(report: Reporter) -> None:
  from ..api.auth import login_type, ldap_lookups
  if login_type != 'LDAP':
    return
  users = User.query.filter(User.login_type == 'LDAP', User.status != 'disabled').order_by(User.id).all()
  if not users:
    return
  report.log(f"Looking up {len(users)} accounts in LDAP")
  found = {}
  for user_name, info in ldap_lookups([u.user_name for u in users]):
    if report.should_stop():
      return
    found[user_name] = info
  missing = [u for u in users if found.get(u.user_name) is None]
  if len(missing) > max(MAX_MISSING_ALWAYS_OK, MAX_MISSING_SHARE * len(users)):
    names = ', '.join(u.user_name for u in missing[:10])
    report.error_message(f"LDAP didn't find {len(missing)} of {len(users)} accounts (e.g. {names}): is QABOARD_LDAP_USER_BASE right? Their groups are unchanged.")
    return
  for user in users:
    info = found.get(user.user_name)
    if info is None:
      report.log(f"LDAP doesn't know {user.user_name} anymore: their directory groups end", level='warning')
      user.data = []
      continue
    user.data = info['data']
    if info.get('full_name'):
      user.full_name = info['full_name']
    if info.get('email'):
      user.email = info['email']
  report.add(ldap_accounts=len(users) - len(missing), ldap_unknown=len(missing))
  db_session.commit()


def sync_oidc(report: Reporter) -> None:
  from ..sign_in import providers as providers_lib, oidc, sessions
  from ..sign_in.identities import store_refresh_token, DROPPED_CLAIMS
  from ..sign_in.crypto import can_encrypt, decrypt
  providers = [provider for provider in providers_lib.all_providers() if provider.type == 'oidc' and provider.enabled and provider.config.get('refresh_groups')]
  if not providers:
    return
  if not can_encrypt():
    report.error_message("Single sign-on providers refresh groups, but $QABOARD_ENCRYPTION_KEY isn't set: there are no refresh tokens to use")
    return
  for provider in providers:
    identities = (UserIdentity.query.filter(UserIdentity.provider_id == provider.id, UserIdentity.refresh_token_encrypted.isnot(None))
                  .order_by(UserIdentity.id).all())
    report.log(f"Refreshing the claims of {len(identities)} {provider.name} accounts")
    for identity in identities:
      if report.should_stop():
        return
      try:
        claims, refresh_token = oidc.refresh_claims(provider, identity.subject, decrypt(identity.refresh_token_encrypted))
      except oidc.RefreshRefused as e:
        report.log(f"{provider.name} refused the refresh token of {identity.user.user_name} ({e}): their groups from it end, and their sessions from it", level='warning')
        report.add(sso_refused=1)
        identity.claims = {}
        store_refresh_token(identity, None)
        sessions.revoke_provider(identity.user_id, provider.id)
        db_session.commit()
        continue
      except Exception as e:
        # the IdP is down, or misconfigured: nothing changes, we try again next time
        report.error_message(f"Could not refresh the claims of {identity.user.user_name} with {provider.name}: {e}")
        db_session.rollback()
        continue
      report.add(sso_refreshed=1)
      identity.claims = {k: v for k, v in claims.items() if k not in DROPPED_CLAIMS}
      identity.claims_refreshed_at = utcnow()
      store_refresh_token(identity, refresh_token)
      db_session.commit()


def sync_memberships(report: Reporter) -> list:
  from ..access.groups import sync
  rules = GroupRule.query.all()
  names = {g.id: g.name for g in Group.query.all()}
  changes = []
  users = User.query.filter(User.status != 'disabled').order_by(User.id).all()
  for i, user in enumerate(users):
    if report.should_stop():
      break
    synced = sync(user, rules=rules, names=names)
    if synced.added or synced.removed:
      changes.append({"user": user.user_name, **({"added": synced.added} if synced.added else {}), **({"removed": synced.removed} if synced.removed else {})})
      if len(changes) <= CHANGES_LOGGED:
        said = [f"joins {', '.join(synced.added)}"] if synced.added else []
        said += [f"leaves {', '.join(synced.removed)}"] if synced.removed else []
        report.log(f"{user.user_name} {' and '.join(said)}")
    if i % COMMIT_EVERY == COMMIT_EVERY - 1:
      db_session.commit()
  db_session.commit()
  report.set(users=len(users), users_changed=len(changes))
  return changes


def run(params: dict, report: Reporter):
  from ..audit import audit
  sync_ldap(report)
  sync_oidc(report)
  if report.should_stop():
    return
  changes = sync_memberships(report)
  report.log(f"{len(changes)} users changed groups")
  if changes:
    audit('groups.sync', 'group', None, None, meta={"users_changed": len(changes), "changes": changes[:CHANGES_LOGGED]})
    db_session.commit()
