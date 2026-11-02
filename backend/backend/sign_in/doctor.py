"""
Checks a sign-in provider the way it fails in practice (EMMA's sso:check): the backend can't reach the IdP, the issuer
doesn't match, the redirect URI isn't registered, the LDAP service account doesn't bind. Used by the admin panel's
"Test" button and `qaboard-admin check-sign-in`.
"""
from typing import List, Optional
from urllib.parse import urlencode, urlparse, urlunparse

import requests

from . import oidc
from .oidc import SignInError


def check(name: str, ok: bool, detail: str) -> dict:
  return {"check": name, "ok": ok, "detail": detail}


def check_oidc(provider, callback_url: str) -> List[dict]:
  results = []
  oidc.clear_cache()
  try:
    document = oidc.metadata(provider)
    results.append(check("discovery", True, f"The server reaches {provider.config['issuer'].rstrip('/')}/.well-known/openid-configuration"))
  except SignInError as e:
    results.append(check("discovery", False, f"{e.detail}. The server needs to reach the IdP: check its proxy settings and CA certificates."))
    return results
  issuer = provider.config['issuer']
  same = document['issuer'] == issuer or document['issuer'] == issuer.rstrip('/')
  results.append(check("issuer", same, f"The discovery document's issuer is {document['issuer']}" + ("" if same else f", not {issuer}: ID tokens would be refused. Set the issuer to exactly {document['issuer']}")))
  try:
    keys = oidc.jwks(provider).get('keys') or []
    results.append(check("signing keys", bool(keys), f"{len(keys)} signing key{'s' if len(keys) != 1 else ''}"))
  except SignInError as e:
    results.append(check("signing keys", False, e.detail))
  results.append(check("client id", bool(provider.config.get('client_id')), "set" if provider.config.get('client_id') else "missing"))
  results.append(check("client secret", bool(provider.client_secret()), "set" if provider.client_secret() else f"missing: set ${provider.config.get('client_secret_env') or 'the secret'}"))
  accepted = redirect_uri_accepted(document['authorization_endpoint'], provider.config.get('client_id', ''), callback_url)
  if accepted is None:
    results.append(check("redirect URI", True, f"Couldn't tell whether the IdP accepts {callback_url}: try signing in"))
  elif accepted:
    results.append(check("redirect URI", True, f"The IdP accepts {callback_url}"))
  else:
    near = [uri for uri in near_misses(callback_url) if redirect_uri_accepted(document['authorization_endpoint'], provider.config.get('client_id', ''), uri)]
    hint = f" It accepts {', '.join(near)}: register {callback_url}, or set the provider's redirect URI." if near else " Ask the IdP's admins to register it."
    results.append(check("redirect URI", False, f"The IdP refuses {callback_url}.{hint}"))
  return results


def redirect_uri_accepted(authorization_endpoint: str, client_id: str, uri: str) -> Optional[bool]:
  """
  Registered redirect URIs aren't published: we start a sign-in server-side and read the answer. A sign-in page means
  accepted, an error about redirect_uri means refused. Nobody signs in, nothing is created.
  """
  params = {"response_type": "code", "client_id": client_id, "redirect_uri": uri, "scope": "openid", "state": "qaboard-check"}
  try:
    response = requests.get(f"{authorization_endpoint}?{urlencode(params)}", timeout=oidc.TIMEOUT, allow_redirects=False)
  except Exception:
    return None
  text = response.text.lower() if response.status_code < 500 else ''
  if 'redirect_uri' in text and ('invalid' in text or 'error' in text):
    return False
  if response.status_code in (400, 401, 403):
    return False
  location = response.headers.get('Location', '')
  if response.status_code in (301, 302, 303, 307) and 'error=' in location and location.startswith(uri) is False:
    return False
  return response.status_code < 400


def near_misses(uri: str) -> List[str]:
  parsed = urlparse(uri)
  candidates = {
    urlunparse(parsed._replace(scheme='http' if parsed.scheme == 'https' else 'https')),
    uri.rstrip('/') if uri.endswith('/') else uri + '/',
  }
  candidates.discard(uri)
  return sorted(candidates)


def check_ldap(user_name: Optional[str] = None) -> List[dict]:
  from ..api.auth import ldap_connection, ldap_lookup
  results = []
  try:
    ldap_connection().unbind_s()
    results.append(check("service account", True, "The LDAP service account (QABOARD_LDAP_BIND_DN) binds"))
  except Exception as e:
    results.append(check("service account", False, f"The LDAP service account doesn't bind: {type(e).__name__}: {e}"))
    return results
  if user_name:
    try:
      info = ldap_lookup(user_name)
      results.append(check("user lookup", bool(info), f"Found {user_name}: {info.get('full_name')}, {info.get('email')}" if info else f"No {user_name} with QABOARD_LDAP_USER_FILTER"))
    except Exception as e:
      results.append(check("user lookup", False, f"{type(e).__name__}: {e}"))
  return results
