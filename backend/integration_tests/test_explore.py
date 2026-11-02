"""
What Explore needs from /api/v1/projects (who uses which project: human activity, batches per day, views), the page
views (/api/v1/project/view), and that signed-out visitors only see the projects they may read.
"""
import datetime

from .conftest import make_projects


def utcnow():
  return datetime.datetime.utcnow()


def add_batch(project_id, label, origin, latest_output_datetime):
  from backend.database import db_session
  from backend.models import Batch, CiCommit
  commit = CiCommit.query.filter(CiCommit.project_id == project_id).first()
  db_session.add(Batch(ci_commit_id=commit.id, label=label, origin=origin, latest_output_datetime=latest_output_datetime))
  db_session.commit()


def views(project_id=None):
  from backend.database import db_session
  from backend.models import ProjectView
  db_session.remove()
  query = ProjectView.query
  if project_id:
    query = query.filter(ProjectView.project_id == project_id)
  return [(v.project_id, v.views) for v in query.order_by(ProjectView.project_id)]


def test_human_activity_and_batches_per_day(client):
  make_projects('repo', 'repo/sub')
  now = utcnow()
  add_batch('repo', 'nightly', 'ci', now)
  add_batch('repo', 'old-ci', 'ci', now - datetime.timedelta(days=40))
  add_batch('repo', 'tuning', 'webapp', now - datetime.timedelta(days=2))
  add_batch('repo', '@alice| tries', 'local', now - datetime.timedelta(days=50))
  projects = client.get('/api/v1/projects?summary=true').get_json()

  repo = projects['repo']
  # the CI's batches don't count as human activity
  assert repo['latest_human_activity'] == (now - datetime.timedelta(days=2)).isoformat()
  assert len(repo['activity']) == 30 and sum(repo['activity']) == 2
  assert repo['activity'][-1] == 1 and repo['activity'][-3] == 1
  assert (repo['views_90d'], repo['my_last_view']) == (0, None)
  # projects without any: no activity
  assert projects['repo/sub']['latest_human_activity'] is None
  assert projects['repo/sub']['activity'] is None
  # also without ?summary
  assert client.get('/api/v1/projects').get_json()['repo']['activity'] == repo['activity']


def test_views_are_counted_once_an_hour(client, logged_in):
  make_projects('repo')
  alice = logged_in('alice')
  assert alice.post('/api/v1/project/view', json={"project": "repo"}).status_code == 204
  assert alice.post('/api/v1/project/view', json={"project": "repo"}).status_code == 204
  assert views() == [('repo', 1)]

  # an hour later, it counts again
  from backend.database import db_session
  from backend.models import ProjectView
  ProjectView.query.update({ProjectView.last_viewed_at: utcnow() - datetime.timedelta(hours=2)})
  db_session.commit()
  assert alice.post('/api/v1/project/view', json={"project": "repo"}).status_code == 204
  assert views() == [('repo', 2)]

  logged_in('bob').post('/api/v1/project/view', json={"project": "repo"})
  projects = alice.get('/api/v1/projects?summary=true').get_json()
  assert projects['repo']['views_90d'] == 2
  assert projects['repo']['my_last_view'] is not None
  # anonymous visitors see how many people look at it, not when they did
  anonymous = client.get('/api/v1/projects?summary=true').get_json()['repo']
  assert (anonymous['views_90d'], anonymous['my_last_view']) == (2, None)


def test_old_views_dont_count(client, logged_in):
  make_projects('repo')
  alice = logged_in('alice')
  alice.post('/api/v1/project/view', json={"project": "repo"})
  from backend.database import db_session
  from backend.models import ProjectView
  ProjectView.query.update({ProjectView.last_viewed_at: utcnow() - datetime.timedelta(days=91)})
  db_session.commit()
  assert alice.get('/api/v1/projects?summary=true').get_json()['repo']['views_90d'] == 0


def test_views_of_anonymous_visitors_and_errors(client, logged_in):
  make_projects('repo')
  assert client.post('/api/v1/project/view', json={"project": "repo"}).status_code == 204
  assert views() == []
  alice = logged_in('alice')
  assert alice.post('/api/v1/project/view', json={}).status_code == 400
  assert alice.post('/api/v1/project/view', json={"project": "missing"}).status_code == 404
  assert views() == []


def private_project(logged_in, monkeypatch, project='group/secret'):
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  make_projects(project, 'group/public')
  add_batch(project, 'tuning', 'webapp', utcnow())
  root = logged_in('root')
  assert root.post('/api/v1/project/access/visibility', json={"project": project, "visibility": "private"}).status_code == 200
  assert root.post('/api/v1/project/view', json={"project": project}).status_code == 204
  return root


def test_anonymous_visitors_only_see_public_projects(client, logged_in, monkeypatch):
  root = private_project(logged_in, monkeypatch)
  assert set(root.get('/api/v1/projects?summary=true').get_json()) == {'group/secret', 'group/public'}
  for url in ('/api/v1/projects?summary=true', '/api/v1/projects'):
    response = client.get(url)
    projects = response.get_json()
    assert set(projects) == {'group/public'}
    # nothing about the private project, even in the other projects' fields
    assert 'secret' not in response.get_data(as_text=True)
  assert set(logged_in('dave').get('/api/v1/projects?summary=true').get_json()) == {'group/public'}


def test_views_need_read_access(client, logged_in, monkeypatch):
  private_project(logged_in, monkeypatch)
  dave = logged_in('dave')
  assert dave.post('/api/v1/project/view', json={"project": "group/secret"}).status_code == 403
  # anonymous: a no-op, it doesn't tell whether the project exists
  assert client.post('/api/v1/project/view', json={"project": "group/secret"}).status_code == 204
  assert views('group/secret') == [('group/secret', 1)]
