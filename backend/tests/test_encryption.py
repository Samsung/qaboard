"""backend/encryption.py: values of older versions still decrypt, key ids, rotation's keys"""
import base64
import hashlib

import pytest
from cryptography.fernet import Fernet


@pytest.fixture
def lib(monkeypatch, tmp_path):
  from backend import encryption
  monkeypatch.setattr(encryption, "key_file", lambda: tmp_path / "encryption_key")
  for name in ('QABOARD_ENCRYPTION_KEY', 'QABOARD_ENCRYPTION_KEY_FILE', 'QABOARD_ENCRYPTION_KEY_PREVIOUS'):
    monkeypatch.delenv(name, raising=False)
  # no database here: nothing is stored yet
  monkeypatch.setattr(encryption, "stored_secrets", lambda: iter(()))
  return encryption


def test_values_of_older_versions_still_decrypt(lib, monkeypatch):
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY', 'old key')
  # what older versions stored: a bare Fernet token, with a key derived the same way
  legacy = Fernet(base64.urlsafe_b64encode(hashlib.sha256(b'old key').digest())).encrypt(b'secret').decode()
  assert lib.key_id_of(legacy) is None and lib.decrypt(legacy) == 'secret'
  value = lib.encrypt('secret')
  assert value.startswith(f"qb1:{lib.current_key().id}:") and lib.decrypt(value) == 'secret'


def test_key_ids(lib, monkeypatch):
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY', 'a')
  a = lib.current_key().id
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY', 'b')
  assert lib.current_key().id != a and len(a) == 12 and a not in ('a', lib.derive('a').material.decode())
  value = lib.encrypt('x')
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY', 'a')
  with pytest.raises(lib.UnknownKey) as error:
    lib.decrypt(value)
  assert lib.derive('b').id in str(error.value)
  # with the previous key, it decrypts
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY_PREVIOUS', 'b')
  assert lib.decrypt(value) == 'x' and [k.source for k in lib.keys()] == ['env', 'previous']


def test_a_key_file(lib, monkeypatch, tmp_path):
  (tmp_path / "mounted").write_text("from a file\n")
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY_FILE', str(tmp_path / "mounted"))
  assert lib.current_key().source == 'file' and lib.current_key().id == lib.derive('from a file').id
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY_FILE', str(tmp_path / "missing"))
  with pytest.raises(lib.NoEncryptionKey):
    lib.encrypt('x')


def test_generated_key(lib, tmp_path):
  assert lib.current_key() is None and lib.can_encrypt()
  value = lib.encrypt('x')
  key = lib.current_key()
  assert key.source == 'generated' and (tmp_path / "encryption_key").stat().st_mode & 0o777 == 0o600
  assert lib.decrypt(value) == 'x'
  # it's kept
  assert lib.generate_key().id == key.id
