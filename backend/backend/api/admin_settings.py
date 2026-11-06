"""
Admin → Settings: every setting with where its value comes from (backend/settings.py), the variables that only come
from the environment, and the state of the encryption key of the secrets (backend/encryption.py).
"""
from flask import request, jsonify, g

from backend import app, db_session
from .. import settings as settings_lib
from .. import encryption
from ..audit import audit
from .auth import admin_required


def settings_response():
  return jsonify({
    "settings": settings_lib.describe_all(),
    "groups": settings_lib.describe_groups(),
    "server": settings_lib.describe_server(),
    "encryption": encryption_status(),
  })


def encryption_status():
  try:
    return encryption.status()
  except Exception as e:
    # e.g. a broken key file: the settings must still show
    db_session.rollback()
    return {"key": None, "can_encrypt": False, "problems": [f"{type(e).__name__}: {e}"], "secrets": None, "previous_keys": [], "weak": False}


def audited_change(key, before, after):
  definition = settings_lib.DEFINITIONS[key]
  if definition.secret and definition.mask != 'url':
    # never the secret, not even masked: whether it's set
    return {"value": {"from": "set" if before else "not set", "to": ("changed" if before else "set") if after else "not set"}}
  return {"value": {"from": settings_lib.masked(key, before), "to": settings_lib.masked(key, after)}}


def definition_is_secret(key):
  definition = settings_lib.DEFINITIONS[key]
  return definition.secret or any(f.secret for f in definition.fields)


@app.route('/api/v1/admin/settings', methods=['GET'])
@app.route('/api/v1/admin/settings/', methods=['GET'])
@admin_required
def admin_settings():
  return settings_response()


@app.route('/api/v1/admin/settings', methods=['POST'])
@app.route('/api/v1/admin/settings/', methods=['POST'])
@admin_required
def admin_update_settings():
  body = request.get_json(silent=True)
  if not isinstance(body, dict) or not body:
    return jsonify({"error": "Send {\"setting.key\": value}, null resets a setting to its default."}), 400
  # all valid, or nothing changes
  prepared = {}
  for key, value in body.items():
    definition = settings_lib.DEFINITIONS.get(key)
    if definition is None:
      return jsonify({"error": f"Unknown setting: {key}"}), 400
    # with null, admins can delete a value saved here that the environment overrides
    if value is not None and settings_lib.source(key) == 'env':
      return jsonify({"error": f"{key} is set by ${definition.env}: change it in the server's environment, or remove it there to manage it here."}), 400
    if value is not None and definition.secret and value == settings_lib.masked(key, settings_lib.setting(key)):
      return jsonify({"error": f"Type the whole new value of {key}: the current one is hidden."}), 400
    try:
      prepared[key] = settings_lib.prepare(key, value)
    except settings_lib.SettingError as e:
      return jsonify({"error": str(e), "reason": "encryption"}), 409
    except ValueError as e:
      return jsonify({"error": str(e)}), 400
  for key, stored in prepared.items():
    # what QA-Board used, before and after
    before = settings_lib.setting(key)
    had_row = key in settings_lib._database_rows()
    settings_lib.store(key, stored, by=g.actor.user)
    # the session doesn't autoflush: what we stored, not a query
    after = settings_lib.reveal(key, stored) if stored is not None else settings_lib.default(key)
    if before != after or (definition_is_secret(key) and stored is not None) or (stored is None and had_row):
      audit('setting.update', 'setting', key, key, changes=audited_change(key, before, after))
  db_session.commit()
  settings_lib.invalidate_cache()
  return settings_response()


@app.route('/api/v1/admin/settings/<key>/import-env', methods=['POST'])
@admin_required
def admin_import_setting_from_env(key):
  """Saves the environment's value here: admins can then remove the variable from the environment"""
  definition = settings_lib.DEFINITIONS.get(key)
  if definition is None:
    return jsonify({"error": f"Unknown setting: {key}"}), 404
  try:
    settings_lib.import_env(key, by=g.actor.user)
  except settings_lib.SettingError as e:
    return jsonify({"error": str(e), "reason": "encryption"}), 409
  except ValueError as e:
    return jsonify({"error": str(e)}), 400
  audit('setting.import_env', 'setting', key, key, meta={"env": definition.env})
  db_session.commit()
  settings_lib.invalidate_cache()
  return settings_response()


@app.route('/api/v1/admin/settings/test-email', methods=['POST'])
@admin_required
def admin_test_email():
  """Sends an email with the current settings, and says what the SMTP server answered"""
  from ..notifications.mail import email_settings, send_email, is_email, recipient_for
  body = request.get_json(silent=True) or {}
  user = g.actor.user
  to = (body.get('to') or '').strip() or recipient_for(user.user_name, user.email)
  if not is_email(to):
    return jsonify({"error": "Type the address to send the test email to."}), 400
  settings = email_settings()
  if not settings.enabled:
    return jsonify({"error": "Set the SMTP server first."}), 400
  from backend.config import qaboard_url
  text = f"This is a test email from QA-Board ({qaboard_url}), sent by {user.user_name} from Admin → Settings.\n\nEmails work."
  html = f"<p>This is a test email from QA-Board (<a href=\"{qaboard_url}\">{qaboard_url}</a>), sent by {user.user_name} from Admin → Settings.</p><p>Emails work.</p>"
  try:
    send_email(to, "QA-Board test email", html, text, settings=settings)
  except Exception as e:
    message = str(e) or type(e).__name__
    return jsonify({"error": f"{type(e).__name__}: {message}", "server": f"{settings.host}:{settings.port} ({settings.security})"}), 502
  audit('setting.test_email', 'setting', 'email', 'email', meta={"to": to})
  db_session.commit()
  return jsonify({"sent": True, "to": to, "server": f"{settings.host}:{settings.port} ({settings.security})", "sender": settings.sender})


@app.route('/api/v1/admin/encryption', methods=['GET'])
@admin_required
def admin_encryption():
  return jsonify(encryption_status())


@app.route('/api/v1/admin/encryption/rotate', methods=['POST'])
@admin_required
def admin_rotate_encryption():
  """Re-encrypts with the current key the secrets of previous keys, and those saved before they were encrypted"""
  try:
    result = encryption.rotate()
  except (encryption.NoEncryptionKey, encryption.KeyMismatch) as e:
    return jsonify({"error": str(e)}), 409
  if result["rotated"]:
    audit('encryption.rotate', 'encryption', result["key_id"], result["key_id"], meta={"rotated": len(result["rotated"]), "unreadable": len(result["unreadable"])})
  db_session.commit()
  settings_lib.invalidate_cache()
  return jsonify({**result, "status": encryption_status()})
