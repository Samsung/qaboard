"""
Tests for backend/runner_jobs.py: stopping batches with validated options, and starting `qa batch` on Kubernetes.
The kubernetes runner is replaced by a fake that records what it's asked (qaboard.runners.runners['kubernetes']).
"""
import os
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest

import backend.runner_jobs as runner_jobs
from backend.runner_jobs import NotAllowed


class FakeRunner:
  """Records the calls the server makes to a runner"""
  type = "fake"
  stopped: list = []
  submitted: list = []
  fail_with = None

  @classmethod
  def stop_jobs(cls, jobs, job_options):
    if cls.fail_with:
      raise cls.fail_with
    cls.stopped.append(job_options)

  @classmethod
  def submit_detached(cls, script, name, log_file, job_options):
    if cls.fail_with:
      raise cls.fail_with
    cls.submitted.append({"script": script, "name": name, "log_file": log_file, "job_options": job_options})
    return {"kubernetes_job": name, "namespace": job_options["namespace"]}


@pytest.fixture
def fake_runners(monkeypatch):
  """The kubernetes and LSF runners are fakes, and the admins allow the algo-qa and algo-gpu namespaces"""
  from qaboard.runners import runners
  FakeRunner.stopped, FakeRunner.submitted, FakeRunner.fail_with = [], [], None
  monkeypatch.setenv("QABOARD_KUBERNETES_NAMESPACES", "algo-qa, algo-gpu")
  for name in ("QABOARD_KUBERNETES_CONTEXTS", "QABOARD_KUBERNETES_SERVICE_ACCOUNT", "QABOARD_KUBERNETES_SERVER_URL",
               "QABOARD_KUBERNETES_ALLOW_HOST_PATH", "QABOARD_KUBERNETES_DRIVER_RESOURCES", "QABOARD_HOST", "QABOARD_PROTOCOL",
               "QA_RUNNERS_LSF_BRIDGE", "QABOARD_DASK_SCHEDULERS"):
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
  for invalid in (None, "", "Algo", "algo;id", "-algo", "a" * 64, ["algo-qa"], {"x": 1}):
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


# ==========================================
# Stopping
# ==========================================

def test_stop_options_of_other_runners_are_unchanged(fake_runners, monkeypatch):
  assert runner_jobs.stop_job_options("abc-123", {"runner": "lsf", "user": "arthurf", "queue": "evil;id"}) == {
    "type": "lsf", "command_id": "abc-123", "bridge": "", "user": "arthurf",
  }
  monkeypatch.setenv("QA_RUNNERS_LSF_BRIDGE", "ssh host bsub_su {user} {bsub_command}")
  monkeypatch.setenv("QABOARD_DASK_SCHEDULERS", "tcp://trusted:8786")
  assert runner_jobs.stop_job_options("abc", {"runner": "dask", "scheduler_address": "tcp://trusted:8786"}) == {
    "type": "dask", "command_id": "abc", "bridge": "ssh host bsub_su {user} {bsub_command}", "scheduler_address": "tcp://trusted:8786",
  }
  assert "scheduler_address" not in runner_jobs.stop_job_options("abc", {"runner": "dask", "scheduler_address": "tcp://attacker:8786"})
  for runner in ("local", "celery"):
    assert runner_jobs.stop_job_options("abc", {"runner": runner}) == {"type": runner, "command_id": "abc", "bridge": "ssh host bsub_su {user} {bsub_command}"}
  for command_id, command in [("abc", {"runner": "windows"}), ("abc", {"runner": "evil"}), ("a;b", {"runner": "lsf"}),
                              ("abc", {"runner": "lsf", "user": "$(id)"}), ("abc", None)]:
    with pytest.raises(ValueError):
      runner_jobs.stop_job_options(command_id, command)


def test_stop_options_of_kubernetes(fake_runners, monkeypatch):
  command = {"runner": "kubernetes", "namespace": "algo-gpu", "context": "laptop", "user": "arthurf", "image": "evil", "run_as": "root"}
  # unknown contexts: the server's default cluster
  assert runner_jobs.stop_job_options("abc", command) == {"type": "kubernetes", "command_id": "abc", "bridge": "", "user": "arthurf", "namespace": "algo-gpu"}
  monkeypatch.setenv("QABOARD_KUBERNETES_CONTEXTS", "laptop")
  assert runner_jobs.stop_job_options("abc", command)["context"] == "laptop"
  for namespace in ("kube-system", None, "algo-qa --all", 7):
    with pytest.raises(NotAllowed):
      runner_jobs.stop_job_options("abc", {**command, "namespace": namespace})
  monkeypatch.delenv("QABOARD_KUBERNETES_NAMESPACES")
  with pytest.raises(NotAllowed, match="QABOARD_KUBERNETES_NAMESPACES"):
    runner_jobs.stop_job_options("abc", command)


def test_stop_options_of_dask_clusters(fake_runners):
  assert runner_jobs.stop_job_options("abc", {"runner": "dask", "cluster_type": "slurm"})["cluster_type"] == "slurm"
  command = {"runner": "dask", "cluster_type": "kubernetes", "kubernetes": {"namespace": "algo-qa", "context": "laptop", "image": "evil"}}
  assert runner_jobs.stop_job_options("abc", command) == {
    "type": "dask", "command_id": "abc", "bridge": "", "cluster_type": "kubernetes", "kubernetes": {"namespace": "algo-qa"},
  }
  for kubernetes in ({"namespace": "kube-system"}, {"namespace": None}, {}, "algo-qa", None):
    with pytest.raises(NotAllowed):
      runner_jobs.stop_job_options("abc", {**command, "kubernetes": kubernetes})
  with pytest.raises(ValueError):
    runner_jobs.stop_job_options("abc", {"runner": "dask", "cluster_type": "evil"})
  # before qa sent it: LSF
  assert "cluster_type" not in runner_jobs.stop_job_options("abc", {"runner": "dask"})


def test_the_dask_runner_stops_kubernetes_clusters_with_these_options(monkeypatch):
  """The real DaskRunner.stop_jobs, with what the server forwards"""
  import qaboard.runners.dask_runner as dask_runner
  from qaboard.runners.job import JobGroup
  monkeypatch.setenv("QABOARD_KUBERNETES_NAMESPACES", "algo-qa")
  monkeypatch.setenv("QABOARD_KUBERNETES_CONTEXTS", "laptop")
  calls = []
  monkeypatch.setattr(dask_runner, "stop_kubernetes", lambda *args: calls.append(args))
  command = {"runner": "dask", "cluster_type": "kubernetes", "kubernetes": {"namespace": "algo-qa", "context": "laptop"}}
  JobGroup(job_options=runner_jobs.stop_job_options("0123456789", command)).stop()
  assert calls == [("0123456789", "algo-qa", "laptop")]


def test_stop_batch_jobs(fake_runners):
  data = {"commands": {
    "lsf-command": {"runner": "lsf"},
    "k8s-command": {"runner": "kubernetes", "namespace": "algo-qa"},
    "elsewhere": {"runner": "kubernetes", "namespace": "kube-system"},
    "unknown": {"runner": "windows"},
  }}
  assert runner_jobs.stop_batch_jobs(data, has_pending_runs=False) is None
  assert fake_runners.stopped == []
  stopped = runner_jobs.stop_batch_jobs(data, has_pending_runs=True)
  assert [(o["type"], o["command_id"]) for o in fake_runners.stopped] == [("lsf", "lsf-command"), ("kubernetes", "k8s-command")]
  # users are told that the runs in kube-system keep running
  assert stopped["stopped_drivers"] == []
  [error] = stopped["errors"]
  assert "kube-system" in error


def test_stop_batch_jobs_without_allowed_namespaces(fake_runners, monkeypatch):
  monkeypatch.delenv("QABOARD_KUBERNETES_NAMESPACES")
  stopped = runner_jobs.stop_batch_jobs({"commands": {"k8s": {"runner": "kubernetes", "namespace": "algo-qa"}}}, True)
  assert fake_runners.stopped == []
  assert "QABOARD_KUBERNETES_NAMESPACES" in stopped["errors"][0]


def test_stop_batch_jobs_deletes_the_drivers(fake_runners):
  data = {
    "commands": {"started": {"runner": "kubernetes", "namespace": "algo-qa"}},
    "submissions": {
      # its `qa batch` registered its command: we delete its Jobs once
      "started": {"id": "started", "runner": "kubernetes", "status": "submitted", "kubernetes_job": "qa-started-driver", "namespace": "algo-qa", "user": "arthurf"},
      # its pod didn't start yet: no runs are pending
      "pending": {"id": "pending", "runner": "kubernetes", "status": "submitted", "kubernetes_job": "qa-pending-driver", "namespace": "algo-gpu", "user": "arthurf"},
      "old": {"id": "old", "runner": "kubernetes", "status": "stopped", "kubernetes_job": "qa-old-driver", "namespace": "algo-qa"},
      "lsf": {"id": "lsf", "runner": "lsf", "status": "submitted", "lsf_job_id": "123"},
      "forged": {"id": "forged", "runner": "kubernetes", "status": "submitted", "kubernetes_job": "x", "namespace": "kube-system"},
    },
  }
  stopped = runner_jobs.stop_batch_jobs(data, has_pending_runs=False)
  assert [(o["command_id"], o["namespace"]) for o in fake_runners.stopped] == [("started", "algo-qa"), ("pending", "algo-gpu")]
  assert fake_runners.stopped[1]["user"] == "arthurf"
  assert stopped["stopped_drivers"] == ["started", "pending"]
  assert len(stopped["errors"]) == 1 and "kube-system" in stopped["errors"][0]

  data = runner_jobs.mark_drivers_stopped(data, stopped["stopped_drivers"])
  assert data["submissions"]["pending"]["status"] == "stopped"
  assert data["submissions"]["forged"]["status"] == "submitted"
  assert data["commands"] == {"started": {"runner": "kubernetes", "namespace": "algo-qa"}}
  # nothing left to stop
  assert set(runner_jobs.kubernetes_drivers(data)) == {"forged"}


def test_stop_batch_jobs_reports_runner_errors(fake_runners):
  fake_runners.fail_with = RuntimeError("Forbidden: jobs.batch is forbidden")
  stopped = runner_jobs.stop_batch_jobs({"commands": {"k8s": {"runner": "kubernetes", "namespace": "algo-qa"}}}, True)
  assert stopped["errors"] == ["Forbidden: jobs.batch is forbidden"]


def test_kubernetes_drivers_ignores_invalid_data():
  assert runner_jobs.kubernetes_drivers(None) == {}
  assert runner_jobs.kubernetes_drivers({"submissions": ["x"]}) == {}
  assert runner_jobs.kubernetes_drivers({"submissions": {"a": "x", "b": {"runner": "kubernetes", "status": "submitted"}}}) == {}


# ==========================================
# Starting `qa batch` on Kubernetes
# ==========================================

@pytest.fixture
def account(monkeypatch):
  """arthurf's Unix account: uid 1234, gid 100, also in the groups 0 and 2000"""
  import backend.accounts as accounts
  from backend.accounts import Account
  known = {"arthurf": Account("arthurf", 1234, 100), "root": Account("root", 0, 0), "rootgroup": Account("rootgroup", 1000, 0)}
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
    "mounts": [{"path": "/algo", "pvc": "algo-nfs"}, {"path": "/home", "nfs": {"server": "nas1", "path": "/export/home"}}],
    "env": {"OMP_NUM_THREADS": 4, "bad name": "x"},
    "forward_env": True,
    "job_template": "k8s/qa-job.yaml",
    "ttl_seconds_after_finished": 600,
    "concurrency": 50,
  }
  options, notes = runner_jobs.driver_job_options(config, "arthurf", "0123456789abcdef", "algo/project")
  assert options == {
    "type": "kubernetes",
    "command_id": "0123456789abcdef",
    "user": "arthurf",
    "project": "algo/project",
    "namespace": "algo-gpu",
    "run_as": {"uid": 1234, "gid": 100, "groups": [2000]},
    "forward_env": False,
    "timeout": 0,
    "resources": {"cpu": "500m", "memory": "2Gi"},
    "service_account": "qaboard-runs",
    "image": "registry.example.com/algo/qa-env:2026.11",
    "image_pull_secrets": ["registry-creds"],
    "queue": "algo-gpu",
    "priority_class": "batch-low",
    "ttl_seconds_after_finished": 600,
    "node_selector": {"pool": "cpu"},
    "tolerations": [{"key": "dedicated", "operator": "Exists"}],
    "env": {"OMP_NUM_THREADS": "4"},
    "mounts": [{"path": "/algo", "pvc": "algo-nfs"}, {"path": "/home", "nfs": {"server": "nas1", "path": "/export/home"}}],
  }
  assert any("job_template" in note for note in notes)
  assert any("env" in note for note in notes)


def test_driver_job_options_defaults(fake_runners, account, monkeypatch):
  monkeypatch.setenv("QABOARD_KUBERNETES_DRIVER_RESOURCES", '{"cpu": "1", "memory": "4Gi"}')
  options, notes = runner_jobs.driver_job_options({}, "arthurf", "abc", "project")
  # the admins' first namespace
  assert options["namespace"] == "algo-qa"
  assert options["resources"] == {"cpu": "1", "memory": "4Gi"}
  assert "service_account" not in options and "context" not in options and "image" not in options
  assert notes == []
  monkeypatch.setenv("QABOARD_KUBERNETES_DRIVER_RESOURCES", 'nope')
  assert runner_jobs.driver_job_options({}, "arthurf", "abc", "project")[0]["resources"] == {"cpu": "500m", "memory": "2Gi"}


def test_drivers_run_as_the_user(fake_runners, account):
  # never as a UID from qaboard.yaml
  options, notes = runner_jobs.driver_job_options({"run_as": {"uid": 0, "gid": 0}}, "arthurf", "abc", "project")
  assert options["run_as"] == {"uid": 1234, "gid": 100, "groups": [2000]}
  assert "ignored" in notes[0]
  # or as the image's user, if the project asks
  assert runner_jobs.driver_job_options({"run_as": "image"}, "nobody", "abc", "project")[0]["run_as"] == "image"
  with pytest.raises(NotAllowed, match="doesn't know the Unix account of nobody"):
    runner_jobs.driver_job_options({}, "nobody", "abc", "project")
  for root in ("root", "rootgroup"):
    with pytest.raises(NotAllowed, match="root"):
      runner_jobs.driver_job_options({}, root, "abc", "project")


def test_drivers_namespaces_and_contexts(fake_runners, account, monkeypatch):
  with pytest.raises(NotAllowed, match="kube-system"):
    runner_jobs.driver_job_options({"namespace": "kube-system"}, "arthurf", "abc", "project")
  options, notes = runner_jobs.driver_job_options({"context": "other-cluster"}, "arthurf", "abc", "project")
  assert "context" not in options and "other-cluster" in notes[0]
  monkeypatch.setenv("QABOARD_KUBERNETES_CONTEXTS", "other-cluster")
  assert runner_jobs.driver_job_options({"context": "other-cluster"}, "arthurf", "abc", "project")[0]["context"] == "other-cluster"
  monkeypatch.delenv("QABOARD_KUBERNETES_NAMESPACES")
  with pytest.raises(NotAllowed, match="QABOARD_KUBERNETES_NAMESPACES"):
    runner_jobs.driver_job_options({}, "arthurf", "abc", "project")


def test_drivers_host_path_mounts(fake_runners, account, monkeypatch):
  config = {"mounts": [{"path": "/algo", "pvc": "algo"}, {"path": "/data", "host_path": "/data"}]}
  with pytest.raises(NotAllowed, match="QABOARD_KUBERNETES_ALLOW_HOST_PATH"):
    runner_jobs.driver_job_options(config, "arthurf", "abc", "project")
  with pytest.raises(NotAllowed):
    runner_jobs.driver_job_options({"mounts": [{"path": "/data", "hostPath": {"path": "/"}}]}, "arthurf", "abc", "project")
  for invalid in ("/algo", [{"pvc": "x"}], [{"path": "relative", "pvc": "x"}], ["x"]):
    with pytest.raises(NotAllowed):
      runner_jobs.driver_job_options({"mounts": invalid}, "arthurf", "abc", "project")
  monkeypatch.setenv("QABOARD_KUBERNETES_ALLOW_HOST_PATH", "1")
  assert runner_jobs.driver_job_options(config, "arthurf", "abc", "project")[0]["mounts"] == config["mounts"]


def test_drivers_invalid_options(fake_runners, account):
  with pytest.raises(NotAllowed, match="image"):
    runner_jobs.driver_job_options({"image": "a b"}, "arthurf", "abc", "project")
  options, notes = runner_jobs.driver_job_options({
    "image_pull_secrets": "Not_Valid", "queue": "a queue", "priority_class": "A", "ttl_seconds_after_finished": True,
    "node_selector": ["x"], "tolerations": "x", "env": "x",
  }, "arthurf", "abc", "project")
  for key in ("image_pull_secrets", "queue", "priority_class", "ttl_seconds_after_finished", "node_selector", "tolerations", "env"):
    assert key not in options
  assert len(notes) == 7


def make_commit(config):
  return SimpleNamespace(project_id="algo/project", project=SimpleNamespace(data={"qatools_config": config}))


def test_project_kubernetes_config():
  assert runner_jobs.project_kubernetes_config(make_commit({"runners": {"kubernetes": {"namespace": "x"}}})) == {"namespace": "x"}
  # older qaboard.yaml, without `runners:`
  assert runner_jobs.project_kubernetes_config(make_commit({"kubernetes": {"namespace": "x"}})) == {"namespace": "x"}
  assert runner_jobs.project_kubernetes_config(make_commit({"runners": {"kubernetes": "x"}})) == {}
  assert runner_jobs.project_kubernetes_config(SimpleNamespace(project=SimpleNamespace(data=None))) == {}


def test_submit_driver(fake_runners, account, tmp_path, monkeypatch):
  monkeypatch.setenv("QABOARD_KUBERNETES_SERVER_URL", "http://qaboard-proxy.qaboard.svc:8080")
  script_path = tmp_path / "qa_batch.sh"
  script_path.write_text("#!/bin/bash\nqa batch\n")
  ci_commit = make_commit({"runners": {"kubernetes": {"namespace": "algo-qa", "job_template": "x.yaml"}}})
  record = runner_jobs.submit_driver(script_path, tmp_path, "arthurf", ci_commit, "0123456789abcdef")
  assert record == {"kubernetes_job": "qa-01234567-driver", "namespace": "algo-qa"}
  [submitted] = fake_runners.submitted
  assert submitted["name"] == "qa-01234567-driver"
  assert submitted["log_file"] == tmp_path / "log.txt"
  assert submitted["job_options"]["command_id"] == "0123456789abcdef"
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
  runner_jobs.submit_driver(script_path, tmp_path, "arthurf", make_commit({}), "abc")
  env = {k: v for k, v in os.environ.items() if k.lower() != "no_proxy"}
  out = subprocess.run(["bash", "-c", fake_runners.submitted[0]["script"]], capture_output=True, text=True, env={**env, "no_proxy": "localhost"})
  assert out.stdout == "http://qaboard:5151 localhost,qaboard qaboard\n"


def test_submit_driver_failures_are_in_the_logs(fake_runners, account, tmp_path):
  script_path = tmp_path / "qa_batch.sh"
  script_path.write_text("#!/bin/bash\nqa batch\n")
  with pytest.raises(NotAllowed):
    runner_jobs.submit_driver(script_path, tmp_path, "arthurf", make_commit({"runners": {"kubernetes": {"namespace": "kube-system"}}}), "abc")
  assert "ERROR: Could not start `qa batch` on Kubernetes: QA-Board may not start or stop runs in the Kubernetes namespace 'kube-system'" in (tmp_path / "log.txt").read_text()
  assert fake_runners.submitted == []

  fake_runners.fail_with = RuntimeError("Forbidden: jobs.batch is forbidden: User system:serviceaccount:qaboard:qaboard-backend cannot create")
  with pytest.raises(RuntimeError):
    runner_jobs.submit_driver(script_path, tmp_path, "arthurf", make_commit({}), "abc")
  assert "Forbidden" in (tmp_path / "log.txt").read_text()


def test_submit_driver_without_the_runner(account, tmp_path, monkeypatch):
  from qaboard.runners import runners
  monkeypatch.setenv("QABOARD_KUBERNETES_NAMESPACES", "algo-qa")
  script_path = tmp_path / "qa_batch.sh"
  script_path.write_text("#!/bin/bash\nqa batch\n")
  with mock.patch.dict(runners):
    runners.pop("kubernetes", None)
    with pytest.raises(NotAllowed, match=r"qaboard\[kubernetes\]"):
      runner_jobs.submit_driver(script_path, tmp_path, "arthurf", make_commit({}), "abc")


def test_dispatch_kubernetes(fake_runners, account, tmp_path):
  import backend.api.tuning as tuning
  script_path = tmp_path / "qa_batch.sh"
  script_path.write_text("#!/bin/bash\nqa batch\n")
  record = tuning._dispatch_kubernetes(script_path, tmp_path, "arthurf", make_commit({}), True, "fedcba9876543210")
  assert record == {"kubernetes_job": "qa-fedcba98-driver", "namespace": "algo-qa"}
  assert fake_runners.submitted[0]["job_options"]["timeout"] == 0


def test_the_driver_is_the_batch_command(tmp_path):
  """Stopping the batch deletes the driver: its `qa batch` uses the command id of its Job's labels"""
  from backend.api.tuning import _generate_batch_script
  ci_commit = SimpleNamespace(hexsha="abc", outputs_dir=tmp_path / "outputs" / "qaboard" / "p")
  script = _generate_batch_script(ci_commit, "arthurf", tmp_path, "0123456789abcdef", "qa batch", {})
  assert "export QA_BATCH_COMMAND_ID=0123456789abcdef;" in script
  from backend.redo import redo_script
  ci_commit.artifacts_dir = tmp_path
  assert "export QA_BATCH_COMMAND_ID=0123456789abcdef" in redo_script(ci_commit, "arthurf", "0123456789abcdef", "qa batch")
