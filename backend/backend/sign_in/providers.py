"""
The ways to sign in. The environment defines some (read-only in the admin panel):
- `local`: QA-Board accounts with a password, always there (break-glass admins)
- `ldap` or `saml`: from QABOARD_LOGIN_TYPE and their QABOARD_LDAP_*/QABOARD_SAML_* variables
- `sso`: OpenID Connect from QABOARD_OIDC_ISSUER (empty: no SSO)
Admins add more OIDC providers in the admin panel (models AuthProvider).
"""
import os
from dataclasses import dataclass, field
from typing import Optional, List

from ..settings import login_type, env_list


ENV_OIDC_ID = 'sso'
# what users and admins can tell the claims are
DEFAULT_CLAIMS = {"username": "preferred_username", "email": "email", "name": "name", "groups": "groups"}


@dataclass
class Provider:
  id: str
  type: str  # local, ldap, saml, oidc
  name: str
  source: str = 'env'  # env, database
  enabled: bool = True
  position: int = 0
  recommended: bool = False
  config: dict = field(default_factory=dict)
  secret_encrypted: Optional[str] = None

  @property
  def kind(self) -> str:
    """password: the sign-in form; redirect: a button that goes to the provider"""
    return 'password' if self.type in ('local', 'ldap') else 'redirect'

  def claim(self, name: str) -> str:
    return (self.config.get('claims') or {}).get(name) or DEFAULT_CLAIMS[name]

  def client_secret(self) -> Optional[str]:
    if self.config.get('client_secret_env'):
      return os.environ.get(self.config['client_secret_env'])
    if self.secret_encrypted:
      from .crypto import decrypt
      return decrypt(self.secret_encrypted)
    return None

  def start_url(self, next_url: Optional[str] = None) -> str:
    from urllib.parse import urlencode
    query = f"?{urlencode({'next': next_url})}" if next_url else ''
    if self.type == 'saml':
      return '/api/auth/saml20/login/?sso'
    if self.type == 'oidc':
      return f'/api/v1/auth/oidc/{self.id}/start{query}'
    return ''

  def public(self, next_url: Optional[str] = None) -> dict:
    """What the sign-in page needs"""
    return {"id": self.id, "type": self.type, "kind": self.kind, "name": self.name, "recommended": self.recommended,
            "start_url": self.start_url(next_url) or None}

  def describe(self) -> dict:
    """What the admin panel shows: never the secret"""
    config = {k: v for k, v in self.config.items() if k != 'client_secret'}
    return {**self.public(), "source": self.source, "enabled": self.enabled, "position": self.position, "config": config,
            "has_secret": bool(self.config.get('client_secret_env') or self.secret_encrypted)}


def env_oidc() -> Optional[Provider]:
  issuer = os.environ.get('QABOARD_OIDC_ISSUER', '').strip()
  if not issuer:
    return None
  claims = {name: os.environ.get(f'QABOARD_OIDC_{name.upper()}_CLAIM') for name in DEFAULT_CLAIMS}
  return Provider(
    id=ENV_OIDC_ID, type='oidc', name=os.environ.get('QABOARD_OIDC_BUTTON_LABEL') or "Single sign-on", recommended=True, position=-1,
    config={
      "issuer": issuer,
      "client_id": os.environ.get('QABOARD_OIDC_CLIENT_ID', ''),
      "client_secret_env": 'QABOARD_OIDC_CLIENT_SECRET',
      "scopes": env_list(os.environ.get('QABOARD_OIDC_SCOPES', '').replace(' ', ',')) or ['openid', 'profile', 'email'],
      "claims": {k: v for k, v in claims.items() if v},
      # the IdP is federated to the same directory as LDAP: its user names are the same accounts
      "match_users": (os.environ.get('QABOARD_OIDC_MATCH_USERS') or 'none').strip().lower(),
      "redirect_uri": os.environ.get('QABOARD_OIDC_REDIRECT_URI') or None,
      # read users' claims daily with refresh tokens (backend/jobs/groups.py)
      "refresh_groups": os.environ.get('QABOARD_OIDC_REFRESH_GROUPS', '').strip().lower() in ('1', 'true', 'yes') or None,
    },
  )


def env_providers() -> List[Provider]:
  providers = []
  oidc = env_oidc()
  if oidc:
    providers.append(oidc)
  if login_type() == 'LDAP':
    providers.append(Provider(id='ldap', type='ldap', name="Directory account (LDAP)", position=0))
  if login_type() == 'SAML':
    providers.append(Provider(id='saml', type='saml', name="Single sign-on (SAML)", recommended=not oidc, position=0))
  providers.append(Provider(id='local', type='local', name="QA-Board account", position=100))
  return providers


def database_providers() -> List[Provider]:
  from ..models import AuthProvider
  try:
    rows = AuthProvider.query.order_by(AuthProvider.position, AuthProvider.id).all()
  except Exception as e:
    from backend import db_session
    db_session.rollback()
    print(f"[sign-in] WARNING: could not read the providers: {type(e).__name__}")
    return []
  return [Provider(id=r.id, type=r.type, name=r.name or r.id, source='database', enabled=r.enabled, position=r.position,
                   recommended=bool((r.config or {}).get('recommended')), config=r.config or {}, secret_encrypted=r.secret_encrypted)
          for r in rows]


def all_providers() -> List[Provider]:
  env = env_providers()
  taken = {p.id for p in env}
  return sorted(env + [p for p in database_providers() if p.id not in taken], key=lambda p: (p.position, p.id))


def get(provider_id: str) -> Optional[Provider]:
  return next((p for p in all_providers() if p.id == provider_id), None)


def sign_in_options(show_local: bool = False) -> List[Provider]:
  """
  What the sign-in page offers. The password form is for LDAP and local accounts: with SAML or SSO only, it's hidden
  unless show_local (/login?local=1), for break-glass admins.
  """
  providers = [p for p in all_providers() if p.enabled]
  has_ldap = any(p.type == 'ldap' for p in providers)
  has_redirect = any(p.kind == 'redirect' for p in providers)
  show_password_form = has_ldap or show_local or not has_redirect or login_type() == 'LOCAL'
  return [p for p in providers if p.kind == 'redirect' or (show_password_form and (p.type == 'ldap' or (p.type == 'local' and not has_ldap)))]


ID_CHARS = set('abcdefghijklmnopqrstuvwxyz0123456789-_')

def valid_id(provider_id) -> bool:
  return isinstance(provider_id, str) and 0 < len(provider_id) <= 40 and set(provider_id) <= ID_CHARS and provider_id not in ('local', 'ldap', 'saml', ENV_OIDC_ID, 'callback')
