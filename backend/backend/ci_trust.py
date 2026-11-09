"""
CI jobs that act as a service account without a stored secret (docs/design/user-management.md §11.3 and Appendix E).

GitHub Actions and GitLab CI give jobs OIDC ID tokens that say which repository, ref and pipeline they run for.
A service account lists the CI jobs it trusts (`users.data['ci_trust']`): an issuer, the audience the token is for,
and conditions on its claims, e.g. {"repository": ["camera-algo/isp"], "ref": ["refs/heads/main"]}.
`POST /api/v1/auth/token-exchange` (api/ci_trust.py) checks the job's ID token and gives it a short-lived `qab_tmp_`
token of the account: its role, its project restriction, its scopes. Runs then say "ci[bot]", with the token's name
("GitHub Actions: camera-algo/isp@main").

Security:
- Policies must pin the repository (or for other issuers, the subject), and no pattern is only wildcards.
- We only fetch the discovery documents and keys of issuers that some policy names, never the unverified token's `iss`.
- Signatures are checked with the issuer's JWKS, asymmetric algorithms only; then iss, aud, exp, nbf, iat.
"""
import re
import json
import base64
import secrets
import datetime
from fnmatch import fnmatchcase
from typing import Optional, List, Tuple

from .sign_in.oidc import _get_json, _cached, ALGORITHMS, LEEWAY, SignInError


GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'
GITLAB_ISSUER = 'https://gitlab.com'
PROVIDERS = {
  # https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect
  'github': {"client": "GitHub Actions", "repository": "repository", "pins": ('repository', 'repository_id', 'repository_owner_id')},
  # https://docs.gitlab.com/ci/secrets/id_token_authentication/
  'gitlab': {"client": "GitLab CI", "repository": "project_path", "pins": ('project_path', 'project_id')},
  'other': {"client": "CI", "repository": "sub", "pins": ('sub',)},
}
# claims the checks handle themselves
RESERVED_CLAIMS = {'iss', 'aud', 'exp', 'nbf', 'iat', 'jti'}
CLAIM_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_.-]{0,63}$')
MAX_POLICIES = 20
MAX_CONDITIONS = 10
MAX_PATTERNS = 20
MAX_PATTERN_LENGTH = 200
MAX_TOKEN_LENGTH = 16 * 1024
# ID tokens issued longer ago than that aren't accepted, whatever their expiry
MAX_AGE = datetime.timedelta(hours=24)

GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange'
SUBJECT_TOKEN_TYPES = ('urn:ietf:params:oauth:token-type:id_token', 'urn:ietf:params:oauth:token-type:jwt')
ISSUED_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'


class CiTrustError(Exception):
  """A refusal, with the sentence for people, and the OAuth error code for the token exchange"""
  def __init__(self, message: str, status: int = 400, code: str = 'invalid_request', detail: Optional[str] = None):
    super().__init__(message)
    self.message, self.status, self.code = message, status, code
    # for the server's log
    self.detail = detail


def normalize_url(url: str) -> str:
  return url.strip().rstrip('/')


def same_audience(a: str, b: str) -> bool:
  return normalize_url(a).lower() == normalize_url(b).lower()


# ==========================================
# Policies
# ==========================================

def policies_of(user) -> List[dict]:
  return list((user.data or {}).get('ci_trust') or [])


def is_wildcard_only(pattern: str) -> bool:
  return not re.sub(r'[*?\[\]/!.:-]', '', pattern)


def check_pin(claim: str, patterns: List[str]):
  """The patterns of the condition that pins the repository: no way to match every repository"""
  for pattern in patterns:
    if claim.endswith('_id'):
      if not pattern.isdigit():
        raise CiTrustError(f"`{claim}` is a number, without wildcards: {pattern!r} isn't one.")
    elif claim in ('repository', 'project_path'):
      owner = pattern.split('/')[0]
      if '/' not in pattern or not owner or any(c in owner for c in '*?['):
        raise CiTrustError(f"Write the repository as owner/name, e.g. “camera-algo/isp” (or “camera-algo/*” for all its repositories): {pattern!r} could match anyone's.")
    elif pattern[0] in '*?[':
      raise CiTrustError(f"The `{claim}` pattern {pattern!r} could match any job: start it with the text it must begin with.")


def clean_conditions(conditions, provider: str) -> dict:
  if not isinstance(conditions, dict):
    raise CiTrustError("`conditions` maps claims to lists of patterns, e.g. {\"repository\": [\"camera-algo/isp\"]}.")
  if len(conditions) > MAX_CONDITIONS:
    raise CiTrustError(f"At most {MAX_CONDITIONS} conditions.")
  cleaned = {}
  for claim, patterns in conditions.items():
    if not isinstance(claim, str) or not CLAIM_RE.match(claim):
      raise CiTrustError(f"{claim!r} isn't a claim name.")
    if claim in RESERVED_CLAIMS:
      raise CiTrustError(f"`{claim}` is always checked: it can't be a condition.")
    if isinstance(patterns, str):
      patterns = [patterns]
    if not isinstance(patterns, list) or not patterns or len(patterns) > MAX_PATTERNS \
       or not all(isinstance(p, str) and p.strip() and len(p) <= MAX_PATTERN_LENGTH for p in patterns):
      raise CiTrustError(f"The condition on `{claim}` is a list of 1 to {MAX_PATTERNS} patterns, of at most {MAX_PATTERN_LENGTH} characters.")
    patterns = list(dict.fromkeys(p.strip() for p in patterns))
    for pattern in patterns:
      if is_wildcard_only(pattern):
        raise CiTrustError(f"The `{claim}` pattern {pattern!r} matches anything: write what it must match.")
    cleaned[claim] = patterns
  pins = PROVIDERS[provider]['pins']
  pinned = [claim for claim in pins if claim in cleaned]
  if not pinned:
    raise CiTrustError(f"Say which repository's jobs it trusts: a condition on {' or '.join(f'`{c}`' for c in pins)}.")
  for claim in pinned:
    check_pin(claim, cleaned[claim])
  return cleaned


def github_ref(pattern: str) -> str:
  """"main" => "refs/heads/main": GitHub's `ref` claim is the full ref"""
  return pattern if pattern.startswith('refs/') else f"refs/heads/{pattern}"


def make_policy(body: dict, default_audience: str, created_by: Optional[str]) -> dict:
  """
  A new policy from {provider: github|gitlab|other, issuer?, audience?, repository?, ref?, environment?, conditions?}.
  `repository`, `ref` and `environment` are shortcuts for the provider's claims. Raises CiTrustError.
  """
  provider = body.get('provider') or 'github'
  if provider not in PROVIDERS:
    raise CiTrustError(f"`provider` is one of {', '.join(PROVIDERS)}.")
  issuer = body.get('issuer') or {'github': GITHUB_ISSUER, 'gitlab': GITLAB_ISSUER}.get(provider)
  if not isinstance(issuer, str) or not re.match(r'^https://[^\s/?#]+(/[^\s?#]*)?$', issuer.strip()):
    raise CiTrustError("The issuer is the https:// URL of the CI's OpenID Connect provider, e.g. https://gitlab.example.com.")
  issuer = normalize_url(issuer)
  audience = body.get('audience') or default_audience
  if not isinstance(audience, str) or not audience.strip() or len(audience) > 300:
    raise CiTrustError("The audience is a text, by default this server's URL.")
  conditions = body.get('conditions') or {}
  if not isinstance(conditions, dict):
    raise CiTrustError("`conditions` maps claims to lists of patterns, e.g. {\"repository\": [\"camera-algo/isp\"]}.")
  conditions = dict(conditions)
  for field, claim in (('repository', PROVIDERS[provider]['repository']), ('ref', 'ref'), ('environment', 'environment')):
    value = body.get(field)
    if value in (None, '', []):
      continue
    values = [value] if isinstance(value, str) else value
    if not isinstance(values, list) or not all(isinstance(v, str) for v in values):
      raise CiTrustError(f"`{field}` is a text, or a list of texts.")
    values = [v.strip().strip('/') if field == 'repository' else v.strip() for v in values if v.strip()]
    if field == 'ref' and provider == 'github':
      values = [github_ref(v) for v in values]
    if values:
      conditions[claim] = values
  return {
    "id": secrets.token_hex(4),
    "provider": provider,
    "issuer": issuer,
    "audience": audience.strip(),
    "conditions": clean_conditions(conditions, provider),
    "created_by": created_by,
    "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
  }


def known_issuers() -> set:
  """Issuers anyone who manages a service account may trust: GitHub, GitLab.com, and the server's git hosts"""
  from .git_hosts import git_hosts
  issuers = {GITHUB_ISSUER, GITLAB_ISSUER}
  for host in git_hosts:
    url = normalize_url(host.url)
    # GitHub Enterprise Server's issuer
    issuers.update({url, f"{url}/_services/token"})
  return issuers


def add_policy(actor, user, body: dict, default_audience: str) -> dict:
  """Adds the policy to the account (the caller commits), audited"""
  from .audit import audit
  from .service_accounts import project_of
  policies = policies_of(user)
  if len(policies) >= MAX_POLICIES:
    raise CiTrustError(f"A service account trusts at most {MAX_POLICIES} kinds of CI jobs: remove some first.")
  policy = make_policy(body, default_audience, actor.user.user_name if actor.user else None)
  # the server fetches the issuers' keys: only admins send it to other servers
  if policy['issuer'] not in known_issuers() and not actor.is_admin:
    raise CiTrustError(f"QA-Board doesn't know {policy['issuer']} as one of its git hosts: ask a QA-Board admin to add "
                       "these CI jobs, or to add the git host to the server's configuration.", 403)
  if any(p.get('issuer') == policy['issuer'] and p.get('audience') == policy['audience'] and p.get('conditions') == policy['conditions'] for p in policies):
    raise CiTrustError("It already trusts these CI jobs.", 409)
  user.data = {**(user.data or {}), "ci_trust": [*policies, policy]}
  audit('service_account.ci_trust.create', 'user', user.id, user.user_name, project_id=project_of(user), meta={
    "policy": policy["id"], "issuer": policy["issuer"], "audience": policy["audience"], "conditions": policy["conditions"],
  }, actor=actor)
  return policy


def remove_policy(actor, user, policy_id: str) -> bool:
  from .audit import audit
  from .service_accounts import project_of
  policies = policies_of(user)
  removed = [p for p in policies if p.get('id') == policy_id]
  if not removed:
    return False
  user.data = {**(user.data or {}), "ci_trust": [p for p in policies if p.get('id') != policy_id]}
  audit('service_account.ci_trust.delete', 'user', user.id, user.user_name, project_id=project_of(user), meta={
    "policy": policy_id, "issuer": removed[0].get("issuer"), "conditions": removed[0].get("conditions"),
  }, actor=actor)
  return True


def serialize_policy(policy: dict) -> dict:
  return {k: policy.get(k) for k in ('id', 'provider', 'issuer', 'audience', 'conditions', 'created_by', 'created_at', 'last_used_at')}


# ==========================================
# Checking ID tokens
# ==========================================

def _b64json(part: str) -> dict:
  value = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
  if not isinstance(value, dict):
    raise ValueError("not an object")
  return value


def unverified(id_token: str) -> Tuple[dict, dict]:
  """(header, claims), unchecked: only to know which policies may apply"""
  parts = id_token.split('.')
  if len(parts) != 3:
    raise CiTrustError("The subject token isn't a JWT: send the CI job's OIDC ID token.", 400, 'invalid_request')
  try:
    return _b64json(parts[0]), _b64json(parts[1])
  except Exception:
    raise CiTrustError("The subject token can't be read: send the CI job's OIDC ID token.", 400, 'invalid_request')


def metadata(issuer: str) -> dict:
  url = f"{issuer}/.well-known/openid-configuration"
  def fetch():
    document = _get_json(url, "discovery document")
    if not document.get('jwks_uri'):
      raise SignInError('sso_misconfigured', f"The discovery document at {url} has no jwks_uri")
    if normalize_url(str(document.get('issuer') or '')) != issuer:
      raise SignInError('sso_misconfigured', f"The discovery document at {url} is for the issuer {document.get('issuer')!r}")
    return document
  return _cached(('ci_trust.metadata', url), fetch)


def jwks(issuer: str, refresh: bool = False) -> dict:
  url = metadata(issuer)['jwks_uri']
  return _cached(('ci_trust.jwks', url), lambda: _get_json(url, "signing keys (JWKS)"), refresh=refresh)


def verify(id_token: str, issuer: str) -> dict:
  """The claims of an ID token from a trusted issuer, checked: signature, iss, exp, nbf, iat. Not aud: policies say theirs."""
  from joserfc import jwt
  from joserfc.jwk import KeySet
  from joserfc.errors import JoseError, ExpiredTokenError
  refused = lambda detail: CiTrustError("The ID token is invalid: its signature, issuer or dates don't check out.", 401, 'invalid_grant', detail)
  try:
    document = metadata(issuer)
    def decode(refresh=False):
      return jwt.decode(id_token, KeySet.import_key_set(jwks(issuer, refresh=refresh)), algorithms=ALGORITHMS)
    try:
      token = decode()
    except JoseError:
      # the issuer may have rotated its keys
      token = decode(refresh=True)
  except SignInError as e:
    raise CiTrustError(f"QA-Board couldn't get the signing keys of {issuer}: try again later, or ask an admin to check the server's log.", 503, 'temporarily_unavailable', e.detail)
  except (JoseError, ValueError) as e:
    raise refused(f"{type(e).__name__}: {e}")
  claims = token.claims
  registry = jwt.JWTClaimsRegistry(
    leeway=LEEWAY,
    iss={"essential": True, "value": document['issuer']},
    exp={"essential": True},
    iat={"essential": True},
  )
  try:
    registry.validate(claims)
  except JoseError as e:
    if isinstance(e, ExpiredTokenError):
      raise CiTrustError("The ID token expired: request a new one.", 401, 'invalid_grant', str(e))
    raise refused(str(e))
  if not isinstance(claims.get('iat'), (int, float)) or claims['iat'] < (datetime.datetime.now(datetime.timezone.utc) - MAX_AGE).timestamp():
    raise refused("issued more than 24 hours ago")
  return dict(claims)


def claim_values(claims: dict, claim: str) -> List[str]:
  value = claims.get(claim)
  values = value if isinstance(value, list) else [value]
  return [('true' if v else 'false') if isinstance(v, bool) else str(v) for v in values if v is not None]


def conditions_match(conditions: dict, claims: dict) -> bool:
  for claim, patterns in conditions.items():
    values = claim_values(claims, claim)
    if not any(fnmatchcase(value, pattern) for value in values for pattern in patterns):
      return False
  return True


def audiences(claims: dict) -> List[str]:
  aud = claims.get('aud')
  return [a for a in (aud if isinstance(aud, list) else [aud]) if isinstance(a, str)]


def describe_job(provider: str, claims: dict) -> dict:
  """What we save with the token and say in messages: {client, repository, ref, run_id?, job_url?}"""
  info = {"client": PROVIDERS[provider]['client']}
  if provider == 'github':
    info.update(repository=claims.get('repository'), ref=claims.get('ref'), run_id=claims.get('run_id'))
    if claims.get('environment'):
      info['environment'] = claims['environment']
    iss = str(claims.get('iss') or '')
    server = 'https://github.com' if iss == GITHUB_ISSUER else iss.split('/_services/')[0] if '/_services/' in iss else None
    if server and claims.get('repository') and claims.get('run_id'):
      info['job_url'] = f"{server}/{claims['repository']}/actions/runs/{claims['run_id']}"
  elif provider == 'gitlab':
    info.update(repository=claims.get('project_path'), ref=claims.get('ref'), run_id=claims.get('pipeline_id'), job_id=claims.get('job_id'))
    if claims.get('environment'):
      info['environment'] = claims['environment']
    if claims.get('project_path') and claims.get('job_id'):
      info['job_url'] = f"{normalize_url(str(claims.get('iss')))}/{claims['project_path']}/-/jobs/{claims['job_id']}"
  else:
    info.update(repository=claims.get('sub'))
  return {k: (str(v)[:300] if v is not None else None) for k, v in info.items() if v is not None}


def job_label(job: dict) -> str:
  """GitHub Actions: camera-algo/isp@main"""
  ref = job.get('ref') or ''
  for prefix in ('refs/heads/', 'refs/tags/'):
    if ref.startswith(prefix):
      ref = ref[len(prefix):]
  return f"{job['client']}: {job.get('repository') or 'unknown'}{f'@{ref}' if ref else ''}"


def candidates(issuer: str):
  """[(account, policy)] of active service accounts that trust jobs from this issuer"""
  from .models import User
  found = []
  for user in User.query.filter(User.kind == 'service', User.status == 'active').order_by(User.user_name).all():
    for policy in policies_of(user):
      if normalize_url(str(policy.get('issuer') or '')) == issuer:
        found.append((user, policy))
  return found


def is_named(user, hint: str) -> bool:
  hint = hint.strip()
  return hint in (user.user_name, user.full_name, f"{user.full_name}[bot]")


def match(id_token: str, hint: Optional[str] = None):
  """
  The service account a CI job may act as: (account, policy, claims, job). Raises CiTrustError.
  `hint`: the account's name, needed when several trust the job.
  """
  if not isinstance(id_token, str) or not id_token.strip():
    raise CiTrustError("Missing subject_token: send the CI job's OIDC ID token.")
  if len(id_token) > MAX_TOKEN_LENGTH:
    raise CiTrustError("The subject token is too long to be an ID token.")
  header, peek = unverified(id_token.strip())
  if header.get('alg') not in ALGORITHMS:
    raise CiTrustError("The ID token must be signed with an asymmetric algorithm (RS256, ES256...).", 401, 'invalid_grant')
  issuer = normalize_url(str(peek.get('iss') or ''))
  # only issuers some policy trusts are ever fetched
  found = candidates(issuer) if issuer else []
  if not found:
    raise CiTrustError(f"No service account on this server trusts CI jobs from {issuer[:200] or 'an unknown issuer'}: "
                       "its project's owners add the job in the project's Access tab, under Service accounts.", 403, 'invalid_grant')
  # the issuer is a policy's, as configured
  claims = verify(id_token.strip(), normalize_url(found[0][1]['issuer']))
  job = describe_job(found[0][1].get('provider') or 'other', claims)
  by_conditions = [(user, policy) for user, policy in found if conditions_match(policy.get('conditions') or {}, claims)]
  matched = [(user, policy) for user, policy in by_conditions if any(same_audience(a, policy.get('audience') or '') for a in audiences(claims))]
  if not matched:
    if by_conditions:
      expected = sorted({p.get('audience') for _, p in by_conditions})
      raise CiTrustError(f"The ID token is for the audience {', '.join(audiences(claims))[:200] or 'none'}, but the service accounts that trust "
                         f"this job expect {', '.join(expected)}: request the ID token for that audience.", 403, 'invalid_grant')
    described = ', '.join(f"{k} {v}" for k, v in job.items() if k in ('repository', 'ref', 'environment'))
    raise CiTrustError(f"No service account trusts this job ({job['client']}: {described or 'no repository'}): "
                       "check the repository, branch and environment its trusted CI jobs list.", 403, 'invalid_grant')
  accounts = list({user.id: user for user, _ in matched}.values())
  if hint:
    named = [user for user in accounts if is_named(user, hint)]
    if not named:
      raise CiTrustError(f"{hint[:100]} doesn't trust this job. {'These do' if len(accounts) > 1 else 'This one does'}: "
                         f"{', '.join(u.user_name for u in accounts)}.", 403, 'invalid_grant')
    accounts = named
  if len(accounts) > 1:
    raise CiTrustError(f"Several service accounts trust this job: {', '.join(u.user_name for u in accounts)}. "
                       "Choose one with QABOARD_SERVICE_ACCOUNT (service_account in the request).", 400, 'invalid_request')
  account = accounts[0]
  policy = next(policy for user, policy in matched if user.id == account.id)
  return account, policy, claims, describe_job(policy.get('provider') or 'other', claims)


def exchange(id_token: str, hint: Optional[str] = None):
  """Mints the job's token (added to the session: the caller commits): (account, token, secret)"""
  from .settings import setting
  from .actor import Actor
  from . import tokens as tokens_lib
  from . import service_accounts
  account, policy, claims, job = match(id_token, hint)
  project_id = service_accounts.project_of(account)
  minutes = setting('tokens.ci_lifetime_minutes')
  token, secret = tokens_lib.mint(
    account, name=job_label(job)[:100], scopes=list(service_accounts.SCOPES), kind='ci',
    projects=[project_id] if project_id else [],
    expires_at=tokens_lib.utcnow() + datetime.timedelta(minutes=minutes),
    data={**job, "issuer": policy['issuer'], "policy": policy['id']},
    actor=Actor(account), audit_action='token.exchange', audit_meta={**job, "policy": policy['id']},
  )
  now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
  account.data = {**(account.data or {}), "ci_trust": [{**p, "last_used_at": now} if p.get('id') == policy['id'] else p for p in policies_of(account)]}
  return account, token, secret
