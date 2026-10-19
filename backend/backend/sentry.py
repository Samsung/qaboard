"""
Report the backend's errors, traces and profiles to Sentry, if $SENTRY_DSN is set.
The settings are documented in website/docs/backend-admin/monitoring.mdx, and shared with the CLI and the
celery workers in qaboard/sentry_utils.py.

Under uWSGI we initialize Sentry in each worker, after it forked from the master: the SDK sends events from
background threads, that don't survive a fork. uwsgi.ini also sets py-call-uwsgi-fork-hooks, as the SDK requires.
"""
import os

from qaboard.sentry_utils import sentry_options


def backend_sentry_options(dsn):
  from sentry_sdk.integrations.flask import FlaskIntegration
  return sentry_options(
    dsn,
    # The version of the image, e.g. the commit it was built from (see backend/Dockerfile)
    release=os.environ.get('QABOARD_VERSION'),
    environment='production',
    traces_rate=0.2,
    profile_session_rate=0.1,
    # The SQLAlchemy (database spans), Celery and Redis integrations are enabled automatically
    integrations=[FlaskIntegration()],
  )


_initialized = False

def init_sentry():
  """Returns whether Sentry is initialized: it requires $SENTRY_DSN."""
  global _initialized
  dsn = os.environ.get('SENTRY_DSN')
  if not dsn:
    return False
  if _initialized:
    return True
  import sentry_sdk
  sentry_sdk.init(**backend_sentry_options(dsn))
  _initialized = True
  return True


def sentry_user(user_info):
  """What we tell Sentry about a user: only their username."""
  if not isinstance(user_info, dict) or not user_info.get('user_name'):
    return None
  return {"username": user_info['user_name']}


def flask_sentry_user(g):
  """
  The user that the request authenticated, without querying the database:
  login_required sets g.user, flask_login caches the user it loaded in g._login_user.
  """
  user = sentry_user(g.get('user'))
  if user:
    return user
  login_user = g.get('_login_user')
  if login_user is not None and getattr(login_user, 'is_authenticated', False):
    user_name = getattr(login_user, 'user_name', None)
    if user_name:
      return {"username": user_name}
  return None


def track_users(app):
  """Tag the errors and traces of each request with the user's name."""
  import sentry_sdk
  from flask import g

  @app.before_request
  def sentry_user_processor():
    # The event processor runs when an event is sent, after the endpoint authenticated the user.
    # By then the request context may be gone (e.g. for the request's transaction), so we keep `g` itself.
    request_g = g._get_current_object()
    def add_user(event, hint):
      user = flask_sentry_user(request_g)
      if user:
        event['user'] = {**user, **(event.get('user') or {})}
      return event
    # Flask's integration gives each request its own isolation scope
    sentry_sdk.get_isolation_scope().add_event_processor(add_user)
