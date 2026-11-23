"""
The tokens of the batches QA-Board starts (tokens.mint_for_batch): revoked when the batch is stopped, ending soon
after its runs end, the only way its driver sends its log when it doesn't see the server's storage, and limited to
their own batch (tokens.batch_allows).
"""
import datetime

import pytest

from .conftest import bearer
from .test_ingest import output_payload, commit_payload, PROJECT, SHA
from .test_jobs import storage  # noqa: F401 (fixture)

COMMAND_ID = "44444444-4444-4444-8444-444444444444"


def known_commit(project=PROJECT, hexsha=SHA, **payload):
  """The server starts batches on commits it knows: their tokens don't create them"""
  from backend.database import db_session
  from backend.models import CiCommit
  commit = CiCommit.get_or_create(db_session, hexsha, project, data=commit_payload(project=project, commit_sha=hexsha, **payload))
  db_session.add(commit)
  db_session.commit()
  return commit


def batch_token(user_name, command_id=COMMAND_ID, batch="default", **data):
  """A batch token of `user_name`, as mint_for_batch makes them: for the batch `batch` of the commit SHA"""
  from backend.database import db_session
  from backend.models import User
  from backend import tokens
  known_commit()
  user = User.query.filter(User.user_name == user_name).one()
  token, secret = tokens.mint(user, name="Batch", scopes=['read', 'ingest'], kind='batch', projects=[PROJECT],
                              expires_at=tokens.utcnow() + datetime.timedelta(days=30), idle_expiry_days=1,
                              data={"command_id": command_id, "project": PROJECT, "commit": SHA, "batch": batch, **data})
  db_session.commit()
  return token.id, secret


def stored(token_id):
  from backend.database import db_session
  from backend.models import Token
  db_session.expire_all()
  return db_session.get(Token, token_id)


def is_revoked(token_id):
  return stored(token_id).revoked


def ends_soon(token_id):
  from backend import tokens
  return stored(token_id).expires_at <= tokens.utcnow() + tokens.ENDED_BATCH_GRACE


def test_the_token_ends_soon_after_the_batchs_last_run_ends(logged_in, make_client):
  logged_in('alice', is_admin=True)
  token_id, secret = batch_token('alice')
  client = make_client()
  run = lambda input_path, pending: client.post('/api/v1/output/', headers=bearer(secret), json=output_payload(
    rel_input_path=input_path, is_pending=pending, data={"root_command_id": COMMAND_ID}))
  # `qa batch` tells QA-Board about all its runs before it starts them
  for input_path in ("inputs/a.txt", "inputs/b.txt"):
    assert run(input_path, True).status_code == 200
  assert run("inputs/a.txt", False).status_code == 200
  assert not ends_soon(token_id)
  assert run("inputs/b.txt", False).status_code == 200
  # its driver may still send the end of its log
  assert ends_soon(token_id) and not is_revoked(token_id)


def test_qa_optimize_and_redo_keep_their_token_until_stopped(logged_in, make_client):
  logged_in('alice', is_admin=True)
  token_id, secret = batch_token('alice', until_stopped=True)
  payload = output_payload(is_pending=False, data={"root_command_id": COMMAND_ID})
  assert make_client().post('/api/v1/output/', headers=bearer(secret), json=payload).status_code == 200
  assert not ends_soon(token_id)


@pytest.fixture
def log_dir(storage):
  directory = storage / "output" / "qaboard-batches" / f"20261118-100000-{COMMAND_ID[:8]}"
  directory.mkdir(parents=True)
  return directory


def test_the_driver_sends_its_log_with_the_batchs_token(logged_in, make_client, log_dir, tmp_path):
  alice = logged_in('alice', is_admin=True)
  _, secret = batch_token('alice', log_dir=str(log_dir))
  client = make_client()
  url = f"/api/v1/batch/submissions/{COMMAND_ID}/log"
  answer = client.put(f"{url}?offset=0", headers=bearer(secret), data=b"hello\n")
  assert answer.status_code == 200 and answer.get_json() == {"size": 6}
  assert client.put(f"{url}?offset=6", headers=bearer(secret), data=b"world\n").get_json() == {"size": 12}
  assert (log_dir / "log.txt").read_text() == "hello\nworld\n"
  # the server wrote in it meanwhile: the driver goes on after it
  answer = client.put(f"{url}?offset=6", headers=bearer(secret), data=b"again\n")
  assert answer.status_code == 409 and answer.get_json()["size"] == 12

  # only the batch's own token
  _, other_batch = batch_token('alice', command_id="55555555-5555-4555-8555-555555555555", log_dir=str(log_dir))
  assert client.put(f"{url}?offset=12", headers=bearer(other_batch), data=b"x").status_code == 403
  personal = alice.post('/api/v1/user/tokens', json={"name": "t", "scopes": ["read", "ingest", "act"]}).get_json()["token"]
  assert client.put(f"{url}?offset=12", headers=bearer(personal), data=b"x").status_code == 403
  assert alice.put(f"{url}?offset=12", data=b"x", headers={"Origin": "http://localhost"}).status_code == 403
  assert client.put(f"{url}?offset=12", data=b"x").status_code in (401, 403)
  # into a folder of the storage only
  _, outside = batch_token('alice', log_dir=str(tmp_path))
  assert client.put(f"{url}?offset=0", headers=bearer(outside), data=b"x").status_code == 400
  assert (log_dir / "log.txt").read_text() == "hello\nworld\n"


# --- a batch's token only reaches its own batch ---------------------------------------------------------------------
OTHER_SHA = 'c' * 40


@pytest.fixture
def uploads_root(storage, monkeypatch):
  from backend import config
  root = storage / "uploads"
  root.mkdir()
  monkeypatch.setattr(config, "upload_root", root)
  return root


def refused(response):
  assert response.status_code == 403, (response.status_code, response.get_json())
  assert response.get_json()["reason"] == "batch_token_limited", response.get_json()
  assert "token of a batch QA-Board started" in response.get_json()["error"]
  return True


def start_run(client, secret, **extra):
  """What `qa run` sends when a run starts, without a shared storage: returns the response"""
  return client.post('/api/v1/output/', headers=bearer(secret), json=output_payload(storage="upload", is_pending=True, is_running=True, **extra))


def test_a_batch_token_is_refused_outside_of_its_batch(logged_in, make_client, uploads_root):
  alice = logged_in('alice', is_admin=True)
  personal = alice.post('/api/v1/user/tokens', json={"name": "t", "scopes": ["read", "ingest", "act"]}).get_json()["token"]
  _, secret = batch_token('alice', batch="tuning")
  client = make_client()
  # its own batch: runs, their files and progress, the batch, the commit
  mine = start_run(client, secret, batch_label="tuning")
  assert mine.status_code == 200, mine.get_json()
  mine = mine.get_json()["id"]
  assert client.put(f"/api/v1/output/{mine}/files/log.txt", headers=bearer(secret), data=b"x").status_code == 200
  assert client.patch(f"/api/v1/output/{mine}/progress", headers=bearer(secret), json={"metrics": {"loss": 1}}).status_code == 200
  assert client.post('/api/v1/batch/', headers=bearer(secret), json=commit_payload(batch_label="tuning")).status_code == 200
  assert client.post('/api/v1/commit/', headers=bearer(secret), json=commit_payload()).status_code == 200

  # batch B of the same commit, sent with a personal token
  theirs = start_run(client, personal, batch_label="nightly").get_json()["id"]
  assert refused(client.put(f"/api/v1/output/{theirs}/files/log.txt", headers=bearer(secret), data=b"stolen"))
  assert refused(client.patch(f"/api/v1/output/{theirs}/progress", headers=bearer(secret), json={"metrics": {"loss": 0}}))
  assert refused(start_run(client, secret, batch_label="nightly"))
  assert refused(client.post('/api/v1/batch/', headers=bearer(secret), json=commit_payload(batch_label="nightly")))
  assert client.put(f"/api/v1/output/{theirs}/files/log.txt", headers=bearer(personal), data=b"ok").status_code == 200
  # another commit
  assert refused(start_run(client, secret, batch_label="tuning", commit_sha=OTHER_SHA))
  assert refused(client.post('/api/v1/batch/', headers=bearer(secret), json=commit_payload(batch_label="tuning", commit_sha=OTHER_SHA)))
  assert refused(client.post('/api/v1/commit/', headers=bearer(secret), json=commit_payload(commit_sha=OTHER_SHA)))
  assert refused(client.post(f'/api/v1/commit/{OTHER_SHA}', headers=bearer(secret), json=commit_payload()))
  # artifacts: batches only fetch them
  url = f"/api/v1/commit/{SHA}/artifacts/files/qaboard.yaml?project={PROJECT}"
  assert refused(client.put(url, headers={**bearer(secret), "X-Content-SHA256": "0" * 64}, data=b"x"))
  # nor anything else that changes the project, even what the user could do
  assert refused(client.post('/api/v1/project/access/requests', headers=bearer(secret), json={"project": PROJECT, "role": "maintainer"}))
  assert refused(client.post('/api/v1/batch/stop', headers=bearer(secret), json={"id": 1}))
  # reading stays project-wide
  answer = client.get(f"/api/v1/commit/{OTHER_SHA}?project={PROJECT}", headers=bearer(secret))
  assert answer.status_code != 403, answer.get_json()


def test_nginx_asks_before_receiving_a_batch_tokens_files(logged_in, make_client, uploads_root):
  alice = logged_in('alice', is_admin=True)
  personal = alice.post('/api/v1/user/tokens', json={"name": "t", "scopes": ["read", "ingest", "act"]}).get_json()["token"]
  _, secret = batch_token('alice', batch="tuning")
  client = make_client()
  mine = start_run(client, secret, batch_label="tuning").get_json()["id"]
  theirs = start_run(client, personal, batch_label="nightly").get_json()["id"]
  ask = lambda token, uri: client.put('/api/v1/uploads/authorize', headers=bearer(token), environ_base={"QABOARD_ORIGINAL_URI": uri})
  assert ask(secret, f"/api/v1/output/{mine}/files/log.txt?offset=0").status_code == 204
  assert refused(ask(secret, f"/api/v1/output/{theirs}/files/log.txt"))
  assert refused(ask(secret, f"/api/v1/commit/{SHA}/artifacts/files/a.txt?project={PROJECT}"))
  assert ask(personal, f"/api/v1/commit/{SHA}/artifacts/files/a.txt?project={PROJECT}").status_code == 204


def test_qa_optimize_sends_its_iterations(logged_in, make_client, uploads_root):
  """`qa optimize` runs each evaluation in a batch "<label>|iter<N>", with the same token, then updates its batch"""
  logged_in('alice', is_admin=True)
  _, secret = batch_token('alice', batch="tuning", optimize=True, until_stopped=True)
  client = make_client()
  for iteration in (1, 2):
    run = start_run(client, secret, batch_label=f"tuning|iter{iteration}", data={"root_command_id": f"iteration-{iteration}"})
    assert run.status_code == 200, run.get_json()
  answer = client.post('/api/v1/batch/', headers=bearer(secret), json=commit_payload(batch_label="tuning", data={
    "optimization": True, "iteration": 2, "is_best_iter": True, "iteration_label": "tuning|iter2"}))
  assert answer.status_code == 200, answer.get_json()
  assert refused(start_run(client, secret, batch_label="tuning|other"))
  assert refused(start_run(client, secret, batch_label="other|iter1"))
  # tokens of other batches can't send iterations
  _, tuning = batch_token('alice', command_id="66666666-6666-4666-8666-666666666666", batch="tuning")
  assert refused(start_run(client, tuning, batch_label="tuning|iter3"))


def test_a_redo_runs_pending_runs_of_another_command(logged_in, make_client, uploads_root):
  """Redone runs that were pending keep the command id of the `qa batch` that registered them: the batch decides"""
  alice = logged_in('alice', is_admin=True)
  personal = alice.post('/api/v1/user/tokens', json={"name": "t", "scopes": ["read", "ingest", "act"]}).get_json()["token"]
  client = make_client()
  first_command = "77777777-7777-4777-8777-777777777777"
  pending = client.post('/api/v1/output/', headers=bearer(personal), json=output_payload(
    storage="upload", is_pending=True, data={"root_command_id": first_command})).get_json()["id"]
  # the redo's token, for the batch of the runs it does again
  _, secret = batch_token('alice', batch="default", until_stopped=True)
  run = start_run(client, secret, data={"root_command_id": first_command})
  assert run.status_code == 200 and run.get_json()["id"] == pending
  assert client.put(f"/api/v1/output/{pending}/files/log.txt", headers=bearer(secret), data=b"x").status_code == 200
  done = client.post('/api/v1/output/', headers=bearer(secret), json=output_payload(storage="upload", data={"root_command_id": first_command}))
  assert done.status_code == 200, done.get_json()


def test_batch_tokens_that_dont_say_their_batch_send_nothing(logged_in, make_client):
  logged_in('alice', is_admin=True)
  from backend.database import db_session
  from backend.models import Token
  token_id, secret = batch_token('alice')
  token = db_session.get(Token, token_id)
  token.data = {"command_id": COMMAND_ID}
  db_session.commit()
  assert refused(make_client().post('/api/v1/output/', headers=bearer(secret), json=output_payload()))


# --- a batch's token never changes what's commit- or project-wide ----------------------------------------------------
def project_and_commits():
  from backend.database import db_session
  from backend.models import Project, CiCommit
  db_session.expire_all()
  project = Project.query.filter(Project.id == PROJECT).one()
  return project, {c.hexsha: c for c in CiCommit.query.filter(CiCommit.project_id.startswith(PROJECT)).all()}


def test_a_batch_token_sends_exactly_its_commit(logged_in, make_client):
  """Commits are looked up case-sensitively and by prefix: another spelling of its id would create another commit"""
  logged_in('alice', is_admin=True)
  _, secret = batch_token('alice', batch="tuning")
  config_before = project_and_commits()[0].data.get('qatools_config')
  evil = {"project": {"name": PROJECT, "reference_branch": "master"}, "evil": True}
  client = make_client()
  for hexsha in (SHA.upper(), SHA[:8], f"{SHA}0"):
    assert refused(client.post('/api/v1/output/', headers=bearer(secret), json=output_payload(batch_label="tuning", commit_sha=hexsha, qaboard_config=evil)))
    assert refused(client.post('/api/v1/batch/', headers=bearer(secret), json=commit_payload(batch_label="tuning", commit_sha=hexsha, qaboard_config=evil)))
    assert refused(client.post('/api/v1/commit/', headers=bearer(secret), json=commit_payload(commit_sha=hexsha, qaboard_config=evil)))
  project, commits = project_and_commits()
  assert list(commits) == [SHA]
  assert project.data.get('qatools_config') == config_before


def test_a_batch_token_creates_no_commits_nor_projects(logged_in, make_client):
  """A batch can run its sub-projects' runs (a monorepo's batch), on their commits: it doesn't create them"""
  from backend.database import db_session
  from backend.models import Project
  logged_in('alice', is_admin=True)
  _, secret = batch_token('alice', batch="tuning")
  client = make_client()
  sub = f"{PROJECT}/sub"
  answer = client.post('/api/v1/output/', headers=bearer(secret), json=output_payload(project=sub, batch_label="tuning"))
  assert answer.status_code == 404 and "batch tokens don't create commits" in answer.get_json()["error"]
  assert client.post('/api/v1/batch/', headers=bearer(secret), json=commit_payload(project=sub, batch_label="tuning")).status_code == 404
  assert client.post('/api/v1/commit/', headers=bearer(secret), json=commit_payload(project=sub)).status_code == 404
  db_session.expire_all()
  assert Project.query.filter(Project.id == sub).one_or_none() is None
  # once the sub-project's commit exists (e.g. its CI saved its artifacts)
  known_commit(project=sub)
  answer = client.post('/api/v1/output/', headers=bearer(secret), json=output_payload(project=sub, batch_label="tuning"))
  assert answer.status_code == 200, answer.get_json()


def test_a_batch_token_doesnt_change_its_commit(logged_in, make_client, storage):
  logged_in('alice', is_admin=True)
  from backend.database import db_session
  _, secret = batch_token('alice', batch="tuning")
  _, commits = project_and_commits()
  commit = commits[SHA]
  commit.deleted = True
  commit.commit_dir_override = None
  commit.data = {**commit.data, "qatools_config": {"project": {"name": PROJECT}, "mine": True}}
  db_session.commit()
  client = make_client()
  # the commit's metadata, whether its artifacts are usable, who sent it
  answer = client.post('/api/v1/commit/', headers=bearer(secret), json=commit_payload(
    data={"qatools_config": {"x": 1}, "deleted": False, "submitted_by": "x", "metrics": 1}))
  assert answer.status_code == 200 and "nothing was saved" in answer.get_json()["warning"]
  # where its artifacts are, its configuration
  elsewhere = storage / "elsewhere"
  elsewhere.mkdir()
  answer = client.post('/api/v1/output/', headers=bearer(secret), json=output_payload(
    batch_label="tuning", artifacts_commit=str(elsewhere), qaboard_config={"project": {"name": PROJECT}, "theirs": True}))
  assert answer.status_code == 200, answer.get_json()
  answer = client.post('/api/v1/batch/', headers=bearer(secret), json=commit_payload(batch_label="tuning", qaboard_config={"theirs": True}))
  assert answer.status_code == 200, answer.get_json()
  _, commits = project_and_commits()
  commit = commits[SHA]
  assert commit.deleted and commit.commit_dir_override is None
  assert commit.data["qatools_config"] == {"project": {"name": PROJECT}, "mine": True}
  assert "metrics" not in commit.data and "submitted_by" not in commit.data


def test_a_batch_token_doesnt_change_the_projects_metrics(logged_in, make_client):
  """Runs declare metrics in code: a batch token saves them in its commit, in the project only for the reference branch"""
  logged_in('alice', is_admin=True)
  from backend.database import db_session
  _, secret = batch_token('alice', batch="tuning")
  project, commits = project_and_commits()
  project.data = {**project.data, "qatools_config": {"project": {"name": PROJECT, "reference_branch": "master"}}, "metrics_definitions": {"loss": {"label": "Loss"}}}
  commits[SHA].branch = "feature"
  db_session.commit()
  definitions = {"loss": {"label": "Hacked"}}
  # the run says its commit is on the reference branch
  answer = make_client().post('/api/v1/output/', headers=bearer(secret), json=output_payload(
    batch_label="tuning", commit_branch="master", metrics_definitions=definitions))
  assert answer.status_code == 200, answer.get_json()
  project, commits = project_and_commits()
  assert project.data["metrics_definitions"] == {"loss": {"label": "Loss"}}
  assert commits[SHA].data["metrics_definitions"]["loss"]["label"] == "Hacked"


def test_a_batch_token_only_starts_its_projects_jenkins_jobs(logged_in, make_client, monkeypatch):
  """The windows runner starts runs with Jenkins builds: only the jobs the commit's or project's qaboard.yaml lists"""
  import backend.api.integrations as integrations
  from backend.database import db_session
  logged_in('alice', is_admin=True)
  started = []
  monkeypatch.setattr(integrations, "trigger_jenkins_build", lambda data, **kwargs: started.append(data["build_url"]) or {"url": "ok"})
  _, secret = batch_token('alice', batch="tuning")
  job = "https://jenkins.example.com/job/windows-runner"
  _, commits = project_and_commits()
  commits[SHA].data = {**commits[SHA].data, "qatools_config": {"runners": {"jenkins": {"build_url": job}}}}
  db_session.commit()
  client = make_client()
  trigger = lambda **data: client.post('/api/v1/jenkins/build/trigger', headers=bearer(secret), json=data)
  assert refused(trigger(build_url=job))
  assert refused(trigger(build_url=job, project=PROJECT))
  assert refused(trigger(build_url=job, project=PROJECT, commit="f" * 40))
  assert refused(trigger(build_url=job, project="group/other", commit=SHA))
  assert refused(trigger(build_url="https://jenkins.example.com/job/deploy", project=PROJECT, commit=SHA))
  # a batch's qaboard.yaml is what its token sent
  answer = make_client().post('/api/v1/batch/', headers=bearer(secret), json=commit_payload(batch_label="tuning", qaboard_config={
    "runners": {"jenkins": {"build_url": "https://jenkins.example.com/job/deploy"}}}))
  assert answer.status_code == 200
  assert refused(trigger(build_url="https://jenkins.example.com/job/deploy", project=PROJECT, commit=SHA))
  assert started == []
  answer = trigger(build_url=job, project=PROJECT, commit=SHA)
  assert answer.status_code == 200, answer.get_json()
  assert started == [job]
