"""
Secrets admins store in the database (OIDC client secrets), encrypted with $QABOARD_ENCRYPTION_KEY.
Without the key, secrets must come from the environment (`client_secret_env`).
"""
import os
import base64
import hashlib


class NoEncryptionKey(Exception):
  pass


def _fernet():
  from cryptography.fernet import Fernet
  key = os.environ.get('QABOARD_ENCRYPTION_KEY', '').strip()
  if not key:
    raise NoEncryptionKey("Set $QABOARD_ENCRYPTION_KEY on the server to store secrets in the database, or give the name of an environment variable that holds it.")
  # any text works: we derive a Fernet key from it
  return Fernet(base64.urlsafe_b64encode(hashlib.sha256(key.encode()).digest()))


def can_encrypt() -> bool:
  return bool(os.environ.get('QABOARD_ENCRYPTION_KEY', '').strip())


def encrypt(secret: str) -> str:
  return _fernet().encrypt(secret.encode()).decode()


def decrypt(token: str) -> str:
  return _fernet().decrypt(token.encode()).decode()
