"""
Tests for backend/runner_jobs.py: stopping batches with validated options, and starting `qa batch` on Kubernetes.
The kubernetes runner is replaced by a fake that records what it's asked (qaboard.runners.runners['kubernetes']).
"""
import os
import uuid
from types import SimpleNamespace
from unittest import mock

import pytest

import backend.runner_jobs as runner_jobs
from backend.runner_jobs import NotAllowed

# command ids, like qa batch's
ID1, ID2, ID3, ID4, ID5 = (str(uuid.UUID(int=i)) for i in range(1, 6))
DRIVER_ID = "0123abcd-0000-4000-8000-000000000000"


class FakeRunner:
  """Records the calls the server makes to a runner"""
  type = "fake"
  stopped: list = []
  submitted: list = []
  fail_with = None
  stop_fails_with = None
  deleted = None # what stop_jobs returns, e.g. how many Kubernetes Jobs it deleted

  @classmethod
  def stop_jobs(cls, jobs, job_options):
    if cls.stop_fails_with:
      raise cls.stop_fails_with
    cls.stopped.append(job_options)
    return cls.deleted

  @classmethod
  def submit_detached(cls, script, name, log_file, job_options):
    if cls.fail_with:
      raise cls.fail_with
    cls.submitted.append({"script": script, "name": name, "log_file": log_file, "job_options": job_options})
    return {"kubernetes_job": name, "namespace": job_options["namespace"]}


class NotFound(Exception):
  status = 404


@pytest.fixture
def fake_runners(monkeypatch):
  """The kubernetes and LSF runners are fakes, and the admins allow the algo-qa and algo-gpu namespaces"""
  from qaboard.runners import runners
  FakeRunner.stopped, FakeRunner.submitted, FakeRunner.fail_with, FakeRunner.stop_fails_with, FakeRunner.deleted = [], [], None, None, None
  monkeypatch.setenv("QABOARD_KUBERNETES_NAMESPACES", "algo-qa, algo-gpu")
  for name in ("QABOARD_KUBERNETES_CONTEXTS", "QABOARD_KUBERNETES_SERVICE_ACCOUNT", "QABOARD_KUBERNETES_SERVER_URL",
               "QABOARD_KUBERNETES_ALLOW_HOST_PATH", "QABOARD_KUBERNETES_DRIVER_RESOURCES", "QABOARD_HOST", "QABOARD_PROTOCOL",
               "QABOARD_KUBERNETES_RUN_AS", "QABOARD_KUBERNETES_MIN_UID", "QABOARD_KUBERNETES_TRUST_LOCAL_ACCOUNTS",
               "QABOARD_KUBERNETES_ALLOW_RUN_AS_IMAGE", "QA_RUNNERS_LSF_BRIDGE", "QABOARD_DASK_SCHEDULERS"):
    monkeypatch.delenv(name, raising=False)
  with mock.patch.dict(runners, {"kubernetes": FakeRunner, "lsf": FakeRunner, "dask": FakeRunner}):
    yield FakeRunner


# ==========================================
# Validation
# ==========================================

def test_namespaces_must_be_allowed(monkeypatch):
  monkeypatch.delenv("QABOARD_KUBERNETES_NAMESPACES", raising=False)
  with pytest.raises(NotAllowed, match="QABOARD_KUBERNETES_NAMESPACES"):
    runner_jobs.allowed_namespace("algo-qa")
  monkeypatch.setenv("QABOARD_KUBERNETES_NAMESPACES", "algo-qa,algo-gpu")
  assert runner_jobs.allowed_namespace("algo-qa") == "algo-qa"
  with pytest.raises(NotAllowed, match="only in: algo-qa, algo-gpu"):
    runner_jobs.allowed_namespace("kube-system")
  with pytest.raises(NotAllowed, match="doesn't know in which Kubernetes namespace"):
    runner_jobs.allowed_namespace(None)
  for invalid in ("", "Algo", "algo;id", "-algo", "a" * 64, ["algo-qa"], {"x": 1}):
    with pytest.raises(NotAllowed):
      runner_jobs.allowed_namespace(invalid)
  # even when the admins made a mistake
  monkeypatch.setenv("QABOARD_KUBERNETES_NAMESPACES", "Algo QA")
  with pytest.raises(NotAllowed, match="Invalid"):
    runner_jobs.allowed_namespace("Algo QA")


def test_contexts_must_be_allowed(monkeypatch):
  monkeypatch.delenv("QABOARD_KUBERNETES_CONTEXTS", raising=False)
  assert runner_jobs.allowed_context("prod") is None
  monkeypatch.setenv("QABOARD_KUBERNETES_CONTEXTS", "prod,dev")
  assert runner_jobs.allowed_context("prod") == "prod"
  assert runner_jobs.allowed_context("other") is None
  assert runner_jobs.allowed_context(["prod"]) is None


def test_names():
  assert runner_jobs.is_dns1123_label("algo-qa")
  assert not runner_jobs.is_dns1123_label("algo.qa")
  assert runner_jobs.is_dns1123_subdomain("registry.creds")
  assert not runner_jobs.is_dns1123_subdomain("registry_creds")
  assert runner_jobs.is_label_value("Algo_GPU.q")
  assert not runner_jobs.is_label_value("gpu queue")
  assert runner_jobs.is_command_id(str(uuid.uuid4()))
  for invalid in ("abc", str(uuid.uuid4()).upper(), "0123abcd-0000-4000-8000-0000000000001", f"{uuid.uuid4()}\n", None, 1):
    assert not runner_jobs.is_command_id(invalid)


def test_label_values():
  """The runners and the server sanitize label values the same way"""
  from qaboard.runners.labels import label_value
  assert label_value("algo-project") == "algo-project"
  assert label_value("") == ""
  assert label_value(None) == ""
  sanitized = label_value("algo/project")
  assert sanitized.startswith("algo-project-") and len(sanitized) == len("algo-project-") + 8
  # different values stay different
  assert label_value("algo/project") != label_value("algo-project") != label_value("algo.project/")
  for value in ("algo/project", "-x-", "a" * 64, "a/" * 40, "/", "été", "x" * 54 + "/"):
    sanitized = label_value(value)
    assert runner_jobs.is_label_value(sanitized), (value, sanitized)
    assert label_value(value) == sanitized


# ==========================================
# Stopping
# ==========================================

def test_stop_options_of_other_runners_are_unchanged(fake_runners, monkeypatch):
  assert runner_jobs.stop_job_options(ID1, {"runner": "lsf", "user": "arthurf", "queue": "evil;id"}, "algo/project") == {
    "type": "lsf", "command_id": ID1, "bridge": "", "user": "arthurf",
  }
  monkeypatch.setenv("QA_RUNNERS_LSF_BRIDGE", "ssh host bsub_su {user} {bsub_command}")
  monkeypatch.setenv("QABOARD_DASK_SCHEDULERS", "tcp://trusted:8786")
  assert runner_jobs.stop_job_options(ID1, {"runner": "dask", "scheduler_address": "tcp://trusted:8786"}) == {
    "type": "dask", "command_id": ID1, "bridge": "ssh host bsub_su {user} {bsub_command}", "scheduler_address": "tcp://trusted:8786",
    "api_retry_seconds": 15,
  }
  assert "scheduler_address" not in runner_jobs.stop_job_options(ID1, {"runner": "dask", "scheduler_address": "tcp://attacker:8786"})
  for runner in ("local", "celery"):
    assert runner_jobs.stop_job_options(ID1, {"runner": runner}) == {"type": runner, "command_id": ID1, "bridge": "ssh host bsub_su {user} {bsub_command}"}
  for command_id, command in [(ID1, {"runner": "windows"}), (ID1, {"runner": "evil"}), ("a;b", {"runner": "lsf"}),
                              ("abc", {"runner": "lsf"}), (ID1, {"runner": "lsf", "user": "$(id)"}), (ID1, None)]:
    with pytest.raises(ValueError):
      runner_jobs.stop_job_options(command_id, command)


def test_stop_options_of_kubernetes(fake_runners, monkeypatch):
  command = {"runner": "kubernetes", "namespace": "algo-gpu", "context": "laptop", "user": "arthurf", "image": "evil", "run_as": "root", "project": "other"}
  # unknown contexts: the server's default cluster. Only the batch's project, as the server knows it
  assert runner_jobs.stop_job_options(ID1, command, "algo/project") == {
    "type": "kubernetes", "command_id": ID1, "bridge": "", "user": "arthurf", "namespace": "algo-gpu", "project": "algo/project",
    # the server doesn't wait 5 minutes for the Kubernetes API
    "api_retry_seconds": 15,
  }
  monkeypatch.setenv("QABOARD_KUBERNETES_CONTEXTS", "laptop")
  assert runner_jobs.stop_job_options(ID1, command)["context"] == "laptop"
  for namespace in ("kube-system", None, "algo-qa --all", 7):
    with pytest.raises(NotAllowed):
      runner_jobs.stop_job_options(ID1, {**command, "namespace": namespace})
  with pytest.raises(ValueError):
    runner_jobs.stop_job_options("qa-*", command)
  monkeypatch.delenv("QABOARD_KUBERNETES_NAMESPACES")
  with pytest.raises(NotAllowed, match="QABOARD_KUBERNETES_NAMESPACES"):
    runner_jobs.stop_job_options(ID1, command)


def test_stop_options_of_dask_clusters(fake_runners):
  assert runner_jobs.stop_job_options(ID1, {"runner": "dask", "cluster_type": "slurm"})["cluster_type"] == "slurm"
  command = {"runner": "dask", "cluster_type": "kubernetes", "kubernetes": {"namespace": "algo-qa", "context": "laptop", "image": "evil"}}
  assert runner_jobs.stop_job_options(ID1, command, "algo/project") == {
    "type": "dask", "command_id": ID1, "bridge": "", "cluster_type": "kubernetes", "kubernetes": {"namespace": "algo-qa", "project": "algo/project"},
    "api_retry_seconds": 15,
  }
  for kubernetes in ({"namespace": "kube-system"}, {"namespace": None}, {}, "algo-qa", None):
    with pytest.raises(NotAllowed):
      runner_jobs.stop_job_options(ID1, {**command, "kubernetes": kubernetes})
  with pytest.raises(ValueError):
    runner_jobs.stop_job_options(ID1, {"runner": "dask", "cluster_type": "evil"})
  # before qa sent it: LSF
  assert "cluster_type" not in runner_jobs.stop_job_options(ID1, {"runner": "dask"})


def test_the_dask_runner_stops_kubernetes_clusters_with_these_options(monkeypatch):
  """The real DaskRunner.stop_jobs, with what the server forwards"""
  import qaboard.runners.dask_runner as dask_runner
  from qaboard.runners.job import JobGroup
  monkeypatch.setenv("QABOARD_KUBERNETES_NAMESPACES", "algo-qa")
  monkeypatch.setenv("QABOARD_KUBERNETES_CONTEXTS", "laptop")
  calls = []
  monkeypatch.setattr(dask_runner, "stop_kubernetes", lambda *args: calls.append(args))
  command = {"runner": "dask", "cluster_type": "kubernetes", "kubernetes": {"namespace": "algo-qa", "context": "laptop"}}
  JobGroup(job_options=runner_jobs.stop_job_options(ID1, command, "algo/project")).stop()
  [(command_id, k8s, namespace)] = calls
  assert command_id == ID1
  # only the batch's project, in a namespace and context the server may use, and the server doesn't wait minutes
  assert k8s == {"namespace": "algo-qa", "context": "laptop", "project": "algo/project", "api_retry_seconds": 15}


def test_stop_batch_jobs(fake_runners):
  data = {"commands": {
    ID1: {"runner": "lsf"},
    ID2: {"runner": "kubernetes", "namespace": "algo-qa"},
    ID3: {"runner": "kubernetes", "namespace": "kube-system"},
    ID4: {"runner": "windows"},
    "not-a-uuid": {"runner": "lsf"},
  }}
  assert runner_jobs.stop_batch_jobs(data, has_pending_runs=False) is None
  assert fake_runners.stopped == []
  stopped = runner_jobs.stop_batch_jobs(data, has_pending_runs=True, project_id="algo/project")
  assert [(o["type"], o["command_id"], o.get("project")) for o in fake_runners.stopped] == [("lsf", ID1, None), ("kubernetes", ID2, "algo/project")]
  # what we won't stop doesn't keep users from stopping the batch
  assert stopped["errors"] == [] and stopped["stopped_drivers"] == []
  assert len(stopped["warnings"]) == 3
  assert "kube-system" in stopped["warnings"][0]


def test_stop_batch_jobs_warns_when_no_kubernetes_job_was_found(fake_runners):
  """e.g. the runs are in another cluster than the server's: they may still run"""
  fake_runners.deleted = 0
  stopped = runner_jobs.stop_batch_jobs({"commands": {ID2: {"runner": "kubernetes", "namespace": "algo-qa"}}}, True, project_id="algo/project")
  assert stopped["errors"] == []
  assert "No Kubernetes job" in stopped["warnings"][0] and "algo-qa" in stopped["warnings"][0]
  fake_runners.deleted = 2
  assert runner_jobs.stop_batch_jobs({"commands": {ID2: {"runner": "kubernetes", "namespace": "algo-qa"}}}, True)["warnings"] == []
  # only exactly 0 means none: not None (runners that don't count), nor False
  for deleted in (None, False):
    fake_runners.deleted = deleted
    assert runner_jobs.stop_batch_jobs({"commands": {ID2: {"runner": "kubernetes", "namespace": "algo-qa"}}}, True)["warnings"] == []
  # other runners never get it
  fake_runners.deleted = 0
  assert runner_jobs.stop_batch_jobs({"commands": {ID1: {"runner": "lsf"}}}, True)["warnings"] == []


def test_server_requests_dont_wait_minutes_for_the_kubernetes_api(fake_runners, account, tmp_path):
  """The kubernetes runner retries API calls for 5 minutes by default: the server asks for 15s, to stop and to start"""
  data = {
    "commands": {
      ID1: {"runner": "kubernetes", "namespace": "algo-qa"},
      ID2: {"runner": "dask", "cluster_type": "kubernetes", "kubernetes": {"namespace": "algo-qa"}},
      ID3: {"runner": "lsf"},
    },
    "submissions": {ID4: {"id": ID4, "runner": "kubernetes", "status": "submitted", "kubernetes_job": "x", "namespace": "algo-gpu"}},
  }
  runner_jobs.stop_batch_jobs(data, True, project_id="algo/project")
  retries = {(o["type"], o["command_id"]): o.get("api_retry_seconds") for o in fake_runners.stopped}
  assert retries == {("kubernetes", ID1): 15, ("dask", ID2): 15, ("lsf", ID3): None, ("kubernetes", ID4): 15}

  script = tmp_path / "script.sh"
  script.write_text("#!/bin/bash\nqa batch\n")
  ci_commit = SimpleNamespace(project_id="algo/project", data={}, project=SimpleNamespace(data={}))
  runner_jobs.submit_driver(script, tmp_path, ARTHUR, ci_commit, DRIVER_ID)
  assert fake_runners.submitted[-1]["job_options"]["api_retry_seconds"] == 15
  # and when it cleans up after a failure
  fake_runners.stopped.clear()
  fake_runners.fail_with = RuntimeError("the API is down")
  with pytest.raises(RuntimeError):
    runner_jobs.submit_driver(script, tmp_path, ARTHUR, ci_commit, DRIVER_ID)
  assert fake_runners.stopped[-1]["api_retry_seconds"] == 15


def test_injected_commands_dont_keep_lsf_batches_from_stopping(fake_runners, monkeypatch):
  """A client wrote a kubernetes command in the batch: its LSF jobs are stopped as before"""
  monkeypatch.delenv("QABOARD_KUBERNETES_NAMESPACES")
  stopped = runner_jobs.stop_batch_jobs({"commands": {ID1: {"runner": "lsf", "user": "arthurf"}, ID2: {"runner": "kubernetes", "namespace": "algo-qa"}}}, True)
  assert fake_runners.stopped == [{"type": "lsf", "command_id": ID1, "bridge": "", "user": "arthurf"}]
  assert stopped["errors"] == []
  assert "QABOARD_KUBERNETES_NAMESPACES" in stopped["warnings"][0]


def test_stop_batch_jobs_deletes_the_drivers(fake_runners):
  data = {
    "commands": {ID1: {"runner": "kubernetes", "namespace": "algo-qa"}},
    "submissions": {
      # its `qa batch` registered its command: we delete its Jobs once
      ID1: {"id": ID1, "runner": "kubernetes", "status": "submitted", "kubernetes_job": "qa-00000000-driver", "namespace": "algo-qa", "user": "arthurf"},
      # its pod didn't start yet: no runs are pending
      ID2: {"id": ID2, "runner": "kubernetes", "status": "submitting", "kubernetes_job": "qa-00000000-driver", "namespace": "algo-gpu", "user": "arthurf"},
      # we don't know if it was created
      ID3: {"id": ID3, "runner": "kubernetes", "status": "failed", "kubernetes_job": "qa-00000000-driver", "namespace": "algo-qa"},
      ID4: {"id": ID4, "runner": "kubernetes", "status": "stopped", "driver_stopped": True, "kubernetes_job": "qa-00000000-driver", "namespace": "algo-qa"},
      "lsf": {"id": "lsf", "runner": "lsf", "status": "submitted", "lsf_job_id": "123"},
      ID5: {"id": ID5, "runner": "kubernetes", "status": "submitted", "kubernetes_job": "x", "namespace": "kube-system"},
    },
  }
  stopped = runner_jobs.stop_batch_jobs(data, has_pending_runs=False, project_id="algo/project")
  assert [(o["command_id"], o["namespace"], o["project"]) for o in fake_runners.stopped] == [
    (ID1, "algo-qa", "algo/project"), (ID2, "algo-gpu", "algo/project"), (ID3, "algo-qa", "algo/project"),
  ]
  assert fake_runners.stopped[1]["user"] == "arthurf"
  assert stopped["stopped_drivers"] == [ID1, ID2, ID3]
  assert stopped["errors"] == [] and "kube-system" in stopped["warnings"][0]

  data = runner_jobs.mark_drivers_stopped(data, stopped["stopped_drivers"])
  assert [data["submissions"][id]["status"] for id in (ID1, ID2, ID3, ID5)] == ["stopped", "stopped", "failed", "submitted"]
  assert data["commands"] == {ID1: {"runner": "kubernetes", "namespace": "algo-qa"}}
  # nothing left to stop
  assert set(runner_jobs.kubernetes_drivers(data)) == {ID5}


def test_stop_batch_jobs_drivers_already_gone(fake_runners):
  fake_runners.stop_fails_with = NotFound("Not Found")
  data = {"submissions": {ID1: {"id": ID1, "runner": "kubernetes", "status": "submitted", "kubernetes_job": "x", "namespace": "algo-qa"}}}
  assert runner_jobs.stop_batch_jobs(data, False) == {"errors": [], "warnings": [], "stopped_drivers": [ID1]}


def test_stop_batch_jobs_reports_runner_errors(fake_runners):
  fake_runners.stop_fails_with = RuntimeError("Forbidden: jobs.batch is forbidden")
  stopped = runner_jobs.stop_batch_jobs({"commands": {ID1: {"runner": "kubernetes", "namespace": "algo-qa"}}}, True)
  assert stopped["errors"] == ["Forbidden: jobs.batch is forbidden"]


def test_kubernetes_drivers_ignores_invalid_data():
  assert runner_jobs.kubernetes_drivers(None) == {}
  assert runner_jobs.kubernetes_drivers({"submissions": ["x"]}) == {}
  assert runner_jobs.kubernetes_drivers({"submissions": {"a": "x", "b": {"runner": "kubernetes", "status": "submitted"}}}) == {}


# ==========================================
# Starting `qa batch` on Kubernetes
# ==========================================

ARTHUR = {"user_name": "arthurf", "login_type": "LDAP"}


@pytest.fixture
def account(monkeypatch):
  """arthurf's Unix account: uid 1234, gid 100, also in the groups 0 and 2000"""
  import backend.accounts as accounts
  from backend.accounts import Account
  known = {
    "arthurf": Account("arthurf", 1234, 100), "root": Account("root", 0, 0), "rootgroup": Account("rootgroup", 1000, 0),
    "daemon": Account("daemon", 2, 2), "alice": Account("alice", 1500, 100),
  }
  monkeypatch.setattr(accounts, "account", lambda name: known.get(name))
  monkeypatch.setattr(accounts, "group_ids", lambda name, gid: frozenset([gid, 0, 2000]))
  return known


def test_driver_job_options(fake_runners, account, monkeypatch):
  monkeypatch.setenv("QABOARD_KUBERNETES_SERVICE_ACCOUNT", "qaboard-runs")
  config = {
    "namespace": "algo-gpu",
    "image": "registry.example.com/algo/qa-env:2026.11",
    "image_pull_secrets": ["registry-creds"],
    "queue": "algo-gpu",
    "priority_class": "batch-low",
    "resources": {"cpu": 4, "nvidia.com/gpu": 1},
    "node_selector": {"pool": "cpu"},
    "tolerations": [{"key": "dedicated", "operator": "Exists"}],
    "mounts": [
      {"path": "/algo", "pvc": "algo-nfs", "read_only": True, "sub_path": "team/a"},
      {"path": "/home", "nfs": {"server": "nas1.example.com", "path": "/export/home"}},
    ],
    "env": {"OMP_NUM_THREADS": 4, "bad name": "x"},
    "forward_env": True,
    "job_template": "k8s/qa-job.yaml",
    "ttl_seconds_after_finished": 600,
    "concurrency": 50,
  }
  options, notes = runner_jobs.driver_job_options(config, ARTHUR, ID1, "algo/project")
  assert options == {
    "type": "kubernetes",
    "command_id": ID1,
    "user": "arthurf",
    "project": "algo/project",
    "namespace": "algo-gpu",
    "run_as": {"uid": 1234, "gid": 100, "groups": [2000]},
    "run_as_non_root": True,
    "forward_env": False,
    "pod_timeout": 0,
    "resources": {"cpu": "500m", "memory": "2Gi"},
    "api_retry_seconds": 15,
    "service_account": "qaboard-runs",
    "image": "registry.example.com/algo/qa-env:2026.11",
    "image_pull_secrets": ["registry-creds"],
    "queue": "algo-gpu",
    "priority_class": "batch-low",
    "ttl_seconds_after_finished": 600,
    "node_selector": {"pool": "cpu"},
    "tolerations": [{"key": "dedicated", "operator": "Exists"}],
    "env": {"OMP_NUM_THREADS": "4"},
    "mounts": config["mounts"],
  }
  assert any("job_template" in note for note in notes)
  assert any("bad name" in note for note in notes)


def test_driver_env_cant_change_how_tools_behave(fake_runners, account):
  env = {"BASH_ENV": "/x", "ENV": "/x", "LD_PRELOAD": "/x.so", "PATH": "/x", "PYTHONPATH": "/x", "PYTHONSTARTUP": "/x",
         "KUBERNETES_SERVICE_HOST": "evil", "QA_USER": "root", "QABOARD_HOST": "evil", "qaboard_token": "x", "OK": "1"}
  options, notes = runner_jobs.driver_job_options({"env": env}, ARTHUR, ID1, "p")
  assert options["env"] == {"OK": "1"}
  assert len(notes) == len(env) - 1


def test_driver_job_options_defaults(fake_runners, account, monkeypatch):
  monkeypatch.setenv("QABOARD_KUBERNETES_DRIVER_RESOURCES", '{"cpu": "1", "memory": "4Gi"}')
  options, notes = runner_jobs.driver_job_options({}, ARTHUR, ID1, "project")
  # the admins' first namespace
  assert options["namespace"] == "algo-qa"
  assert options["resources"] == {"cpu": "1", "memory": "4Gi"}
  assert "service_account" not in options and "context" not in options and "image" not in options
  assert notes == []
  monkeypatch.setenv("QABOARD_KUBERNETES_DRIVER_RESOURCES", 'nope')
  assert runner_jobs.driver_job_options({}, ARTHUR, ID1, "project")[0]["resources"] == {"cpu": "500m", "memory": "2Gi"}


def test_drivers_run_as_the_user(fake_runners, account, monkeypatch):
  # never as a UID from qaboard.yaml
  options, notes = runner_jobs.driver_job_options({"run_as": {"uid": 0, "gid": 0}}, ARTHUR, ID1, "project")
  assert options["run_as"] == {"uid": 1234, "gid": 100, "groups": [2000]} and options["run_as_non_root"]
  assert "ignored" in notes[0]
  with pytest.raises(NotAllowed, match="doesn't know the Unix account of nobody.* Ask your QA-Board admins.$"):
    runner_jobs.driver_job_options({}, {"user_name": "nobody", "login_type": "SAML"}, ID1, "project")
  for root in ("root", "rootgroup"):
    with pytest.raises(NotAllowed, match="root"):
      runner_jobs.driver_job_options({}, {"user_name": root, "login_type": "OIDC"}, ID1, "project")
  with pytest.raises(NotAllowed, match="QABOARD_KUBERNETES_MIN_UID"):
    runner_jobs.driver_job_options({}, {"user_name": "daemon", "login_type": "LDAP"}, ID1, "project")
  monkeypatch.setenv("QABOARD_KUBERNETES_MIN_UID", "1300")
  with pytest.raises(NotAllowed, match="below 1300"):
    runner_jobs.driver_job_options({}, ARTHUR, ID1, "project")


def test_drivers_run_as_the_image_only_if_the_admins_allow_it(fake_runners, account, monkeypatch):
  """`run_as: image` would run as any non-root UID baked in an image, with the project's mounts"""
  nobody = {"user_name": "nobody", "login_type": "LDAP"}
  for user_info in (nobody, ARTHUR, {"user_name": "alice", "login_type": "LOCAL"}):
    with pytest.raises(NotAllowed, match="QABOARD_KUBERNETES_ALLOW_RUN_AS_IMAGE"):
      runner_jobs.driver_job_options({"run_as": "image"}, user_info, ID1, "project")
  monkeypatch.setenv("QABOARD_KUBERNETES_ALLOW_RUN_AS_IMAGE", "1")
  # users the server has no Unix account for, but never as root
  options, notes = runner_jobs.driver_job_options({"run_as": "image"}, nobody, ID1, "project")
  assert (options["run_as"], options["run_as_non_root"], notes) == ("image", True, [])
  with pytest.raises(NotAllowed, match="or set `run_as: image`"):
    runner_jobs.driver_job_options({}, nobody, ID1, "project")
  # only for users who signed in with the directory, like `run_as: user`
  for user_info in ({"user_name": "alice", "login_type": "LOCAL"}, {"user_name": "alice"}):
    with pytest.raises(NotAllowed, match="QABOARD_KUBERNETES_TRUST_LOCAL_ACCOUNTS"):
      runner_jobs.driver_job_options({"run_as": "image"}, user_info, ID1, "project")
  monkeypatch.setenv("QABOARD_KUBERNETES_TRUST_LOCAL_ACCOUNTS", "1")
  assert runner_jobs.driver_job_options({"run_as": "image"}, {"user_name": "alice"}, ID1, "project")[0]["run_as"] == "image"


def test_local_accounts_are_not_mapped_to_uids(fake_runners, account, monkeypatch):
  """Anyone can sign up as `alice`: only the directory says who's who"""
  for user_info in ({"user_name": "alice", "login_type": "LOCAL"}, {"user_name": "alice"}, {"user_name": "alice", "login_type": "SERVICE"}):
    with pytest.raises(NotAllowed, match="QABOARD_KUBERNETES_TRUST_LOCAL_ACCOUNTS"):
      runner_jobs.driver_job_options({}, user_info, ID1, "project")
  monkeypatch.setenv("QABOARD_KUBERNETES_TRUST_LOCAL_ACCOUNTS", "1")
  assert runner_jobs.driver_job_options({}, {"user_name": "alice", "login_type": "LOCAL"}, ID1, "project")[0]["run_as"]["uid"] == 1500


def test_drivers_run_as_a_fixed_account(fake_runners, account, monkeypatch):
  monkeypatch.setenv("QABOARD_KUBERNETES_RUN_AS", "5000:6000")
  # whoever starts it, whatever qaboard.yaml says, even local accounts
  for config in ({}, {"run_as": "image"}, {"run_as": {"uid": 0}}):
    options = runner_jobs.driver_job_options(config, {"user_name": "alice", "login_type": "LOCAL"}, ID1, "project")[0]
    assert (options["run_as"], options["run_as_non_root"], options["user"]) == ({"uid": 5000, "gid": 6000}, True, "alice")
  for invalid in ("0:100", "100:0", "root", "1000"):
    monkeypatch.setenv("QABOARD_KUBERNETES_RUN_AS", invalid)
    with pytest.raises(NotAllowed, match="misconfigured"):
      runner_jobs.driver_job_options({}, ARTHUR, ID1, "project")
  monkeypatch.setenv("QABOARD_KUBERNETES_RUN_AS", "user")
  assert runner_jobs.driver_job_options({}, ARTHUR, ID1, "project")[0]["run_as"]["uid"] == 1234


def test_drivers_namespaces_and_contexts(fake_runners, account, monkeypatch):
  with pytest.raises(NotAllowed, match="kube-system"):
    runner_jobs.driver_job_options({"namespace": "kube-system"}, ARTHUR, ID1, "project")
  options, notes = runner_jobs.driver_job_options({"context": "other-cluster"}, ARTHUR, ID1, "project")
  assert "context" not in options and "other-cluster" in notes[0]
  monkeypatch.setenv("QABOARD_KUBERNETES_CONTEXTS", "other-cluster")
  assert runner_jobs.driver_job_options({"context": "other-cluster"}, ARTHUR, ID1, "project")[0]["context"] == "other-cluster"
  monkeypatch.delenv("QABOARD_KUBERNETES_NAMESPACES")
  with pytest.raises(NotAllowed, match="QABOARD_KUBERNETES_NAMESPACES"):
    runner_jobs.driver_job_options({}, ARTHUR, ID1, "project")


def test_drivers_mounts(fake_runners, account, monkeypatch):
  def mounts(*mounts):
    return runner_jobs.driver_job_options({"mounts": list(mounts)}, ARTHUR, ID1, "project")[0]["mounts"]
  host_path = {"path": "/data", "host_path": "/data"}
  with pytest.raises(NotAllowed, match="QABOARD_KUBERNETES_ALLOW_HOST_PATH"):
    mounts({"path": "/algo", "pvc": "algo"}, host_path)
  with pytest.raises(NotAllowed):
    mounts({"path": "/data", "hostPath": {"path": "/"}})
  invalid = [
    {"pvc": "x"}, {"path": "relative", "pvc": "x"}, "x", {"path": "/a/../etc", "pvc": "x"},
    # one of pvc and nfs
    {"path": "/a"}, {"path": "/a", "pvc": "x", "nfs": {"server": "s", "path": "/p"}},
    {"path": "/a", "pvc": "Not_A_Name"}, {"path": "/a", "pvc": "x", "read_only": "yes"},
    {"path": "/a", "nfs": "nas1:/export"}, {"path": "/a", "nfs": {"server": "nas1"}}, {"path": "/a", "nfs": {"server": "nas1 -o x", "path": "/p"}},
    {"path": "/a", "nfs": {"server": "nas1", "path": "/p", "mount_options": "x"}},
    {"path": "/a", "pvc": "x", "sub_path": "../x"}, {"path": "/a", "pvc": "x", "sub_path": "/x"},
    # anything else the runner might support: devices, CSI drivers, configs...
    {"path": "/a", "pvc": "x", "csi": {"driver": "x"}}, {"path": "/a", "secret": "server-secrets"}, {"path": "/a", "empty_dir": {}},
  ]
  for mount in invalid:
    with pytest.raises(NotAllowed):
      mounts(mount)
  with pytest.raises(NotAllowed):
    runner_jobs.driver_job_options({"mounts": "/algo"}, ARTHUR, ID1, "project")
  monkeypatch.setenv("QABOARD_KUBERNETES_ALLOW_HOST_PATH", "1")
  assert mounts({"path": "/algo", "pvc": "algo"}, host_path) == [{"path": "/algo", "pvc": "algo"}, host_path]
  with pytest.raises(NotAllowed):
    mounts({"path": "/data", "host_path": "relative"})


def test_drivers_invalid_options(fake_runners, account):
  with pytest.raises(NotAllowed, match="image"):
    runner_jobs.driver_job_options({"image": "a b"}, ARTHUR, ID1, "project")
  options, notes = runner_jobs.driver_job_options({
    "image_pull_secrets": "Not_Valid", "queue": "a queue", "priority_class": "A", "ttl_seconds_after_finished": True,
    "node_selector": ["x"], "tolerations": "x", "env": "x",
  }, ARTHUR, ID1, "project")
  for key in ("image_pull_secrets", "queue", "priority_class", "ttl_seconds_after_finished", "node_selector", "tolerations", "env"):
    assert key not in options
  assert len(notes) == 7


def make_commit(config, project_config=None):
  return SimpleNamespace(
    project_id="algo/project",
    data={"qatools_config": config} if config is not None else {},
    project=SimpleNamespace(data={"qatools_config": project_config or {}}),
  )


def test_commit_kubernetes_config():
  # the commit's own qaboard.yaml, not the project's
  assert runner_jobs.commit_kubernetes_config(make_commit({"runners": {"kubernetes": {"namespace": "x"}}}, {"runners": {"kubernetes": {"namespace": "y"}}})) == {"namespace": "x"}
  assert runner_jobs.commit_kubernetes_config(make_commit({"runners": {}}, {"runners": {"kubernetes": {"namespace": "y"}}})) == {}
  # unless qa never sent it
  assert runner_jobs.commit_kubernetes_config(make_commit(None, {"runners": {"kubernetes": {"namespace": "y"}}})) == {"namespace": "y"}
  # older qaboard.yaml, without `runners:`
  assert runner_jobs.commit_kubernetes_config(make_commit({"kubernetes": {"namespace": "x"}})) == {"namespace": "x"}
  assert runner_jobs.commit_kubernetes_config(make_commit({"runners": {"kubernetes": "x"}})) == {}
  assert runner_jobs.commit_kubernetes_config(SimpleNamespace(data=None, project=SimpleNamespace(data=None))) == {}


@pytest.mark.parametrize("url, protocol, host, hostname", [
  ("http://qaboard-proxy.qaboard.svc:8080", "http", "qaboard-proxy.qaboard.svc:8080", "qaboard-proxy.qaboard.svc"),
  ("https://qa.example.com/", "https", "qa.example.com", "qa.example.com"),
  ("qaboard-proxy:8080", "http", "qaboard-proxy:8080", "qaboard-proxy"),
  ("qaboard-proxy", "http", "qaboard-proxy", "qaboard-proxy"),
  ("http://[::1]:5151", "http", "[::1]:5151", "::1"),
])
def test_server_address(monkeypatch, url, protocol, host, hostname):
  monkeypatch.setenv("QABOARD_KUBERNETES_SERVER_URL", url)
  assert runner_jobs.server_address() == (protocol, host)
  from shlex import quote
  assert 'export no_proxy="${no_proxy:+$no_proxy,}"' + quote(hostname) + "\n" in runner_jobs.server_env_script([])


def test_submit_driver(fake_runners, account, tmp_path, monkeypatch):
  monkeypatch.setenv("QABOARD_KUBERNETES_SERVER_URL", "http://qaboard-proxy.qaboard.svc:8080")
  script_path = tmp_path / "qa_batch.sh"
  script_path.write_text("#!/bin/bash\nqa batch\n")
  ci_commit = make_commit({"runners": {"kubernetes": {"namespace": "algo-qa", "job_template": "x.yaml"}}})
  prepared = []
  def on_prepared(record):
    # recorded before it's submitted
    assert fake_runners.submitted == []
    prepared.append(record)
  record = runner_jobs.submit_driver(script_path, tmp_path, ARTHUR, ci_commit, DRIVER_ID, on_prepared=on_prepared)
  assert record == prepared[0] == {"kubernetes_job": "qa-0123abcd-driver", "namespace": "algo-qa"}
  [submitted] = fake_runners.submitted
  assert submitted["name"] == "qa-0123abcd-driver"
  assert submitted["log_file"] == tmp_path / "log.txt"
  assert submitted["job_options"]["command_id"] == DRIVER_ID
  assert submitted["job_options"]["project"] == "algo/project"
  # `qa` in the pod knows where the server is, and users know what was not used
  script = submitted["script"]
  assert script.startswith("#!/bin/bash\nexport QABOARD_PROTOCOL=http\nexport QABOARD_HOST=qaboard-proxy.qaboard.svc:8080\n")
  assert "unset QABOARD_HOSTNAME QABOARD_PORT\n" in script
  assert 'export no_proxy="${no_proxy:+$no_proxy,}"qaboard-proxy.qaboard.svc\n' in script
  assert "echo '[qaboard] runners.kubernetes.job_template is not used" in script
  assert script.endswith("qa batch\n")
  # users can read what ran
  assert script_path.read_text() == script
  # nothing wrote in the log, the pod does
  assert not (tmp_path / "log.txt").exists()


def test_submit_driver_script_works_in_bash(fake_runners, account, tmp_path, monkeypatch):
  import subprocess
  monkeypatch.setenv("QABOARD_HOST", "qaboard:5151")
  script_path = tmp_path / "qa_batch.sh"
  script_path.write_text('#!/bin/bash\necho "$QABOARD_PROTOCOL://$QABOARD_HOST $no_proxy $NO_PROXY"\n')
  runner_jobs.submit_driver(script_path, tmp_path, ARTHUR, make_commit({}), ID1)
  env = {k: v for k, v in os.environ.items() if k.lower() != "no_proxy"}
  out = subprocess.run(["bash", "-c", fake_runners.submitted[0]["script"]], capture_output=True, text=True, env={**env, "no_proxy": "localhost"})
  assert out.stdout == "http://qaboard:5151 localhost,qaboard qaboard\n"


def test_submit_driver_failures_are_in_the_logs(fake_runners, account, tmp_path):
  script_path = tmp_path / "qa_batch.sh"
  script_path.write_text("#!/bin/bash\nqa batch\n")
  prepared = []
  with pytest.raises(NotAllowed):
    runner_jobs.submit_driver(script_path, tmp_path, ARTHUR, make_commit({"runners": {"kubernetes": {"namespace": "kube-system"}}}), ID1, on_prepared=prepared.append)
  assert "ERROR: Could not start `qa batch` on Kubernetes: QA-Board may not start or stop runs in the Kubernetes namespace 'kube-system'" in (tmp_path / "log.txt").read_text()
  assert fake_runners.submitted == [] and prepared == [] and fake_runners.stopped == []

  # it may have been created: we delete it, only it (role=driver): not the runs' Jobs it may have started
  fake_runners.fail_with = RuntimeError("Forbidden: jobs.batch is forbidden: User system:serviceaccount:qaboard:qaboard-backend cannot create")
  with pytest.raises(RuntimeError):
    runner_jobs.submit_driver(script_path, tmp_path, ARTHUR, make_commit({}), ID1, on_prepared=prepared.append)
  assert "Forbidden" in (tmp_path / "log.txt").read_text()
  assert prepared == [{"kubernetes_job": "qa-00000000-driver", "namespace": "algo-qa"}]
  assert fake_runners.stopped == [{"type": "kubernetes", "command_id": ID1, "namespace": "algo-qa", "project": "algo/project", "user": "arthurf", "api_retry_seconds": 15, "role": "driver"}]
  # even if that fails too
  fake_runners.stop_fails_with = RuntimeError("connection refused")
  with pytest.raises(RuntimeError, match="Forbidden"):
    runner_jobs.submit_driver(script_path, tmp_path, ARTHUR, make_commit({}), ID1)
  # and if we can't write the log (e.g. the pod created it as another UID): the real error, not an OSError
  other = tmp_path / "other"
  (other / "log.txt").mkdir(parents=True)
  with pytest.raises(RuntimeError, match="Forbidden"):
    runner_jobs.submit_driver(script_path, other, ARTHUR, make_commit({}), ID1)


def test_startup_logs(tmp_path):
  """Why `qa batch` failed to start: why it was pending (its runner says), then its logs"""
  from backend.submissions import startup_logs, append_log
  assert startup_logs(tmp_path) is None
  (tmp_path / "log.pending.txt").write_text("The pod is pending: ErrImagePull\n")
  assert startup_logs(tmp_path) == "The pod is pending: ErrImagePull\n"
  assert append_log(tmp_path, "ERROR: Could not start `qa batch`\n")
  assert startup_logs(tmp_path) == "The pod is pending: ErrImagePull\nERROR: Could not start `qa batch`\n"
  assert startup_logs(tmp_path, size=10) == "qa batch`\n"
  assert not append_log(tmp_path / "missing", "x")


def test_submit_driver_without_the_runner(account, tmp_path, monkeypatch):
  from qaboard.runners import runners
  monkeypatch.setenv("QABOARD_KUBERNETES_NAMESPACES", "algo-qa")
  script_path = tmp_path / "qa_batch.sh"
  script_path.write_text("#!/bin/bash\nqa batch\n")
  with mock.patch.dict(runners):
    runners.pop("kubernetes", None)
    with pytest.raises(NotAllowed, match=r"qaboard\[kubernetes\]"):
      runner_jobs.submit_driver(script_path, tmp_path, ARTHUR, make_commit({}), ID1)


def test_dispatch_kubernetes(fake_runners, account, tmp_path):
  import backend.api.tuning as tuning
  script_path = tmp_path / "qa_batch.sh"
  script_path.write_text("#!/bin/bash\nqa batch\n")
  record = tuning._dispatch_kubernetes(script_path, tmp_path, ARTHUR, make_commit({}), True, DRIVER_ID)
  assert record == {"kubernetes_job": "qa-0123abcd-driver", "namespace": "algo-qa"}
  assert fake_runners.submitted[0]["job_options"]["pod_timeout"] == 0


def test_the_driver_is_the_batch_command(tmp_path):
  """Stopping the batch deletes the driver: its `qa batch` uses the command id of its Job's labels"""
  from backend.api.tuning import _generate_batch_script
  ci_commit = SimpleNamespace(hexsha="abc", outputs_dir=tmp_path / "outputs" / "qaboard" / "p")
  script = _generate_batch_script(ci_commit, "arthurf", tmp_path, DRIVER_ID, "qa batch", {})
  assert f"export QA_BATCH_COMMAND_ID={DRIVER_ID};" in script
  from backend.redo import redo_script
  ci_commit.artifacts_dir = tmp_path
  assert f"export QA_BATCH_COMMAND_ID={DRIVER_ID}" in redo_script(ci_commit, "arthurf", DRIVER_ID, "qa batch")
