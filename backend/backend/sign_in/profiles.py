"""
What sign-in methods say about users besides who they are: their title, department, organization and picture.
Refreshed at each sign-in (OIDC, LDAP, SAML), and by the daily *Users' groups* job (LDAP lookups: everything;
OIDC refresh tokens: the text fields). Which claim or attribute holds what is configurable per sign-in method
(website/docs/backend-admin/sign-in.mdx):
- OIDC: the provider's claims (`picture`, `title`, `department`, `organization`), and `picture_url`, a photo URL read
  with the user's access token (Microsoft Entra ID: https://graph.microsoft.com/v1.0/me/photo/$value).
- LDAP: QABOARD_LDAP_ATTRIBUTE_PICTURE (thumbnailPhoto,jpegPhoto), _TITLE, _DEPARTMENT, _ORGANIZATION.
- SAML: QABOARD_SAML_ATTRIBUTE_PICTURE, _TITLE, _DEPARTMENT, _ORGANIZATION.

Pictures are downloaded (or decoded) and served by QA-Board itself (/api/v1/users/<id>/picture): browsers don't need
to reach the IdP or carry its tokens, and LDAP's are bytes anyway. Only JPEG, PNG, GIF and WebP, at most 1 MB.
A sign-in never fails because of its profile or picture: problems are logged.
"""
import base64
import binascii
import datetime
import hashlib
from typing import Optional, Tuple
from urllib.parse import urlparse

import requests

from ..tokens import utcnow, iso


FIELDS = ('title', 'department', 'organization')
MAX_PICTURE_BYTES = 1_000_000
DOWNLOAD_TIMEOUT = 5 # seconds
# pictures from an URL are downloaded again at the next sign-in after this, even if the URL is the same
REFRESH_AFTER = datetime.timedelta(days=1)


def sniff(data: bytes) -> Optional[str]:
  """The image's type, from its first bytes. None for anything else, SVG included (it can run scripts)."""
  if data.startswith(b'\xff\xd8\xff'):
    return 'image/jpeg'
  if data.startswith(b'\x89PNG\r\n\x1a\n'):
    return 'image/png'
  if data.startswith((b'GIF87a', b'GIF89a')):
    return 'image/gif'
  if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
    return 'image/webp'
  return None


def text(value) -> Optional[str]:
  """A claim or attribute as one text: the first of a list, the names of a dict (Keycloak's `organization` claim)"""
  if isinstance(value, bytes):
    try:
      value = value.decode('utf-8')
    except UnicodeDecodeError:
      return None
  if isinstance(value, dict):
    value = list(value.keys())
  if isinstance(value, list):
    values = [t for t in (text(v) for v in value) if t]
    return ', '.join(values) if values else None
  if isinstance(value, (int, float)) and not isinstance(value, bool):
    value = str(value)
  if isinstance(value, str) and value.strip():
    return value.strip()[:200]
  return None


def first_value(attributes: dict, names) -> Tuple[Optional[str], object]:
  """(name, value) of the first of `names` the attributes have, matched without case (LDAP's names aren't)"""
  by_lower = {k.lower(): k for k in attributes}
  for name in names:
    key = by_lower.get(name.lower())
    if key is None:
      continue
    value = attributes[key]
    if isinstance(value, list):
      value = value[0] if value else None
    if value not in (None, b'', ''):
      return key, value
  return None, None


def picture_from(value) -> Tuple[Optional[bytes], Optional[str]]:
  """(image bytes, or the URL to download it from), from a claim or attribute: bytes, an URL, a data: URI, base64"""
  if isinstance(value, list):
    value = value[0] if value else None
  if isinstance(value, bytes):
    return value, None
  if not isinstance(value, str) or not value.strip():
    return None, None
  value = value.strip()
  if value.startswith(('https://', 'http://')):
    return None, value
  if value.startswith('data:'):
    header, _, payload = value.partition(',')
    if ';base64' not in header:
      return None, None
    value = payload
  try:
    return base64.b64decode(value, validate=False), None
  except (binascii.Error, ValueError):
    return None, None


def download(url: str, access_token: Optional[str] = None) -> Optional[bytes]:
  if urlparse(url).scheme not in ('http', 'https'):
    return None
  headers = {"Accept": "image/*"}
  if access_token:
    headers["Authorization"] = f"Bearer {access_token}"
  try:
    with requests.get(url, headers=headers, timeout=DOWNLOAD_TIMEOUT, stream=True) as response:
      if response.status_code != 200:
        # e.g. Microsoft Graph answers 404 for users without a photo
        if response.status_code != 404:
          print(f"[profiles] WARNING: could not download a picture from {url}: HTTP {response.status_code}")
        return None
      data = b''
      for chunk in response.iter_content(64 * 1024):
        data += chunk
        if len(data) > MAX_PICTURE_BYTES:
          print(f"[profiles] WARNING: the picture at {url} is over {MAX_PICTURE_BYTES // 1000} kB")
          return None
      return data
  except Exception as e:
    print(f"[profiles] WARNING: could not download a picture from {url}: {type(e).__name__}")
    return None


def update(user, values: dict, source: str) -> bool:
  """
  Saves the profile's fields that the source gives (None: it doesn't say, the field stays). Doesn't commit.
  Returns whether something changed.
  """
  profile = dict(user.profile or {})
  changed = False
  for key in FIELDS:
    value = text(values.get(key))
    if value is not None and profile.get(key) != value:
      profile[key] = value
      changed = True
  if changed:
    profile['source'] = source
    profile['updated_at'] = iso(utcnow())
    user.profile = profile
  return changed


def save_picture(user, data: Optional[bytes], source: str, source_url: Optional[str] = None) -> bool:
  """Saves the user's picture, if it's an image we serve. Doesn't commit. Returns whether it's saved."""
  from backend import db_session
  from ..models import UserPicture
  if not data:
    return False
  if len(data) > MAX_PICTURE_BYTES:
    print(f"[profiles] WARNING: the picture of {user.user_name} from {source} is over {MAX_PICTURE_BYTES // 1000} kB")
    return False
  content_type = sniff(data)
  if content_type is None:
    print(f"[profiles] WARNING: the picture of {user.user_name} from {source} isn't a JPEG, PNG, GIF or WebP image")
    return False
  sha256 = hashlib.sha256(data).hexdigest()
  row = db_session.get(UserPicture, user.id) if user.id is not None else None
  now = utcnow()
  if row is not None and row.sha256 == sha256 and row.source == source and source_url is None and row.source_url is None:
    # e.g. LDAP's daily lookups: the same picture
    return True
  if row is None:
    if user.id is None:
      db_session.flush()
    row = UserPicture(user_id=user.id)
    db_session.add(row)
  if row.sha256 != sha256:
    row.data, row.content_type, row.sha256 = data, content_type, sha256
  row.source, row.source_url, row.updated_at = source, source_url, now
  picture = {"sha256": sha256, "source": source, "updated_at": iso(now)}
  if (user.profile or {}).get('picture', {}).get('sha256') != sha256 or (user.profile or {}).get('picture', {}).get('source') != source:
    user.profile = {**(user.profile or {}), "picture": picture}
  return True


def refresh_picture(user, source: str, value=None, url: Optional[str] = None, access_token: Optional[str] = None) -> bool:
  """
  The picture from a claim's or attribute's `value`, else from `url`. URLs are downloaded at most once a day for the
  same URL. Never raises. Doesn't commit.
  """
  try:
    data, value_url = picture_from(value) if value is not None else (None, None)
    url = value_url or url
    if data is None and url:
      from ..models import UserPicture
      from backend import db_session
      row = db_session.get(UserPicture, user.id) if user.id is not None else None
      if row is not None and row.source == source and row.source_url == url and utcnow() - row.updated_at < REFRESH_AFTER:
        return False
      data = download(url, access_token)
    return save_picture(user, data, source, source_url=url)
  except Exception as e:
    print(f"[profiles] WARNING: could not update the picture of {getattr(user, 'user_name', None)}: {type(e).__name__}: {e}")
    return False


def apply(user, values: Optional[dict], picture=None, source: str = 'ldap'):
  """What a directory (LDAP, SAML) said: the fields, and a picture's bytes/URL/base64. Never raises. Doesn't commit."""
  try:
    if values:
      update(user, values, source)
    if picture is not None:
      refresh_picture(user, source, value=picture)
  except Exception as e:
    print(f"[profiles] WARNING: could not update the profile of {getattr(user, 'user_name', None)}: {type(e).__name__}: {e}")


def same_host(url: str, *others: Optional[str]) -> bool:
  host = urlparse(url).hostname
  return bool(host) and any(other and urlparse(other).hostname == host for other in others)


def from_oidc(user, provider, claims: dict, access_token: Optional[str] = None, document: Optional[dict] = None, pictures: bool = True):
  """
  What an OIDC sign-in (or the daily refresh, `pictures=False`) says: the fields, and the picture from the
  provider's `picture_url` (read with the access token) or its picture claim. The access token is only sent to the
  IdP's own hosts (issuer, userinfo, picture_url): Entra ID's userinfo says `picture` is a Microsoft Graph URL.
  Never raises. Doesn't commit.
  """
  from ..access.groups import lookup
  try:
    update(user, {key: lookup(claims, provider.claim(key)) for key in FIELDS}, provider.id)
    if not pictures:
      return
    picture_url = provider.config.get('picture_url')
    if picture_url:
      refresh_picture(user, provider.id, url=picture_url, access_token=access_token)
      return
    value = lookup(claims, provider.claim('picture'))
    if value is None:
      return
    data, url = picture_from(value)
    token = None
    if url and access_token and same_host(url, provider.config.get('issuer'), (document or {}).get('userinfo_endpoint')):
      token = access_token
    refresh_picture(user, provider.id, value=data, url=url, access_token=token)
  except Exception as e:
    print(f"[profiles] WARNING: could not update the profile of {getattr(user, 'user_name', None)} from {provider.id}: {type(e).__name__}: {e}")


def avatar_url(user) -> Optional[str]:
  """Where the web app gets the user's picture, None if we have none. `v` changes with the picture: cached for long."""
  picture = (getattr(user, 'profile', None) or {}).get('picture') if user is not None else None
  if not picture or not picture.get('sha256'):
    return None
  return f"/api/v1/users/{user.id}/picture?v={picture['sha256'][:12]}"


def public(user) -> dict:
  """The profile the user and admins see"""
  from . import providers as providers_lib
  profile = dict(getattr(user, 'profile', None) or {})
  names = {}
  def name_of(provider_id):
    if provider_id and provider_id not in names:
      provider = providers_lib.get(provider_id)
      names[provider_id] = provider.name if provider else provider_id
    return names.get(provider_id)
  found = {key: profile[key] for key in FIELDS if profile.get(key)}
  if found:
    found['source'] = name_of(profile.get('source'))
    found['updated_at'] = profile.get('updated_at')
  picture = profile.get('picture') or {}
  if picture:
    found['picture_source'] = name_of(picture.get('source'))
    found['picture_updated_at'] = picture.get('updated_at')
  return found
