"""
Admin → Settings beyond simple values: secrets encrypted in the database, records (Jenkins servers, git hosts...),
moving settings from the environment to the database, and the encryption key: generated, rotated, lost.
"""
import json

import pytest
from click.testing import CliRunner


TOKEN = 'jenkins-api-token-1234567890'


@pytest.fixture
def admin(logged_in):
  return logged_in('root', is_admin=True)


@pytest.fixture(autouse=True)
def encryption_key(monkeypatch):
  """Each test starts with a known key, and no generated one"""
  from backend import encryption
  encryption.key_file().unlink(missing_ok=True)
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY', 'a key for the tests, long enough to not be weak')
  for name in ('QABOARD_ENCRYPTION_KEY_FILE', 'QABOARD_ENCRYPTION_KEY_PREVIOUS', 'JENKINS_AUTH', 'GITLAB_AUTH', 'JENKINS_BUILD_TOKEN',
               'QABOARD_SMTP_HOST', 'QABOARD_SMTP_PASSWORD', 'QABOARD_GIT_HOSTS', 'QABOARD_WEBHOOK_SECRET'):
    monkeypatch.delenv(name, raising=False)
  encryption._checked.update(key_id=None, at=0.0)
  yield
  encryption.key_file().unlink(missing_ok=True)


def by_key(response):
  return {s["key"]: s for s in response.get_json()["settings"]}


def stored(key):
  from backend.database import db_session
  from backend.models import Setting
  db_session.expire_all()
  row = Setting.query.filter(Setting.key == key).one_or_none()
  return row.value["value"] if row else None


def run(*args, input=None):
  from backend.database import db_session
  from backend.scripts.admin import cli
  result = CliRunner().invoke(cli, list(args), input=input)
  db_session.remove()
  return result


def test_records_with_secrets(admin):
  """Jenkins servers: admins see the hostnames and users, never the tokens, that are encrypted one by one"""
  response = admin.post('/api/v1/admin/settings', json={"jenkins.servers": [
    {"hostname": "https://Jenkins.example.com/job/x/", "user": "qa", "token": TOKEN},
  ]})
  assert response.status_code == 200, response.get_json()
  assert TOKEN not in response.get_data(as_text=True)
  setting = by_key(response)["jenkins.servers"]
  [record] = setting["value"]
  # a URL is reduced to its hostname, the token is only "set"
  assert record["hostname"] == "jenkins.example.com" and record["user"] == "qa" and record["token"] is True and record["crumb"] is False
  assert setting["source"] == "database" and setting["layers"]["database"]["updated_by"] == "root"
  [row] = stored("jenkins.servers")
  assert row["token"]["$encrypted"].startswith("qb1:") and TOKEN not in json.dumps(row)

  import backend.api.integrations as integrations
  assert integrations.jenkins_credentials()["jenkins.example.com"]["token"] == TOKEN
  credentials = integrations.jenkins_hostname_credentials("http://jenkins.example.com/job/x")
  assert credentials["auth"].password == TOKEN and credentials["headers"] == {}

  # changing the user keeps the token: `true` means "keep it"
  response = admin.post('/api/v1/admin/settings', json={"jenkins.servers": [{**record, "user": "qa-bot"}]})
  assert response.status_code == 200, response.get_json()
  assert integrations.jenkins_credentials()["jenkins.example.com"] == {**integrations.jenkins_credentials()["jenkins.example.com"], "user": "qa-bot", "token": TOKEN}
  # a new server needs its token
  response = admin.post('/api/v1/admin/settings', json={"jenkins.servers": [record, {"hostname": "other", "user": "u", "token": True}]})
  assert response.status_code == 400 and "must be given again" in response.get_json()["error"]
  response = admin.post('/api/v1/admin/settings', json={"jenkins.servers": [record, {"hostname": "jenkins.example.com", "user": "u", "token": "t"}]})
  assert response.status_code == 400 and "listed twice" in response.get_json()["error"]
  response = admin.post('/api/v1/admin/settings', json={"jenkins.servers": [{"hostname": "x", "user": "u"}]})
  assert response.status_code == 400 and "API token is required" in response.get_json()["error"]

  from backend.models import AuditEvent
  events = AuditEvent.query.filter(AuditEvent.action == 'setting.update').all()
  assert events and all(TOKEN not in json.dumps(e.changes) for e in events)


def test_secret_values_are_write_only(admin):
  response = admin.post('/api/v1/admin/settings', json={"email.smtp_host": "smtp.example.com", "email.smtp_password": "hunter2-password"})
  assert response.status_code == 200
  settings = by_key(response)
  assert settings["email.smtp_password"]["value"] == "••••••••" and settings["email.smtp_password"]["is_set"] is True
  assert "hunter2" not in admin.get('/api/v1/admin/settings').get_data(as_text=True)
  assert stored("email.smtp_password")["$encrypted"].startswith("qb1:")
  from backend.notifications.mail import email_settings
  assert email_settings().password == "hunter2-password" and email_settings().host == "smtp.example.com"
  from backend.models import AuditEvent
  event = AuditEvent.query.filter(AuditEvent.target_id == 'email.smtp_password').one()
  assert event.changes == {"value": {"from": "not set", "to": "set"}}
  # clearing it
  assert admin.post('/api/v1/admin/settings', json={"email.smtp_password": None}).status_code == 200
  assert email_settings().password is None


def test_moving_a_setting_from_the_environment(admin, monkeypatch):
  """JENKINS_AUTH's JSON becomes records, admins copy it to the database, then remove the variable"""
  monkeypatch.setenv('JENKINS_AUTH', json.dumps({"jenkins": {"user": "u", "token": TOKEN, "crumb": "c"}}))
  setting = by_key(admin.get('/api/v1/admin/settings'))["jenkins.servers"]
  assert setting["source"] == "env" and not setting["editable"] and setting["can_import_env"]
  assert setting["value"][0]["token"] is True and TOKEN not in json.dumps(setting)
  response = admin.post('/api/v1/admin/settings', json={"jenkins.servers": []})
  assert response.status_code == 400 and "$JENKINS_AUTH" in response.get_json()["error"]

  response = admin.post('/api/v1/admin/settings/jenkins.servers/import-env')
  assert response.status_code == 200, response.get_json()
  setting = by_key(response)["jenkins.servers"]
  assert setting["source"] == "env" and setting["env_matches_database"] and not setting["can_import_env"]
  monkeypatch.delenv('JENKINS_AUTH')
  setting = by_key(admin.get('/api/v1/admin/settings'))["jenkins.servers"]
  assert setting["source"] == "database" and setting["editable"]
  import backend.api.integrations as integrations
  assert integrations.jenkins_credentials()["jenkins"]["token"] == TOKEN
  assert admin.post('/api/v1/admin/settings/jenkins.servers/import-env').status_code == 400


def test_invalid_environment_values_are_ignored(admin, monkeypatch):
  """Before, an invalid JENKINS_AUTH stopped the server. Now it's ignored, and the checklist says why"""
  monkeypatch.setenv('JENKINS_AUTH', '{"jenkins": ')
  setting = by_key(admin.get('/api/v1/admin/settings'))["jenkins.servers"]
  assert setting["source"] == "default" and "not valid JSON" in setting["layers"]["env"]["error"]
  checklist = {i["id"]: i for i in admin.get('/api/v1/admin/overview').get_json()["checklist"]}
  assert checklist["invalid_env:jenkins.servers"]["severity"] == "danger"


def test_git_hosts_from_the_settings(admin):
  """The git hosts are rebuilt when admins change them: webhooks, links and clones use them at once"""
  from backend.git_hosts import git_hosts
  assert git_hosts.find("https://codeberg.example.com/a/b") is None
  response = admin.post('/api/v1/admin/settings', json={
    "git.hosts": [{"type": "gitea", "url": "https://codeberg.example.com/", "token": "gitea-token", "hostnames": "ssh.codeberg.example.com"}],
    "git.webhook_secret": "webhook-secret",
  })
  assert response.status_code == 200, response.get_json()
  from backend import settings
  settings.invalidate_cache()
  host = git_hosts.find("https://codeberg.example.com/a/b")
  assert host.type == "gitea" and host.token == "gitea-token" and git_hosts.find("ssh.codeberg.example.com") is host
  # the shared webhook secret applies to the hosts without their own
  assert host.webhook_secret == "webhook-secret" and git_hosts.has_webhook_secrets()
  response = admin.post('/api/v1/admin/settings', json={"git.hosts": [{"type": "nope", "url": "https://x"}]})
  assert response.status_code == 400 and "must be one of" in response.get_json()["error"]


def test_test_email(admin, monkeypatch):
  assert admin.post('/api/v1/admin/settings/test-email', json={}).status_code == 400
  admin.post('/api/v1/admin/settings', json={"email.smtp_host": "smtp.example.com", "email.from": "QA-Board <qa@example.com>"})
  sent = []
  import backend.notifications.mail as mail
  monkeypatch.setattr(mail, "send_email", lambda to, subject, html, text, settings=None, headers=None: sent.append((to, settings.host)))
  response = admin.post('/api/v1/admin/settings/test-email', json={})
  assert response.status_code == 200, response.get_json()
  assert sent == [("root@example.com", "smtp.example.com")] and response.get_json()["sender"] == "QA-Board <qa@example.com>"
  def refuse(*args, **kwargs):
    raise mail.smtplib.SMTPAuthenticationError(535, b"Authentication failed")
  monkeypatch.setattr(mail, "send_email", refuse)
  response = admin.post('/api/v1/admin/settings/test-email', json={"to": "x@example.com"})
  assert response.status_code == 502 and "Authentication failed" in response.get_json()["error"]


def test_server_variables_are_shown_without_secrets(admin, monkeypatch):
  monkeypatch.setenv('CELERY_BROKER_URL', 'pyamqp://qa:broker-password@rabbitmq:5672//')
  body = admin.get('/api/v1/admin/settings').get_json()
  server = {v["key"]: v for v in body["server"]}
  assert server["SECRET_KEY"]["value"] == "set" and server["SECRET_KEY"]["secret"]
  assert "broker-password" not in json.dumps(body) and server["CELERY_BROKER_URL"]["value"].startswith("pyamqp://qa:•••@rabbitmq")
  assert "integration-tests" not in json.dumps(body)
  assert all(v["why"] and not v["editable"] for v in server.values())


def test_rotating_the_key(admin, monkeypatch):
  admin.post('/api/v1/admin/settings', json={"jenkins.build_token": "build-token", "email.smtp_password": "smtp-password"})
  from backend import encryption, settings
  old = encryption.current_key().id
  status = admin.get('/api/v1/admin/encryption').get_json()
  assert status["key"]["id"] == old and status["key"]["source"] == "env" and status["secrets"]["by_key"] == {old: 2}

  # a new key, the old one as the previous: everything still decrypts
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY_PREVIOUS', 'a key for the tests, long enough to not be weak')
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY', 'the new key, also long enough to not be weak')
  settings.invalidate_cache()
  assert settings.setting('jenkins.build_token') == "build-token"
  status = admin.get('/api/v1/admin/encryption').get_json()
  assert status["secrets"]["to_rotate"] == 2 and [k["id"] for k in status["previous_keys"]] == [old]
  checklist = {i["id"]: i for i in admin.get('/api/v1/admin/overview').get_json()["checklist"]}
  assert checklist["encryption_rotate"]["severity"] == "info"

  response = admin.post('/api/v1/admin/encryption/rotate')
  assert response.status_code == 200 and len(response.get_json()["rotated"]) == 2
  new = encryption.current_key().id
  assert response.get_json()["status"]["secrets"]["by_key"] == {new: 2}
  monkeypatch.delenv('QABOARD_ENCRYPTION_KEY_PREVIOUS')
  settings.invalidate_cache()
  assert settings.setting('jenkins.build_token') == "build-token" and settings.setting('email.smtp_password') == "smtp-password"


def test_a_lost_key(admin, monkeypatch):
  """The secrets fall back to their default, and admins are told which ones to restore or enter again"""
  admin.post('/api/v1/admin/settings', json={"jenkins.build_token": "build-token"})
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY', 'another key, nothing to do with the first one')
  from backend import settings
  settings.invalidate_cache()
  assert settings.setting('jenkins.build_token') is None
  setting = by_key(admin.get('/api/v1/admin/settings'))["jenkins.build_token"]
  assert setting["source"] == "default" and "can't be decrypted" in setting["layers"]["database"]["error"]
  checklist = {i["id"]: i for i in admin.get('/api/v1/admin/overview').get_json()["checklist"]}
  assert checklist["undecryptable:jenkins.build_token"]["severity"] == "danger"
  assert checklist["encryption_unreadable"]["severity"] == "danger"
  # entering it again fixes it
  assert admin.post('/api/v1/admin/settings', json={"jenkins.build_token": "build-token-2"}).status_code == 200
  assert settings.setting('jenkins.build_token') == "build-token-2"


def test_a_generated_key_never_encrypts_next_to_secrets_it_cant_read(admin, monkeypatch):
  """E.g. a replica that doesn't share the data folder generated its own key: its secrets would be unreadable by the others"""
  admin.post('/api/v1/admin/settings', json={"jenkins.build_token": "build-token"})
  monkeypatch.delenv('QABOARD_ENCRYPTION_KEY')
  response = admin.post('/api/v1/admin/settings', json={"email.smtp_password": "smtp-password"})
  assert response.status_code == 409 and "QABOARD_ENCRYPTION_KEY" in response.get_json()["error"]
  # once the lost secret is cleared, the generated key is used, and admins are asked to back it up
  assert admin.post('/api/v1/admin/settings', json={"jenkins.build_token": None}).status_code == 200
  from backend import encryption
  encryption._checked.update(key_id=None, at=0.0)
  response = admin.post('/api/v1/admin/settings', json={"email.smtp_password": "smtp-password"})
  assert response.status_code == 200, response.get_json()
  status = admin.get('/api/v1/admin/encryption').get_json()
  assert status["key"]["source"] == "generated"
  checklist = {i["id"]: i for i in admin.get('/api/v1/admin/overview').get_json()["checklist"]}
  assert "show-key" in checklist["encryption_generated"]["detail"]
  result = run('encryption', 'show-key')
  assert result.exit_code == 0 and result.output.strip() == encryption.key_file().read_text().strip()


def test_plaintext_secrets_of_older_versions(admin):
  """The access requests webhook was saved in plain text: it still works, and rotating encrypts it"""
  from backend.database import db_session
  from backend.models import Setting
  from backend import settings
  db_session.add(Setting(key='auth.access_request_webhook', value={"value": "https://hooks.slack.com/services/T/B/XXXX"}))
  db_session.commit()
  settings.invalidate_cache()
  assert settings.setting('auth.access_request_webhook') == "https://hooks.slack.com/services/T/B/XXXX"
  assert admin.get('/api/v1/admin/encryption').get_json()["secrets"]["plaintext"] == 1
  result = run('encryption', 'rotate')
  assert result.exit_code == 0, result.output
  assert stored('auth.access_request_webhook')["$encrypted"].startswith("qb1:")
  settings.invalidate_cache()
  assert settings.setting('auth.access_request_webhook') == "https://hooks.slack.com/services/T/B/XXXX"


def test_settings_export_and_import():
  result = run('settings', 'set', 'jenkins.build_token', input='build-token\n')
  assert result.exit_code == 0, result.output
  assert run('settings', 'set', 'ingest.auth', 'warn').exit_code == 0
  assert run('settings', 'set', 'jenkins.servers', json.dumps([{"hostname": "j", "user": "u", "token": "t"}])).exit_code == 0
  exported = json.loads(run('settings', 'export').output)
  assert exported["ingest.auth"] == "warn" and "jenkins.build_token" not in exported and "token" not in exported["jenkins.servers"][0]
  with_secrets = run('settings', 'export', '--include-secrets').output
  assert "build-token" not in with_secrets
  for key in ('ingest.auth', 'jenkins.build_token', 'jenkins.servers'):
    run('settings', 'reset', key)
  from backend import settings
  import tempfile
  with tempfile.NamedTemporaryFile('w', suffix='.json') as f:
    f.write(with_secrets)
    f.flush()
    result = run('settings', 'import', f.name)
  assert result.exit_code == 0, result.output
  settings.invalidate_cache()
  assert settings.setting('jenkins.build_token') == "build-token" and settings.setting('ingest.auth') == "warn"
  assert settings.setting('jenkins.servers')[0]["token"] == "t"
  listed = run('settings', 'list', '--changed').output
  assert "ingest.auth" in listed and "build-token" not in listed


def test_reading_settings_leaves_the_session_alone(admin):
  """
  uWSGI's master imports the app, which reads the settings (the git hosts): a transaction left open in its session
  would be inherited by the forked workers, on the same connection ("DECLARE CURSOR can only be used in transaction
  blocks"). Settings are read on a connection of their own.
  """
  assert admin.post('/api/v1/admin/settings', json={"ingest.auth": "warn"}).status_code == 200
  from backend.database import db_session, engine
  from backend import settings
  db_session.remove()
  settings.invalidate_cache()
  assert settings.setting('ingest.auth') == 'warn'
  from backend.git_hosts import git_hosts
  assert git_hosts.default
  assert not (db_session.registry.has() and db_session().in_transaction())
  assert engine.pool.checkedout() == 0
