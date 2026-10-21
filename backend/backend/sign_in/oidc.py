"""
OpenID Connect, Authorization Code + PKCE, confidential client, handled by the backend (like EMMA): the browser never
sees the IdP's tokens. The handshake (state, nonce, PKCE verifier) waits in the session cookie for 10 minutes.

The ID token is checked with joserfc: signature (the IdP's JWKS, never `alg: none`), issuer, audience, expiry, nonce.
"""
import time
import base64
import hashlib
import secrets
import threading
from typing import Optional
from urllib.parse import urlencode

import requests
from flask import session

from .providers import Provider, ENV_OIDC_ID


TIMEOUT = 10 # seconds, for requests to the IdP
CACHE_SECONDS = 3600
HANDSHAKE_SECONDS = 600
# no symmetric algorithms (they'd use the client secret) and never "none"
ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']
LEEWAY = 60 # seconds of clock skew with the IdP

_cache = {}
_lock = threading.Lock()


class SignInError(Exception):
  """
  Why a sign-in failed: `code` for the sign-in page (sso_unavailable, sso_expired, sso_failed, sso_misconfigured...),
  `detail` for admins (the audit log, the server's log), never shown to users.
  """
  def __init__(self, code: str, detail: str):
    super().__init__(detail)
    self.code = code
    self.detail = detail


def _get_json(url: str, what: str) -> dict:
  try:
    response = requests.get(url, timeout=TIMEOUT)
    response.raise_for_status()
    return response.json()
  except Exception as e:
    raise SignInError('sso_unavailable', f"Could not get the {what} at {url}: {type(e).__name__}: {e}")


def _cached(key, fetch, refresh=False):
  with _lock:
    hit = _cache.get(key)
  if hit and not refresh and time.monotonic() - hit[0] < CACHE_SECONDS:
    return hit[1]
  value = fetch()
  with _lock:
    _cache[key] = (time.monotonic(), value)
  return value


def clear_cache():
  with _lock:
    _cache.clear()


def metadata(provider: Provider) -> dict:
  issuer = provider.config['issuer'].rstrip('/')
  url = f"{issuer}/.well-known/openid-configuration"
  def fetch():
    document = _get_json(url, "discovery document")
    for key in ('issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'):
      if not document.get(key):
        raise SignInError('sso_misconfigured', f"The discovery document at {url} has no {key}")
    return document
  return _cached(('metadata', url), fetch)


def jwks(provider: Provider, refresh=False) -> dict:
  url = metadata(provider)['jwks_uri']
  return _cached(('jwks', url), lambda: _get_json(url, "signing keys (JWKS)"), refresh=refresh)


def pkce_challenge(verifier: str) -> str:
  return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()


def redirect_uri(provider: Provider, public_url: str) -> str:
  if provider.config.get('redirect_uri'):
    return provider.config['redirect_uri']
  # the environment's provider has the short one, the URI admins register with their IdP (website/docs/backend-admin/sign-in.mdx)
  if provider.id == ENV_OIDC_ID:
    return f"{public_url}/api/v1/auth/oidc/callback"
  return f"{public_url}/api/v1/auth/oidc/{provider.id}/callback"


def authorization_url(provider: Provider, callback_url: str, next_url: Optional[str], link: bool = False) -> str:
  """Where to send the browser. Saves the handshake in the session cookie."""
  if not provider.config.get('client_id'):
    raise SignInError('sso_misconfigured', f"The provider {provider.id} has no client id")
  document = metadata(provider)
  state, nonce, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(24), secrets.token_urlsafe(48)
  session['oidc'] = {"provider": provider.id, "state": state, "nonce": nonce, "verifier": verifier, "next": next_url,
                     "link": link, "redirect_uri": callback_url, "created": int(time.time())}
  params = {
    "response_type": "code",
    "client_id": provider.config['client_id'],
    "redirect_uri": callback_url,
    "scope": ' '.join(provider.config.get('scopes') or ['openid', 'profile', 'email']),
    "state": state,
    "nonce": nonce,
    "code_challenge": pkce_challenge(verifier),
    "code_challenge_method": "S256",
  }
  return f"{document['authorization_endpoint']}?{urlencode(params)}"


def handshake(provider_id: Optional[str], state: Optional[str]) -> dict:
  """The handshake the callback continues, checked: the same browser, the same provider, recent"""
  saved = session.pop('oidc', None)
  if not saved or not state or not secrets.compare_digest(str(saved.get('state')), str(state)):
    raise SignInError('sso_expired', "The sign-in's state doesn't match this browser's: an old tab, another browser, or a forged request")
  if provider_id and saved.get('provider') != provider_id:
    raise SignInError('sso_expired', f"The sign-in started with {saved.get('provider')}, not {provider_id}")
  if time.time() - saved.get('created', 0) > HANDSHAKE_SECONDS:
    raise SignInError('sso_expired', "The sign-in took more than 10 minutes")
  return saved


def exchange_code(provider: Provider, code: str, saved: dict) -> dict:
  """The code for tokens, server-to-server. Returns the ID token's claims (and userinfo's, for missing claims)."""
  document = metadata(provider)
  secret = provider.client_secret()
  data = {"grant_type": "authorization_code", "code": code, "redirect_uri": saved['redirect_uri'], "code_verifier": saved['verifier']}
  auth = None
  methods = document.get('token_endpoint_auth_methods_supported') or ['client_secret_basic']
  if secret and 'client_secret_basic' in methods:
    auth = (provider.config['client_id'], secret)
  else:
    data.update(client_id=provider.config['client_id'], **({"client_secret": secret} if secret else {}))
  try:
    response = requests.post(document['token_endpoint'], data=data, auth=auth, timeout=TIMEOUT, headers={"Accept": "application/json"})
  except Exception as e:
    raise SignInError('sso_unavailable', f"Could not reach the token endpoint: {type(e).__name__}: {e}")
  if response.status_code != 200:
    try:
      error = response.json()
      detail = f"{error.get('error')}: {error.get('error_description', '')}"
    except Exception:
      detail = response.text[:300]
    raise SignInError('sso_failed', f"The IdP refused the code ({response.status_code}): {detail}")
  tokens = response.json()
  if not tokens.get('id_token'):
    raise SignInError('sso_misconfigured', "The IdP sent no ID token: is `openid` in the scopes?")
  claims = verify_id_token(provider, tokens['id_token'], saved['nonce'])
  missing = [provider.claim(name) for name in ('username', 'email', 'name') if provider.claim(name) not in claims]
  if missing and tokens.get('access_token') and document.get('userinfo_endpoint'):
    claims = {**userinfo(document['userinfo_endpoint'], tokens['access_token'], claims['sub']), **claims}
  return claims


def verify_id_token(provider: Provider, id_token: str, nonce: str) -> dict:
  from joserfc import jwt
  from joserfc.jwk import KeySet
  from joserfc.errors import JoseError
  document = metadata(provider)
  def decode(refresh=False):
    return jwt.decode(id_token, KeySet.import_key_set(jwks(provider, refresh=refresh)), algorithms=ALGORITHMS)
  try:
    try:
      token = decode()
    except JoseError:
      # the IdP may have rotated its keys
      token = decode(refresh=True)
  except JoseError as e:
    raise SignInError('sso_misconfigured', f"The ID token's signature is invalid: {type(e).__name__}: {e}")
  except ValueError as e:
    raise SignInError('sso_misconfigured', f"The ID token can't be read: {e}")
  claims = token.claims
  registry = jwt.JWTClaimsRegistry(
    leeway=LEEWAY,
    iss={"essential": True, "value": document['issuer']},
    sub={"essential": True},
    exp={"essential": True},
    nonce={"essential": True, "value": nonce},
  )
  try:
    registry.validate(claims)
  except JoseError as e:
    raise SignInError('sso_expired' if 'nonce' in str(e) or 'exp' in str(e) else 'sso_misconfigured', f"The ID token is invalid: {e}")
  audiences = claims.get('aud') if isinstance(claims.get('aud'), list) else [claims.get('aud')]
  client_id = provider.config['client_id']
  if client_id not in audiences:
    raise SignInError('sso_misconfigured', f"The ID token is for {audiences}, not for {client_id}")
  if len(audiences) > 1 and claims.get('azp') not in (None, client_id):
    raise SignInError('sso_misconfigured', f"The ID token was issued to {claims.get('azp')}")
  return dict(claims)


def userinfo(url: str, access_token: str, subject: str) -> dict:
  try:
    response = requests.get(url, headers={"Authorization": f"Bearer {access_token}"}, timeout=TIMEOUT)
    response.raise_for_status()
    info = response.json()
  except Exception as e:
    print(f"[sign-in] WARNING: could not read userinfo: {type(e).__name__}")
    return {}
  # OIDC Core 5.3.2: the sub must be the ID token's
  return info if info.get('sub') == subject else {}
