#!/usr/bin/env python
"""
Administration from the server's shell, e.g. to create the first admin:
  docker compose exec backend qaboard-admin create-admin alice
Everything is audited as done by "qaboard-admin".
"""
import sys
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
  """Manage QA-Board's users from the server"""


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


@cli.command('purge-audit')
@click.option('--days', type=int, default=None, help="Delete the events older than this, by default the audit.retention_days setting.")
def purge_audit(days):
  """Deletes old audit events: run it from a scheduled job"""
  days = days or setting('audit.retention_days')
  count = purge(days)
  system_audit('audit.purge', meta={"days": days, "deleted": count})
  db_session.commit()
  click.echo(f"Deleted {count} events older than {days} days.")


if __name__ == '__main__':
  cli()
