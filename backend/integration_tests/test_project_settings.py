"""A project's settings, from its Admin pages (docs/rfcs/project-admin.md): the quality gate's project rules"""
from .test_access import team, ingest, PROJECT, SHA  # noqa: F401 (fixtures)

GATE = {"rules": [{"metric": "loss", "max_regression": "5%"}, {"metric": "loss", "max": 2, "aggregate": "max"}],
        "max_failed_runs": 0, "require_bit_accuracy": False, "on_looser_rules": "fail"}


def settings(client):
  response = client.get(f'/api/v1/project/settings?project={PROJECT}')
  assert response.status_code == 200, response.get_json()
  return response.get_json()


def save(client, gate, project=PROJECT):
  return client.post('/api/v1/project/settings/gate', json={"project": project, "gate": gate})


def test_owners_set_the_projects_gate(team):
  # nothing yet: viewers see that, and can't change it
  before = settings(team['carol'])
  assert (before["gate"], before["gate_updated"], before["can_manage"]) == (None, None, False)
  assert save(team['bob'], GATE).status_code == 403

  response = save(team['alice'], GATE)
  assert response.status_code == 200, response.get_json()
  saved = response.get_json()
  assert saved["gate"] == GATE and saved["can_manage"] is True
  assert saved["gate_updated"]["by"] == 'alice' and saved["gate_updated"]["at"].endswith('Z')
  # everyone who sees the project sees the rules it's held to
  assert settings(team['carol'])["gate"] == GATE

  # `qa gate` gets them with the numbers it compares
  compare = team['bob'].get(f'/api/v1/commit/{SHA}/compare?project={PROJECT}').get_json()
  assert compare["project_gate"] == GATE

  # admins are owners of every project; removing the settings
  assert save(team['root'], None).status_code == 200
  assert settings(team['alice'])["gate"] is None
  assert team['bob'].get(f'/api/v1/commit/{SHA}/compare?project={PROJECT}').get_json()["project_gate"] is None


def test_settings_are_validated_like_qaboard_yaml(team):
  alice = team['alice']
  for gate, message in [
    ({"rules": [{"metric": "loss"}]}, "gate.rules[0]: give a limit for loss"),
    ({"rules": [{"metric": "loss", "max_regression": "lots"}]}, "expected a percentage like 5%"),
    ({"rules": [], "reference": "main"}, "gate: unknown keys reference"),
    ({"rules": [], "on_looser_rules": "maybe"}, "gate.on_looser_rules: expected one of warn, fail"),
    ({"rules": [], "max_failed_runs": -1}, "gate.max_failed_runs"),
    ("rules", "gate: expected an object"),
  ]:
    response = save(alice, gate)
    assert response.status_code == 400, (gate, response.get_json())
    assert message in response.get_json()["error"], response.get_json()
  assert alice.post('/api/v1/project/settings/gate', json={"project": PROJECT}).status_code == 400
  assert settings(alice)["gate"] is None
  # defaults: no limit on failed runs from the project, and looser rules are only reported
  saved = save(alice, {"rules": [{"metric": "loss", "min": 0}]}).get_json()["gate"]
  assert saved == {"rules": [{"metric": "loss", "min": 0}], "max_failed_runs": None, "require_bit_accuracy": False, "on_looser_rules": "warn"}


def test_the_page_shows_the_rules_of_qaboard_yaml(team, client):
  """What commits are checked against unless they change it: the gate of the reference branch's configuration"""
  reference = settings(team['alice'])["reference"]
  assert (reference["exists"], reference["has_config"], reference["rules"]) == (True, False, [])
  config = {"project": {"name": PROJECT, "reference_branch": "main"},
            "gate": {"rules": [{"metric": "loss", "max_regression": "10%", "per_test_max_regression": "25%"}], "max_failed_runs": 2}}
  assert ingest(team['bob'], commit_sha="d" * 40, commit_branch="main", qaboard_config=config).status_code == 200
  reference = settings(team['carol'])["reference"]
  assert (reference["branch"], reference["has_gate"], reference["max_failed_runs"], reference["error"]) == ("main", True, 2, None)
  assert reference["rules"] == [
    {"metric": "loss", "kind": "max_regression", "limit": 0.1, "aggregate": "median", "batch": None, "label": None},
    {"metric": "loss", "kind": "per_test_max_regression", "limit": 0.25, "aggregate": None, "batch": None, "label": None},
  ]


def test_rules_for_some_batches(team):
  """docs/rfcs/gate-scopes-and-comments.md: project rules on the runs of some `qa batch`, and the batches to wait for"""
  alice, bob = team['alice'], team['bob']
  gate = {"rules": [{"metric": "loss", "max_regression": "5%", "batch": "perf"}, {"metric": "loss", "max": 2, "label": ["nightly"]}],
          "max_failed_runs": None, "require_bit_accuracy": False, "expect_batches": {"default": ["ci", "perf"]}, "on_looser_rules": "warn"}
  response = save(alice, gate)
  assert response.status_code == 200, response.get_json()
  assert response.get_json()["gate"] == gate
  assert save(alice, {**gate, "expect_batches": {"default": [1.5]}}).status_code == 400
  # `qa gate` gets them, and which batch each run comes from
  assert ingest(bob, rel_input_path="inputs/b.txt", batch="perf").status_code == 200
  compare = bob.get(f'/api/v1/commit/{SHA}/compare?project={PROJECT}').get_json()
  assert compare["project_gate"] == gate
  batches = {t["test_input_path"]: t["batch"] for t in compare["tests"]}
  assert batches == {"inputs/a.txt": None, "inputs/b.txt": "perf"}


def test_changes_are_audited(team):
  alice = team['alice']
  assert save(alice, GATE).status_code == 200
  assert save(alice, {**GATE, "on_looser_rules": "warn"}).status_code == 200
  # saving the same settings is not a change
  assert save(alice, {**GATE, "on_looser_rules": "warn"}).status_code == 200
  events = team['root'].get(f'/api/v1/admin/audit?project={PROJECT}').get_json()["events"]
  events = [e for e in events if e["action"] == 'project_settings.update']
  assert len(events) == 2
  latest = max(events, key=lambda e: e["id"])
  assert latest["changes"] == {"on_looser_rules": {"from": "fail", "to": "warn"}}
