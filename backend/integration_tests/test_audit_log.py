"""
Reading the audit log (api/audit_log.py): what actions mean, projects' history for their members, filters, exports,
and the JSON lines QABOARD_AUDIT_STDOUT prints.
"""
import csv
import io
import json
import datetime

from .test_access import team, ingest, PROJECT  # noqa: F401 (fixture)


def history(client, query=''):
  return client.get(f'/api/v1/project/audit?project={PROJECT}{"&" + query if query else ""}')


def test_actions_registry(team):
  answer = team['carol'].get('/api/v1/audit/actions').get_json()
  assert answer["actions"]["batch.delete"] == {"label": "Deleted a batch", "category": "runs", "project": True}
  assert answer["actions"]["auth.login"]["project"] is False
  assert answer["categories"]["runs"]["icon"]
  assert all(a["category"] in answer["categories"] for a in answer["actions"].values())


def test_project_history_for_developers(team):
  # alice made it private, root gave the roles: visibility.update and grant.create are about the project
  events = history(team['bob']).get_json()["events"]
  actions = [e["action"] for e in events]
  assert "visibility.update" in actions and actions.count("grant.create") == 3
  # without where requests come from
  assert all("ip" not in e and "user_agent" not in e for e in events)
  # admins see them in the admin panel
  assert all("ip" in e for e in team['root'].get(f'/api/v1/admin/audit?project={PROJECT}').get_json()["events"])


def test_project_history_needs_the_developer_role(team, client):
  assert history(team['carol']).status_code == 403
  assert history(team['dave']).status_code in (403, 404)
  assert history(client).status_code == 401
  assert history(team['alice']).status_code == 200
  assert history(team['root']).status_code == 200
  assert team['bob'].get('/api/v1/project/audit').status_code == 400


def test_project_history_has_only_project_actions_of_the_project_and_subprojects(team):
  from backend.audit import system_audit
  from backend.database import db_session
  system_audit('batch.delete', target_type='batch', target_id=1, target_label='sub', project_id=f'{PROJECT}/sub')
  system_audit('batch.delete', target_type='batch', target_id=2, target_label='other', project_id=f'{PROJECT}-other')
  # not a project action, even with a project
  system_audit('storage.delete', target_type='job', target_id=3, target_label='job', project_id=PROJECT)
  db_session.commit()
  events = history(team['bob'], 'action=batch').get_json()["events"]
  assert [e["target_label"] for e in events] == ["sub"]
  assert not [e for e in history(team['bob']).get_json()["events"] if e["action"] == "storage.delete"]


def test_filters_by_category_actor_and_dates(team):
  root = team['root']
  def actions(query):
    response = root.get(f'/api/v1/admin/audit?{query}')
    assert response.status_code == 200, response.get_json()
    return [e["action"] for e in response.get_json()["events"]]
  assert set(actions('category=access')) == {"grant.create", "visibility.update"}
  # part of the name, any case
  assert set(actions('actor=ALI')) == set(actions('actor=alice')) and "visibility.update" in actions('actor=ali')
  today = datetime.datetime.now(datetime.timezone.utc).date()
  assert actions(f'since={today}') == actions('')
  assert actions(f'until={today}') == actions('')
  assert actions(f'until={today - datetime.timedelta(days=1)}') == []
  assert actions(f'since={today + datetime.timedelta(days=1)}') == []
  assert actions(f'since={today}T00:00:00Z&until={today + datetime.timedelta(days=1)}T00:00:00%2B00:00') == actions('')
  assert root.get('/api/v1/admin/audit?since=yesterday').status_code == 400


def test_exports(team):
  root = team['root']
  response = root.get('/api/v1/admin/audit?format=csv&category=access')
  assert response.status_code == 200 and response.mimetype == 'text/csv'
  assert 'attachment' in response.headers['Content-Disposition']
  rows = list(csv.DictReader(io.StringIO(response.get_data(as_text=True))))
  assert {r["action"] for r in rows} == {"grant.create", "visibility.update"}
  assert json.loads(rows[0]["meta"]) is not None and "ip" in rows[0]

  response = history(team['bob'], 'format=jsonl')
  assert response.status_code == 200
  lines = [json.loads(line) for line in response.get_data(as_text=True).splitlines()]
  assert {"visibility.update", "grant.create"} <= {line["action"] for line in lines}
  assert all("ip" not in line for line in lines)
  assert root.get('/api/v1/admin/audit?format=xml').status_code == 400


def test_unknown_actions_fail_in_tests(team):
  import pytest
  from backend.audit import system_audit
  with pytest.raises(ValueError, match="audit_actions.py"):
    system_audit('nothing.happened')


def test_committed_events_on_stdout(team, monkeypatch, capsys):
  from sqlalchemy import event
  from sqlalchemy.orm import Session
  from backend import audit as audit_lib
  from backend.database import db_session
  monkeypatch.setattr(audit_lib, 'to_stdout', True)
  audit_lib.install_stdout()
  try:
    capsys.readouterr()
    audit_lib.system_audit('batch.delete', target_type='batch', target_id=7, target_label='rolled back', project_id=PROJECT)
    db_session.flush()
    db_session.rollback()
    audit_lib.system_audit('batch.delete', target_type='batch', target_id=8, target_label='kept', project_id=PROJECT)
    db_session.commit()
    lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith('qaboard-audit ')]
    assert len(lines) == 1
    printed = json.loads(lines[0][len('qaboard-audit '):])
    assert printed["target_label"] == "kept" and printed["action"] == "batch.delete" and printed["id"] and printed["created_at"]
  finally:
    for name, fn in [('after_flush', audit_lib.remember_flushed), ('after_commit', audit_lib.print_committed), ('after_rollback', audit_lib.forget_flushed)]:
      event.remove(Session, name, fn)
