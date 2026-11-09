#!/usr/bin/env python
"""
Administration from the server's shell, e.g. to create the first admin:
  docker compose exec backend qaboard-admin create-admin alice
or to show the token of the setup page, that creates it from the web app:
  docker compose exec backend qaboard-admin setup-token
Everything is audited as done by "qaboard-admin".
"""
import sys
import json
import getpass

import click

import backend
from backend import db_session
from backend.models import User, Token
from backend.audit import system_audit, purge
from backend.settings import setting
from backend import tokens as tokens_lib


def find_user(user_name):
  user = User.query.filter((User.user_name == user_name) | (User.email == user_name)).one_or_none()
  if user is None:
    raise click.ClickException(f"No user {user_name!r}. They must sign in once, or use `create-admin --password` to create a local account.")
  return user


@click.group()
def cli():
  """Manage QA-Board from the server: users, and the jobs that maintain the storage"""


@cli.command('create-admin')
@click.argument('user_name')
@click.option('--password', 'with_password', is_flag=True, help="Create a local account if the user doesn't exist, asking for its password (or reading it from stdin).")
@click.option('--email', default=None)
@click.option('--full-name', default=None)
def create_admin(user_name, with_password, email, full_name):
  """Makes USER_NAME an admin, creating a local account with --password"""
  user = User.query.filter(User.user_name == user_name).one_or_none()
  if user is None:
    if not with_password:
      raise click.ClickException(f"No user {user_name!r}. They must sign in once, or add --password to create a local account.")
    password = getpass.getpass("Password: ") if sys.stdin.isatty() else sys.stdin.readline().rstrip('\n')
    if not password:
      raise click.ClickException("The password can't be empty.")
    from backend.api.auth import create_user
    user = create_user({"user_name": user_name, "full_name": full_name, "email": email, "password": password, "login_type": "LOCAL", "data": {}})
    system_audit('user.create', target_type='user', target_id=user.id, target_label=user.user_name, meta={"login_type": "LOCAL"})
  changes = {}
  if not user.is_admin:
    changes["is_admin"] = {"from": False, "to": True}
  if user.status != 'active':
    changes["status"] = {"from": user.status, "to": 'active'}
  user.is_admin, user.status = True, 'active'
  if changes:
    system_audit('user.update', target_type='user', target_id=user.id, target_label=user.user_name, changes=changes)
  db_session.commit()
  click.echo(f"{user.user_name} is an admin.")


@cli.command('setup-token')
def setup_token():
  """Shows the token of the setup page, that creates the first admin of a new server"""
  from backend import first_admin
  if not first_admin.setup_enabled():
    raise click.ClickException("The setup page is off (QABOARD_SETUP=off): create the first admin with `qaboard-admin create-admin <user_name> --password`.")
  if not first_admin.setup_open():
    raise click.ClickException("QA-Board is already set up: it has accounts. Make someone an admin with `qaboard-admin create-admin <user_name>`.")
  click.echo(f"Open {first_admin.setup_url()} and enter this setup token:")
  click.echo(first_admin.setup_token())


@cli.command('remove-admin')
@click.argument('user_name')
def remove_admin(user_name):
  """Removes the admin role USER_NAME (or email) has in the database"""
  user = find_user(user_name)
  if user.is_admin:
    user.is_admin = False
    system_audit('user.update', target_type='user', target_id=user.id, target_label=user.user_name, changes={"is_admin": {"from": True, "to": False}})
    db_session.commit()
  if backend.admins.is_env_admin(user):
    click.echo(f"Removed {user.user_name}'s admin role in the database: they stay an admin through $QABOARD_ADMINS.")
  else:
    click.echo(f"{user.user_name} is not an admin anymore.")


@cli.command('list-admins')
def list_admins():
  """Lists the admins, from the database and from $QABOARD_ADMINS"""
  from backend.admins import is_admin, is_env_admin
  for user in User.query.order_by(User.user_name).all():
    if is_admin(user):
      click.echo(f"{user.user_name}\t{user.email or ''}" + ("\t(from $QABOARD_ADMINS)" if is_env_admin(user) else ""))


@cli.command('revoke-tokens')
@click.argument('user_name')
def revoke_tokens(user_name):
  """Revokes all the tokens of a user"""
  from backend.actor import Actor
  user = find_user(user_name)
  count = 0
  for token in Token.query.filter(Token.user_id == user.id).all():
    if tokens_lib.revoke(token, reason='qaboard-admin', actor=Actor(label='qaboard-admin')):
      count += 1
  db_session.commit()
  click.echo(f"Revoked {count} token{'s' if count != 1 else ''} of {user.user_name}.")


@cli.command('check-sign-in')
@click.option('--provider', 'provider_id', default=None, help="Only this provider, e.g. sso. By default all of them.")
@click.option('--user', 'user_name', default=None, help="Also look this user up in LDAP, with the service account.")
@click.option('--url', 'url', default=None, help="QA-Board's public URL, for the OIDC redirect URIs. By default $QABOARD_URL.")
def check_sign_in(provider_id, user_name, url):
  """Checks the sign-in providers like they fail: the IdP unreachable, the issuer, the redirect URI, LDAP's service account"""
  import os
  from backend.sign_in import providers, doctor, oidc
  public_url = (url or os.environ.get('QABOARD_URL') or '').rstrip('/')
  ok = True
  for provider in providers.all_providers():
    if provider_id and provider.id != provider_id:
      continue
    if provider.type == 'oidc':
      if not public_url:
        raise click.ClickException("Set $QABOARD_URL, or give --url: the redirect URIs depend on it.")
      checks = doctor.check_oidc(provider, oidc.redirect_uri(provider, public_url))
    elif provider.type == 'ldap':
      checks = doctor.check_ldap(user_name)
    else:
      continue
    click.secho(f"{provider.name} ({provider.id})", bold=True)
    for c in checks:
      click.secho(f"  {'OK  ' if c['ok'] else 'FAIL'} {c['check']}: {c['detail']}", fg=None if c['ok'] else 'red')
      ok = ok and c['ok']
  if not ok:
    raise SystemExit(1)


@cli.command('purge-audit')
@click.option('--days', type=int, default=None, help="Delete the events older than this, by default the audit.retention_days setting.")
def purge_audit(days):
  """Deletes old audit events: run it from a scheduled job"""
  days = days or setting('audit.retention_days')
  count = purge(days)
  system_audit('audit.purge', meta={"days": days, "deleted": count})
  db_session.commit()
  click.echo(f"Deleted {count} events older than {days} days.")


@cli.group()
def usage():
  """What people do in the web app and with qa (Admin > Usage)"""


@usage.command('export')
@click.option('--since', default=None, help="The first day, YYYY-MM-DD. By default 30 days before --until.")
@click.option('--until', default=None, help="The last day, included, YYYY-MM-DD. By default today.")
@click.option('--project', default=None, help="Only this project, or product (the first element of project ids).")
@click.option('--format', 'format_', type=click.Choice(['csv', 'json']), default='csv', show_default=True, help="JSON is one event per line.")
def usage_export(since, until, project, format_):
  """Writes the raw usage events to stdout, oldest first"""
  import csv
  import json
  from backend import usage as usage_lib
  try:
    period = usage_lib.Period(usage_lib.parse_date(since), usage_lib.parse_date(until, end_of_day=True))
  except ValueError as e:
    raise click.ClickException(str(e))
  rows = usage_lib.events_rows(usage_lib.Filters(period, project))
  if format_ == 'json':
    for row in rows:
      sys.stdout.write(json.dumps(usage_lib.event_as_json(row), sort_keys=True) + "\n")
    return
  from backend.api.usage import csv_cell
  writer = csv.DictWriter(sys.stdout, fieldnames=usage_lib.EVENT_COLUMNS)
  writer.writeheader()
  for row in rows:
    writer.writerow({k: csv_cell(v) for k, v in usage_lib.event_as_text(row).items()})


@cli.group()
def jobs():
  """Server jobs, e.g. hard-deleting deleted runs. Admins start and schedule them in the web app (Admin > Storage)."""


@jobs.command('worker')
@click.option('--once', is_flag=True, help="Run the queued and due jobs, then exit (e.g. from a cron job), instead of waiting for more.")
@click.option('--poll', type=float, default=5, help="Seconds between checks for new jobs.")
def jobs_worker(once, poll):
  """Runs the jobs: keep one running next to the backend (the `jobs` service). Stops gracefully on SIGTERM."""
  from backend.jobs.worker import Worker
  Worker(poll_seconds=poll).loop(once=once)


@jobs.command('start')
@click.argument('kind')
@click.option('--param', 'param_list', multiple=True, help='KEY=VALUE, the value is read as JSON if it can be, e.g. --param \'projects=["a*"]\' --param dry_run=true')
def jobs_start(kind, param_list):
  """Queues a job, e.g. `qaboard-admin jobs start hard_delete --param created_before=3months --param dry_run=true`"""
  import json
  from backend.jobs import queue
  from backend.jobs.params import ParamsError
  params = {}
  for item in param_list:
    key, _, value = item.partition('=')
    try:
      params[key] = json.loads(value)
    except ValueError:
      params[key] = value
  try:
    job = queue.create(kind, params, label='qaboard-admin')
  except (ParamsError, queue.Busy) as e:
    raise click.ClickException(str(e))
  system_audit('job.create', target_type='job', target_id=job.id, target_label=kind, meta={"kind": kind, "params": job.params})
  db_session.commit()
  click.echo(f"Queued job {job.id}: {queue.serialize_job(job)['description']}")


@jobs.command('list')
@click.option('--limit', type=int, default=20)
def jobs_list(limit):
  """The latest jobs"""
  from backend.models import Job
  from backend.jobs import queue
  for job in Job.query.order_by(Job.id.desc()).limit(limit):
    j = queue.serialize_job(job)
    errors = sum((j['progress'].get('errors') or {}).values())
    click.echo(f"{j['id']:>6}  {j['status']:<16} {j['created_at']}  {j['description']}{' (dry run)' if j['dry_run'] else ''}{f'  [{errors} errors]' if errors else ''}")


@cli.group()
def encryption():
  """The key that encrypts the secrets stored in the database (backend/encryption.py)"""


@encryption.command('status')
def encryption_status():
  """Where the key comes from, and which stored secrets it decrypts"""
  from backend import encryption as lib
  status = lib.status()
  key = status["key"]
  if key:
    click.echo(f"Key {key['id']}, from {key['origin']}{' (generated by the server)' if key['source'] == 'generated' else ''}")
  else:
    click.echo(f"No key yet: the server generates one in {status['generated_file']} when it first stores a secret, unless $QABOARD_ENCRYPTION_KEY is set.")
  for previous in status["previous_keys"]:
    click.echo(f"Also decrypts with {previous['id']}, from {previous['origin']}")
  secrets = status["secrets"]
  click.echo(f"{secrets['total']} encrypted secrets: " + (', '.join(f"{n} with {k}" for k, n in secrets['by_key'].items()) or 'none'))
  if secrets["plaintext"]:
    click.echo(f"{secrets['plaintext']} secret settings saved before they were encrypted: `rotate` encrypts them")
  for item in secrets["unreadable"]:
    click.echo(f"Can't decrypt: {item['label']}" + (f" (key {item['key_id']})" if item['key_id'] else ''), err=True)
  for problem in status["problems"]:
    click.echo(f"ERROR: {problem}", err=True)
  if status["weak"]:
    click.echo("WARNING: the key is short, use at least 32 random characters (openssl rand -base64 32)", err=True)


@encryption.command('rotate')
@click.option('--dry-run', is_flag=True, help="Only say what would be re-encrypted.")
def encryption_rotate(dry_run):
  """Re-encrypts with the current key what older keys encrypted. Then remove $QABOARD_ENCRYPTION_KEY_PREVIOUS."""
  from backend import encryption as lib
  from backend import settings as settings_lib
  try:
    result = lib.rotate(dry_run=dry_run)
  except (lib.NoEncryptionKey, lib.KeyMismatch) as e:
    raise click.ClickException(str(e))
  for label in result["rotated"]:
    click.echo(f"{'Would re-encrypt' if dry_run else 'Re-encrypted'}: {label}")
  for label in result["unreadable"]:
    click.echo(f"Can't decrypt, left as is: {label}", err=True)
  if not dry_run:
    if result["rotated"]:
      system_audit('encryption.rotate', target_type='encryption', target_id=result["key_id"], target_label=result["key_id"], meta={"rotated": len(result["rotated"]), "unreadable": len(result["unreadable"])})
    db_session.commit()
    settings_lib.invalidate_cache()
  click.echo(f"{len(result['rotated'])} re-encrypted with {result['key_id']}, {result['already']} already were, {len(result['unreadable'])} can't be decrypted.")


@encryption.command('show-key')
def encryption_show_key():
  """Prints the key, to copy it to a secret store, e.g. as QABOARD_ENCRYPTION_KEY"""
  from backend import encryption as lib
  key = lib.current_key()
  if key is None:
    raise click.ClickException("There's no key yet: the server generates one when it first stores a secret.")
  if key.source == 'env':
    raise click.ClickException("The key comes from $QABOARD_ENCRYPTION_KEY: it's already in your deployment's secrets.")
  click.echo(lib._read(__import__('pathlib').Path(key.origin)))
  system_audit('encryption.show_key', target_type='encryption', target_id=key.id, target_label=key.id)
  db_session.commit()


@cli.group('settings')
def settings_group():
  """The settings of Admin → Settings"""


@settings_group.command('list')
@click.option('--changed', is_flag=True, help="Only those that aren't at their default.")
def settings_list(changed):
  """Every setting, its value and where it comes from"""
  from backend import settings as settings_lib
  for described in settings_lib.describe_all():
    if changed and described["source"] == 'default':
      continue
    source = {"env": f"${described['env']}", "database": "saved", "default": "default"}[described["source"]]
    value = json.dumps(described["value"], ensure_ascii=False)
    click.echo(f"{described['key']:<32} {source:<32} {value}" + (f"  ERROR: {described['error']}" if described["error"] else ''))


@settings_group.command('set')
@click.argument('key')
@click.argument('value', required=False)
def settings_set(key, value):
  """Saves KEY's VALUE, read as JSON if it can be. Secrets without VALUE are read from stdin."""
  from backend import settings as settings_lib
  definition = settings_lib.DEFINITIONS.get(key)
  if definition is None:
    raise click.ClickException(f"Unknown setting: {key}")
  if value is None:
    value = getpass.getpass(f"{key}: ") if sys.stdin.isatty() else sys.stdin.read().strip()
  if definition.type is not str:
    try:
      value = json.loads(value)
    except ValueError:
      if definition.type is list:
        value = settings_lib.env_list(value)
  try:
    settings_lib.save(key, value)
  except ValueError as e:
    raise click.ClickException(str(e))
  system_audit('setting.update', target_type='setting', target_id=key, target_label=key,
               changes={"value": {"to": "changed" if definition.secret else settings_lib.masked(key, value)}})
  db_session.commit()
  click.echo(f"Saved {key}" + (f" (but ${definition.env} wins)" if settings_lib.source(key) == 'env' else ''))


@settings_group.command('reset')
@click.argument('key')
def settings_reset(key):
  """Deletes the value saved for KEY: the default applies"""
  from backend import settings as settings_lib
  if key not in settings_lib.DEFINITIONS:
    raise click.ClickException(f"Unknown setting: {key}")
  settings_lib.save(key, None)
  system_audit('setting.update', target_type='setting', target_id=key, target_label=key, changes={"value": {"to": None}})
  db_session.commit()
  click.echo(f"Reset {key}")


@settings_group.command('export')
@click.option('--include-secrets', is_flag=True, help="Also the secrets, encrypted: they can only be imported where the same key is.")
def settings_export(include_secrets):
  """Prints the saved settings as JSON, e.g. to copy them to a staging server"""
  from backend import settings as settings_lib
  from backend.models import Setting
  exported = {}
  for row in Setting.query.order_by(Setting.key).all():
    definition = settings_lib.DEFINITIONS.get(row.key)
    if definition is None:
      continue
    value = (row.value or {}).get('value')
    if definition.secret and not include_secrets:
      continue
    if definition.type is settings_lib.Records and not include_secrets:
      secret_fields = {f.name for f in definition.fields if f.secret}
      value = [{k: v for k, v in record.items() if k not in secret_fields} for record in value or []]
    exported[row.key] = value
  click.echo(json.dumps(exported, indent=2, ensure_ascii=False))


def encrypted_values(value, marker):
  if isinstance(value, dict):
    if marker in value:
      yield value[marker]
    else:
      for v in value.values():
        yield from encrypted_values(v, marker)
  elif isinstance(value, list):
    for v in value:
      yield from encrypted_values(v, marker)


@settings_group.command('import')
@click.argument('path', type=click.File())
def settings_import(path):
  """Saves the settings of a JSON file made by `settings export` (all or none)"""
  from backend import settings as settings_lib
  from backend import encryption as lib
  data = json.load(path)
  if not isinstance(data, dict):
    raise click.ClickException("Expected {\"setting.key\": value}")
  prepared = {}
  for key, value in data.items():
    if key not in settings_lib.DEFINITIONS:
      raise click.ClickException(f"Unknown setting: {key}")
    encrypted = list(encrypted_values(value, settings_lib.ENCRYPTED))
    unreadable = [v for v in encrypted if not lib.can_decrypt(v)]
    if unreadable:
      raise click.ClickException(f"{key}: its secrets were encrypted with another key ({', '.join(sorted({lib.key_id_of(v) or '?' for v in unreadable}))}) than this server's")
    try:
      prepared[key] = value if isinstance(value, dict) and settings_lib.ENCRYPTED in value else settings_lib.prepare(key, value)
    except ValueError as e:
      raise click.ClickException(str(e))
  for key, stored in prepared.items():
    settings_lib.store(key, stored)
    system_audit('setting.update', target_type='setting', target_id=key, target_label=key, meta={"imported": True})
  db_session.commit()
  settings_lib.invalidate_cache()
  click.echo(f"Imported {len(prepared)} settings")


if __name__ == '__main__':
  cli()
