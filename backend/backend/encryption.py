"""
Encrypts the secrets QA-Board stores in its database: secret settings (Jenkins and git tokens, the SMTP password...),
the client secrets of sign-in providers, and users' refresh tokens.

The key is never stored in the database: a dump, a backup or a staging copy of it would hold both the secrets and
what decrypts them. It comes from, in this order:
  1. $QABOARD_ENCRYPTION_KEY: any long random text, e.g. `openssl rand -base64 32`. Recommended with several hosts.
  2. $QABOARD_ENCRYPTION_KEY_FILE: a file holding it, e.g. a Docker or Kubernetes secret mounted as a file.
  3. $QABOARD_DATA_DIR/encryption_key: generated the first time a secret is stored, readable only by the server.
     Like the generated SECRET_KEY, all the replicas must share the data folder. Back it up apart from the database.

Stored values look like "qb1:<key id>:<Fernet token>". The key id is a fingerprint of the key: it says which key
encrypted a value without revealing anything about the key, so that we can tell admins which secrets a lost key
made unreadable. Values from older versions are bare Fernet tokens: we try every key on them.

Changing the key: set the new one in $QABOARD_ENCRYPTION_KEY and the old one in $QABOARD_ENCRYPTION_KEY_PREVIOUS,
run `qaboard-admin encryption rotate`, then remove the old one. The generated key, if there is one, always decrypts
too: moving it to $QABOARD_ENCRYPTION_KEY, or setting another key, needs no other step before `rotate`.

A generated key is never used to encrypt while the database holds secrets this server can't decrypt: that's what
happens when a replica doesn't share the data folder and generated its own key, and its secrets would be unreadable
by the others. Admins then set $QABOARD_ENCRYPTION_KEY everywhere, or clear the secrets that were lost.
"""
import os
import time
import base64
import hashlib
import secrets as secrets_lib
import threading
from pathlib import Path
from typing import NamedTuple, Optional, Iterator, Callable


PREFIX = 'qb1'
KEY_FILE_NAME = 'encryption_key'
# under this, admins chose a short passphrase: it's hashed once, guessing it is cheap
MIN_KEY_LENGTH = 32


class NoEncryptionKey(Exception):
  pass


class UnknownKey(Exception):
  """The value was encrypted with a key this server doesn't have"""
  def __init__(self, key_id: Optional[str]):
    self.key_id = key_id
    super().__init__(
      f"It was encrypted with another key ({key_id}) than this server's: restore that key, or enter the secret again."
      if key_id else "None of this server's keys decrypts it: restore the key it was encrypted with, or enter the secret again."
    )


class KeyMismatch(Exception):
  pass


class Key(NamedTuple):
  id: str
  # where it comes from: env, file, generated, previous
  source: str
  # the variable or the file
  origin: str
  material: bytes

  def fernet(self):
    from cryptography.fernet import Fernet
    return Fernet(self.material)


def derive(text: str) -> Key:
  # Any text works: we derive a Fernet key from it, as older versions did, so that their values still decrypt
  material = base64.urlsafe_b64encode(hashlib.sha256(text.encode()).digest())
  key_id = hashlib.sha256(b'qaboard encryption key id\0' + material).hexdigest()[:12]
  return Key(key_id, '', '', material)


def _with(key: Key, source: str, origin: str) -> Key:
  return key._replace(source=source, origin=origin)


def key_file() -> Path:
  from .config import qaboard_data_dir
  return Path(qaboard_data_dir) / KEY_FILE_NAME


def _read(path: Path) -> str:
  return path.read_text().strip()


def configured_key() -> Optional[Key]:
  """The key admins configured: $QABOARD_ENCRYPTION_KEY, else $QABOARD_ENCRYPTION_KEY_FILE"""
  text = os.environ.get('QABOARD_ENCRYPTION_KEY', '').strip()
  if text:
    return _with(derive(text), 'env', 'QABOARD_ENCRYPTION_KEY')
  path = os.environ.get('QABOARD_ENCRYPTION_KEY_FILE', '').strip()
  if path:
    try:
      text = _read(Path(path))
    except OSError as e:
      raise NoEncryptionKey(f"Can't read $QABOARD_ENCRYPTION_KEY_FILE ({path}): {e.strerror or e}")
    if not text:
      raise NoEncryptionKey(f"$QABOARD_ENCRYPTION_KEY_FILE ({path}) is empty")
    return _with(derive(text), 'file', path)
  return None


def generated_key() -> Optional[Key]:
  path = key_file()
  try:
    text = _read(path)
  except OSError:
    return None
  return _with(derive(text), 'generated', str(path)) if text else None


def generate_key() -> Key:
  """Creates the key file if there's none (several workers may race: the first one wins)"""
  path = key_file()
  try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
      f.write(secrets_lib.token_urlsafe(32) + '\n')
    print(f"[encryption] Generated an encryption key in {path}. Back it up: the secrets stored in the database can't be decrypted without it.")
  except FileExistsError:
    pass
  except OSError as e:
    raise NoEncryptionKey(f"Set $QABOARD_ENCRYPTION_KEY: the server couldn't generate a key in {path} ({e.strerror or e})")
  for _ in range(50): # another worker may be writing it
    key = generated_key()
    if key:
      return key
    time.sleep(0.1)
  raise NoEncryptionKey(f"{path} is empty: delete it, or set $QABOARD_ENCRYPTION_KEY")


def current_key() -> Optional[Key]:
  """The key we encrypt with, if there's one already"""
  return configured_key() or generated_key()


def keys() -> list:
  """All the keys that decrypt: the current one first, then the previous ones"""
  found = []
  try:
    configured = configured_key()
  except NoEncryptionKey:
    configured = None
  if configured:
    found.append(configured)
  previous = os.environ.get('QABOARD_ENCRYPTION_KEY_PREVIOUS', '').strip()
  if previous:
    found.append(_with(derive(previous), 'previous', 'QABOARD_ENCRYPTION_KEY_PREVIOUS'))
  generated = generated_key()
  if generated:
    found.append(generated)
  unique = []
  for key in found:
    if all(k.id != key.id for k in unique):
      unique.append(key)
  return unique


def can_encrypt() -> bool:
  """Whether secrets can be stored: there's a key, or we can generate one"""
  try:
    if current_key():
      return True
  except NoEncryptionKey:
    return False
  return os.access(key_file().parent, os.W_OK)


def key_id_of(value: Optional[str]) -> Optional[str]:
  """The id of the key that encrypted a value, None for older values (bare Fernet tokens)"""
  if isinstance(value, str) and value.startswith(f'{PREFIX}:'):
    parts = value.split(':', 2)
    return parts[1] if len(parts) == 3 else None
  return None


def is_encrypted(value) -> bool:
  return isinstance(value, str) and (value.startswith(f'{PREFIX}:') or value.startswith('gAAAA'))


def decrypt(value: str) -> str:
  from cryptography.fernet import InvalidToken
  available = keys()
  if value.startswith(f'{PREFIX}:'):
    _, key_id, token = value.split(':', 2)
    key = next((k for k in available if k.id == key_id), None)
    if key is None:
      raise UnknownKey(key_id)
    try:
      return key.fernet().decrypt(token.encode()).decode()
    except InvalidToken:
      raise UnknownKey(key_id)
  for key in available:
    try:
      return key.fernet().decrypt(value.encode()).decode()
    except InvalidToken:
      continue
  raise UnknownKey(None)


def can_decrypt(value: str) -> bool:
  try:
    decrypt(value)
    return True
  except UnknownKey:
    return False


_checked = {"key_id": None, "at": 0.0}
_lock = threading.Lock()
CHECK_SECONDS = 60


def _check_generated_key(key: Key):
  """A generated key only encrypts if this server can decrypt every secret stored so far (see the module's doc)"""
  with _lock:
    if _checked["key_id"] == key.id and time.monotonic() - _checked["at"] < CHECK_SECONDS:
      return
  unreadable = [s for s in stored_secrets() if not can_decrypt(s.value)]
  if unreadable:
    others = sorted({key_id_of(s.value) or 'unknown' for s in unreadable})
    raise KeyMismatch(
      f"This server generated its own encryption key ({key.id}), but {len(unreadable)} secret{'s' if len(unreadable) > 1 else ''} "
      f"in the database {'were' if len(unreadable) > 1 else 'was'} encrypted with another one ({', '.join(others)}): "
      "probably another replica's, that doesn't share this one's data folder. Set the same $QABOARD_ENCRYPTION_KEY on every replica "
      f"(it can be the content of {key_file()} on the replica that has the right one), or, if that key is lost, clear those secrets first (Admin → Settings)."
    )
  with _lock:
    _checked.update(key_id=key.id, at=time.monotonic())


def encrypt(secret: str) -> str:
  key = current_key() or generate_key()
  if key.source == 'generated':
    _check_generated_key(key)
  return f"{PREFIX}:{key.id}:{key.fernet().encrypt(secret.encode()).decode()}"


# What's encrypted in the database
class StoredSecret(NamedTuple):
  # settings, sign_in_provider, refresh_token
  kind: str
  # for admins: the setting's key and field, the provider's id...
  label: str
  value: str
  # replaces the value, in the current database session
  replace: Callable[[str], None]


def stored_secrets() -> Iterator[StoredSecret]:
  from . import settings as settings_lib
  yield from settings_lib.stored_secrets()
  from .models import AuthProvider, UserIdentity
  for provider in AuthProvider.query.filter(AuthProvider.secret_encrypted.isnot(None)).all():
    def replace(value, provider=provider):
      provider.secret_encrypted = value
    yield StoredSecret('sign_in_provider', f"Sign-in provider {provider.id}: client secret", provider.secret_encrypted, replace)
  for identity in UserIdentity.query.filter(UserIdentity.refresh_token_encrypted.isnot(None)).all():
    def replace(value, identity=identity):
      identity.refresh_token_encrypted = value
    yield StoredSecret('refresh_token', f"Refresh token of a {identity.provider_id} account", identity.refresh_token_encrypted, replace)


def describe_key(key: Optional[Key]) -> Optional[dict]:
  if key is None:
    return None
  created_at = None
  if key.source in ('generated', 'file'):
    try:
      from datetime import datetime, timezone
      created_at = datetime.fromtimestamp(Path(key.origin).stat().st_mtime, timezone.utc).isoformat()
    except OSError:
      pass
  return {"id": key.id, "source": key.source, "origin": key.origin, "created_at": created_at}


def status() -> dict:
  """What admins need to know about the key, and the secrets it decrypts. Never the key itself."""
  problems = []
  try:
    current = current_key()
  except NoEncryptionKey as e:
    current, problems = None, [str(e)]
  available = keys()
  counts = {}
  unreadable = []
  legacy = 0
  total = 0
  for secret in stored_secrets():
    total += 1
    key_id = key_id_of(secret.value)
    if key_id is None:
      legacy += 1
      key_id = next((k.id for k in available if _decrypts(k, secret.value)), None)
    elif not any(k.id == key_id for k in available) or not can_decrypt(secret.value):
      key_id = None
    if key_id is None:
      unreadable.append({"kind": secret.kind, "label": secret.label, "key_id": key_id_of(secret.value)})
    else:
      counts[key_id] = counts.get(key_id, 0) + 1
  weak = current is not None and current.source in ('env', 'file') and len(_text_of(current)) < MIN_KEY_LENGTH
  # values encrypted by previous keys, or older values: `rotate` re-encrypts them with the current key
  from . import settings as settings_lib
  plaintext = len(list(settings_lib.plaintext_secrets()))
  to_rotate = sum(n for key_id, n in counts.items() if not current or key_id != current.id) + (legacy if current else 0) + plaintext
  return {
    "key": describe_key(current),
    "can_encrypt": can_encrypt(),
    "generated_file": str(key_file()),
    "previous_keys": [describe_key(k) for k in available if not current or k.id != current.id],
    "secrets": {"total": total, "by_key": counts, "unreadable": unreadable, "plaintext": plaintext, "to_rotate": to_rotate},
    "weak": weak,
    "problems": problems,
  }


def _text_of(key: Key) -> str:
  try:
    if key.source == 'env':
      return os.environ.get('QABOARD_ENCRYPTION_KEY', '').strip()
    return _read(Path(key.origin))
  except OSError:
    return ''


def _decrypts(key: Key, value: str) -> bool:
  from cryptography.fernet import InvalidToken
  try:
    key.fernet().decrypt(value.encode())
    return True
  except InvalidToken:
    return False


def rotate(dry_run=False) -> dict:
  """
  Re-encrypts with the current key the values encrypted with other keys, and the older (bare) values, in the
  current database session: the caller commits. Values no key decrypts are left as they are.
  """
  key = current_key() or generate_key()
  rotated, unreadable, already = [], [], 0
  for secret in list(stored_secrets()):
    if key_id_of(secret.value) == key.id:
      already += 1
      continue
    try:
      plaintext = decrypt(secret.value)
    except UnknownKey:
      unreadable.append(secret.label)
      continue
    if not dry_run:
      secret.replace(f"{PREFIX}:{key.id}:{key.fernet().encrypt(plaintext.encode()).decode()}")
    rotated.append(secret.label)
  # secret settings saved before they were encrypted
  from . import settings as settings_lib
  for label, plaintext, replace in list(settings_lib.plaintext_secrets()):
    if not dry_run:
      replace(f"{PREFIX}:{key.id}:{key.fernet().encrypt(plaintext.encode()).decode()}")
    rotated.append(label)
  return {"key_id": key.id, "rotated": rotated, "unreadable": unreadable, "already": already}
