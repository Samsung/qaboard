"""
Unit tests for starting batches from QA-Board (backend/api/tuning.py)
"""
from types import SimpleNamespace

import pytest


@pytest.fixture(autouse=True)
def server_runner(monkeypatch):
    """Most tests are about the request: the server starts batches in its container. Unset, it refuses them."""
    monkeypatch.setenv("QABOARD_TUNING_RUNNER", "local")


def test_parse_bsub_job_id():
    from backend.api.tuning import parse_bsub_job_id
    assert parse_bsub_job_id("Job <1234> is submitted to queue <normal>.\n") == "1234"
    assert parse_bsub_job_id("some wrapper output\nJob <42> is submitted to default queue <short>.") == "42"
    assert parse_bsub_job_id("bsub: command not found") is None
    assert parse_bsub_job_id(None) is None


def test_record_submission_keeps_other_data():
    from backend.api.tuning import record_submission
    batch = SimpleNamespace(data={"commands": {"abc": {"argv": ["qa", "batch"]}}})
    record_submission(batch, {"id": "s1", "created_at": "2026-10-05T10:00:00Z", "status": "submitting"})
    record_submission(batch, {"id": "s1", "created_at": "2026-10-05T10:00:00Z", "status": "failed", "exit_code": 1})
    assert batch.data["commands"] == {"abc": {"argv": ["qa", "batch"]}}
    assert batch.data["submissions"] == {"s1": {"id": "s1", "created_at": "2026-10-05T10:00:00Z", "status": "failed", "exit_code": 1}}


def test_record_submission_keeps_the_most_recent():
    from backend.api.tuning import record_submission, MAX_SUBMISSIONS
    batch = SimpleNamespace(data=None)
    for index in range(MAX_SUBMISSIONS + 5):
        record_submission(batch, {"id": f"s{index}", "created_at": f"2026-10-05T10:{index:02d}:00Z"})
    ids = set(batch.data["submissions"])
    assert len(ids) == MAX_SUBMISSIONS
    assert "s0" not in ids and f"s{MAX_SUBMISSIONS + 4}" in ids


def test_pending_note(tmp_path):
    """While `qa batch` waits to start (e.g. its pod is pending), the runner says why in log.pending.txt"""
    import datetime
    from backend.submissions import pending_note, PENDING_NOTE_MAX_BYTES
    created_at = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat() + 'Z'
    submission = {"id": "s1", "runner": "kubernetes", "status": "submitted", "log_dir": str(tmp_path), "created_at": created_at}
    assert pending_note(submission) is None
    (tmp_path / "log.pending.txt").write_text("The pod is pending: 0/3 nodes have a free GPU.\n")
    assert pending_note(submission) == "The pod is pending: 0/3 nodes have a free GPU."
    assert pending_note({**submission, "status": "submitting"}) == "The pod is pending: 0/3 nodes have a free GPU."
    # an empty log is no log
    (tmp_path / "log.txt").write_text("")
    assert pending_note(submission) is not None
    # once `qa batch` started, or ended, its logs say the rest
    (tmp_path / "log.txt").write_text("qa batch started\n")
    assert pending_note(submission) is None
    (tmp_path / "log.txt").unlink()
    for status in ("done", "failed", "stopped"):
        assert pending_note({**submission, "status": status}) is None
    # bounded, and whatever is in the file
    (tmp_path / "log.pending.txt").write_bytes(b"\xff" + b"x" * 10 * PENDING_NOTE_MAX_BYTES)
    assert len(pending_note(submission)) == PENDING_NOTE_MAX_BYTES
    for invalid in (None, "x", {"status": "submitted"}, {"status": "submitted", "log_dir": 7}, {**submission, "created_at": "yesterday"}, {**submission, "created_at": 7}):
        assert pending_note(invalid) is None


def test_pending_note_reads_the_storage_only_for_recent_kubernetes_submissions(tmp_path, monkeypatch):
    """Batches are serialized often, and LSF or Kubernetes submissions stay "submitted": we don't read the storage for each"""
    import datetime
    from pathlib import Path
    from backend.submissions import pending_note
    (tmp_path / "log.pending.txt").write_text("The pod is pending\n")
    now = datetime.datetime(2026, 11, 10, 12, 0, tzinfo=datetime.timezone.utc)
    submission = {"id": "s1", "runner": "kubernetes", "status": "submitted", "log_dir": str(tmp_path), "created_at": "2026-11-10T09:00:00.123456Z"}
    assert pending_note(submission, now=now) == "The pod is pending"
    assert pending_note({**submission, "created_at": "2026-11-09T12:30:00Z"}, now=now) == "The pod is pending"
    def no_storage(*args, **kwargs):
        raise AssertionError("the storage was read")
    monkeypatch.setattr(Path, "stat", no_storage)
    monkeypatch.setattr(Path, "open", no_storage)
    for runner in ("lsf", "bridge", "local", "celery", None):
        assert pending_note({**submission, "runner": runner}, now=now) is None
    # after a day it started, or never will
    assert pending_note({**submission, "created_at": "2026-11-09T11:59:00Z"}, now=now) is None
    assert pending_note({**submission, "created_at": "2026-10-01T09:00:00Z"}, now=now) is None
    # from before we recorded when, or from the future
    assert pending_note({k: v for k, v in submission.items() if k != "created_at"}, now=now) is None
    assert pending_note({**submission, "created_at": "2026-11-11T09:00:00Z"}, now=now) is None


def test_check_tuning_search():
    from backend.api.tuning import check_tuning_search
    assert check_tuning_search({"search_type": "grid", "parameter_search": [{"a": 1}, {"a": 2}]}) == []
    assert check_tuning_search({"search_type": "grid", "parameter_search": {"a": 1}}) == []
    assert check_tuning_search({"search_type": "sampler", "search_options": {"n_iter": 5}, "parameter_search": [{"a": 1}]}) == []
    assert check_tuning_search({"search_type": "grid", "parameter_search": [1]})
    assert check_tuning_search(None)
    assert "Unknown search type" in check_tuning_search({"search_type": "random"})[0]
    optimize = lambda yaml: check_tuning_search({"search_type": "optimize", "parameter_search": yaml})
    assert "not valid YAML" in optimize("a: [")[0]
    # the same checks and messages as qa optimize: one per section
    errors = optimize("evaluations: 0\nsearch_space: []\nsolver: {n_initial_points: 3}")
    assert len(errors) == 3
    assert "objective" in errors[0] and "search_space" in errors[1] and "n_startup_trials" in errors[2]
    assert "positive whole number" in optimize("objective: {psnr: {}}\nevaluations: 0\nsearch_space:\n- Real: {name: x, low: 0, high: 1}")[0]
    assert optimize("objective: {psnr: {}}\nevaluations: 10\nsearch_space:\n- Real: {name: x, low: 0, high: 1}") == []


def make_commit(tmp_path, config, batches=None):
    import yaml
    root = tmp_path / "artifacts"
    (root / "sub").mkdir(parents=True)
    (root / "qaboard.yaml").write_text("project: {name: repo}")
    (root / "sub/qaboard.yaml").write_text("")
    if batches is not None:
        (root / "sub/batches.yaml").write_text(yaml.dump(batches))
    status = {"ok": True, "problems": []}
    return SimpleNamespace(
        hexsha="abcdef",
        uploaded_artifacts_dir=None,
        deleted=False,
        data={"qatools_config": config},
        project=SimpleNamespace(id="repo/sub", id_relative="sub", id_git="repo", data={}),
        project_id="repo/sub",
        artifacts_dir=root / "sub",
        repo_artifacts_dir=root,
        artifacts_status=lambda max_checked_files=500: status,
        recreate_artifacts_settings=None,
    )


def test_check_tuning_request(tmp_path):
    from backend.api.tuning import check_tuning_request
    config = {"project": {"name": "repo", "entrypoint": "sub/qa/main.py"}, "inputs": {"batches": "sub/batches.yaml", "platforms": ["linux"]}}
    ci_commit = make_commit(tmp_path, config, batches={"smoke": {"inputs": ["a.jpg"]}, "aliases": {"all": ["smoke"]}})
    data = {"batch_label": "tuning", "selected_group": "all", "groups": [], "platform": "linux", "tuning_search": {"search_type": "grid", "parameter_search": {}}}
    check = check_tuning_request(ci_commit, data)
    assert check["errors"] == []
    assert check["batches"] == ["smoke"]
    # the alias stands for a batch of the commit's batch file, named as in its qaboard.yaml
    assert check["definitions"] == [{"name": "smoke", "files": ["sub/batches.yaml"], "sources": ["commit"]}]
    # the entrypoint is missing from the artifacts
    assert any("entrypoint" in w for w in check["warnings"])

    check = check_tuning_request(ci_commit, {**data, "selected_group": "smok", "platform": "windows", "batch_label": " "})
    errors = " ".join(check["errors"])
    assert "Unknown batch: smok" in errors and "Defined: all, smoke" not in errors and "smoke" in errors
    assert "Unknown platform" in errors
    assert "name to the batch" in errors


def test_check_tuning_request_says_where_batches_are_defined(tmp_path, monkeypatch):
    import backend.api.tuning as tuning
    config = {"project": {"name": "repo"}, "inputs": {"batches": "sub/batches.yaml"}}
    ci_commit = make_commit(tmp_path, config, batches={"night-1": {}, "night-2": {"inputs": ["a"]}, "day": {}})
    monkeypatch.setattr(tuning, "qaboard_data_shared_dir", tmp_path / "shared")
    tuning.get_groups_path("repo/sub", name="alice").write_text("night-2:\n  inputs: [b]\n")
    data = {"batch_label": "x", "selected_group": "night-*", "groups": ["alice"], "tuning_search": {"search_type": "grid"}}
    check = tuning.check_tuning_request(ci_commit, data)
    assert check["errors"] == []
    assert check["definitions"] == [
        {"name": "night-1", "files": ["sub/batches.yaml"], "sources": ["commit"]},
        {"name": "night-2", "files": ["sub/batches.yaml", "alice.yml"], "sources": ["commit", "qaboard"]},
    ]
    # `qa batch` reads them in the same order as on the commit, QA-Board's last
    assert [f["path"] for f in check["batches_files"]] == ["sub/batches.yaml", "alice.yml"]


def test_submissions_remember_what_was_asked():
    """To start from a previous batch: its label, batches, and the parameters as sent and as written"""
    from backend.submissions import submission_request, MAX_REQUEST_TEXT_BYTES
    data = {
        "project": "group/repo", "user": "alice", "groups": ["extra-batches"], "configuration": "xxx",
        "batch_label": "sharpen-sweep", "selected_group": ["ci", "night"], "platform": "linux", "overwrite": True,
        "tuning_search": {"search_type": "sampler", "search_options": {"n_iter": 5}, "parameter_search": {"a": [1, 2]}},
        "parameter_search_text": "return {a: [1, 2]}",
    }
    assert submission_request(data) == {
        "batch_label": "sharpen-sweep", "selected_group": ["ci", "night"], "platform": "linux", "overwrite": True,
        "tuning_search": {"search_type": "sampler", "search_options": {"n_iter": 5}, "parameter_search": {"a": [1, 2]}},
        "text": "return {a: [1, 2]}",
    }
    # one name, from older clients
    assert submission_request({**data, "selected_group": "ci"})["selected_group"] == ["ci"]
    # a long text is not kept: the parameters as sent are
    assert "text" not in submission_request({**data, "parameter_search_text": "x" * (MAX_REQUEST_TEXT_BYTES + 1)})
    assert submission_request(None)["selected_group"] == []


def test_history_reads_older_submissions_from_their_command():
    from backend.submissions import request_from_command, history_entry
    command = "qa --platform linux --label 'my sweep' batch --batches-file /x/a.yaml --batch ci --tuning-search '{\"search_type\": \"grid\", \"search_options\": {}, \"parameter_search\": {\"a\": [1, 2]}}' --action-on-existing sync --no-wait"
    assert request_from_command({"command": command}) == {
        "batch_label": "my sweep", "selected_group": ["ci"], "platform": "linux", "overwrite": False,
        "tuning_search": {"search_type": "grid", "search_options": {}, "parameter_search": {"a": [1, 2]}},
    }
    optimize = request_from_command({"command": "qa  --label auto optimize --batch ci --config-file /x/optim-config.yaml --checkpoint /x/journal.log "})
    assert optimize["tuning_search"]["search_type"] == "optimize" and optimize["incomplete"]
    for unknown in (None, {}, {"command": "qa batch"}, {"command": "bsub 'unbalanced"}, {"command": 7}):
        assert request_from_command(unknown) is None
    entry = history_entry({"id": "s1", "created_at": "2026-11-10T09:00:00Z", "user": "alice", "status": "done", "command": command}, batch_label="my-sweep", commit_id="abc")
    assert entry["batch_label"] == "my-sweep" and entry["commit_id"] == "abc" and entry["request"]["selected_group"] == ["ci"]
    assert history_entry({"id": "s1"}) is None


def test_tuning_history_lists_the_most_recent_first():
    from backend.api.tuning import tuning_history_entries
    request = {"batch_label": "x", "selected_group": ["ci"], "tuning_search": {"search_type": "grid", "parameter_search": {}}}
    def batch(label, submissions):
        return SimpleNamespace(label=label, data={"submissions": {s["id"]: s for s in submissions}})
    commit = SimpleNamespace(hexsha="abcdef", branch="feature/sharpen", message="Sharpen more\n\nDetails")
    batches = [
        (batch("old", [{"id": "s1", "created_at": "2026-11-01T09:00:00Z", "user": "alice", "request": request}]), commit),
        (batch("new", [
            {"id": "s2", "created_at": "2026-11-10T09:00:00Z", "user": "bob", "request": request},
            {"id": "s3", "created_at": "2026-11-12T09:00:00Z", "user": "alice", "request": request},
            {"id": "s4", "created_at": "2026-11-13T09:00:00Z", "user": "alice"},  # we can't tell what it asked
        ]), commit),
        (SimpleNamespace(label="none", data=None), commit),
    ]
    entries = tuning_history_entries(batches)
    assert [e["id"] for e in entries] == ["s3", "s2", "s1"]
    assert entries[0] == {"id": "s3", "created_at": "2026-11-12T09:00:00Z", "user": "alice", "status": None, "batch_label": "new", "request": request, "commit_id": "abcdef", "branch": "feature/sharpen", "message": "Sharpen more"}
    assert [e["id"] for e in tuning_history_entries(batches, user="alice")] == ["s3", "s1"]
    assert [e["id"] for e in tuning_history_entries(batches, limit=1)] == ["s3"]


def test_write_batches_snapshot(tmp_path):
    # `qa batch` reads one file, with only what runs: the batches, their nested aliases, and the file-level defaults
    import yaml
    from backend.api.tuning import write_batches_snapshot
    (tmp_path / "batches.yaml").write_text("# nightly runs\nconfigurations: [base]\nnight: {inputs: [a]}\nday: {inputs: [d]}\n")
    (tmp_path / "alice.yml").write_text("aliases: {all: [nights], nights: [night], other: [day]}\nnight: {inputs: [b]}\nmine: {}\n")
    files = [
        {"source": "commit", "path": "qa/batches.yaml", "location": tmp_path / "batches.yaml", "exists": True},
        {"source": "qaboard", "path": "alice.yml", "location": tmp_path / "alice.yml", "exists": True},
    ]
    (tmp_path / "log").mkdir()
    path, summary = write_batches_snapshot(files, ["all"], {}, tmp_path / "log", when="2026-11-18T10:00:00Z")
    assert path == tmp_path / "log" / "batches.yaml"
    assert summary == {"batches": ["night"], "aliases": ["all", "nights"], "files": ["alice.yml (in QA-Board)"], "inputs": []}
    text = path.read_text()
    assert "# from alice.yml (in QA-Board)" in text and "Started: 2026-11-18T10:00:00Z" in text
    assert yaml.safe_load(text) == {"aliases": {"all": ["nights"], "nights": ["night"]}, "night": {"inputs": ["b"]}}


def test_check_tuning_request_without_batches_files(tmp_path):
    from backend.api.tuning import check_tuning_request
    config = {"project": {"name": "repo"}, "inputs": {"batches": "sub/batches.yaml"}}
    ci_commit = make_commit(tmp_path, config)
    check = check_tuning_request(ci_commit, {"batch_label": "x", "selected_group": "smoke", "tuning_search": {"search_type": "grid"}})
    assert "No batches are defined" in " ".join(check["errors"])


def test_check_tuning_request_platforms_as_objects(tmp_path):
    # the web app shows platforms as {name, label}
    from backend.api.tuning import check_tuning_request
    config = {"project": {"name": "repo"}, "inputs": {"batches": "sub/batches.yaml", "platforms": [{"name": "linux", "label": "Linux"}, {"name": "s8"}]}}
    ci_commit = make_commit(tmp_path, config, batches={"smoke": {}})
    data = {"batch_label": "x", "selected_group": "smoke", "tuning_search": {"search_type": "grid"}}
    assert check_tuning_request(ci_commit, {**data, "platform": "linux"})["errors"] == []
    assert "Unknown platform" in " ".join(check_tuning_request(ci_commit, {**data, "platform": "windows"})["errors"])


def test_check_tuning_request_with_missing_artifacts_does_not_block(tmp_path):
    # starting restores the artifacts (and the batches files) first, then checks again
    from backend.api.tuning import check_tuning_request
    config = {"project": {"name": "repo"}, "inputs": {"batches": "sub/batches.yaml"}}
    ci_commit = make_commit(tmp_path, config)
    ci_commit.artifacts_status = lambda max_checked_files=500: {"ok": False, "problems": ["The artifacts were deleted."]}
    check = check_tuning_request(ci_commit, {"batch_label": "x", "selected_group": "smoke", "tuning_search": {"search_type": "grid"}})
    assert check["errors"] == []
    assert any("until the artifacts are back" in w for w in check["warnings"])


def test_commit_database_relative_to_the_artifacts():
    from pathlib import Path
    from backend.api.tuning import commit_database
    # in subprojects too, `qa` resolves relative paths from the root qaboard.yaml's folder
    commit = SimpleNamespace(
        repo_artifacts_dir=Path("/mnt/qaboard/kitefin/94/d909ca8934d5f2"),
        artifacts_dir=Path("/mnt/qaboard/kitefin/94/d909ca8934d5f2/detector"),
    )
    # inputs in the project: next to the code the batches started from QA-Board run
    assert commit_database(Path("inputs"), commit) == Path("/mnt/qaboard/kitefin/94/d909ca8934d5f2/inputs")
    assert commit_database(Path("/mnt/datasets"), commit) == Path("/mnt/datasets")
    # without a commit, as before
    assert commit_database(Path("inputs")) == Path("inputs")


def test_batch_script_runs_as_the_user(tmp_path):
    from pathlib import Path
    from backend.api.tuning import _generate_batch_script
    commit = SimpleNamespace(hexsha="94d909ca8934d5f214bd2280ff9ec7a4093f6ea2", uploaded_artifacts_dir=None, outputs_dir=Path("/mnt/qaboard/outputs/qaboard/x"))
    script = _generate_batch_script(commit, "arjun", tmp_path, "id", "qa batch ci", {})
    assert "export QA_USER=arjun;" in script
    assert script.index("export QA_USER") < script.index("qa batch ci")


# ==========================================
# Listing the tests in a batch: GET /api/v1/tests/group
# ==========================================
import pytest
from pathlib import Path
from unittest.mock import MagicMock


@pytest.fixture
def batches_setup(tmp_path, monkeypatch):
    """A commit whose qaboard.yaml lists batch files, only some of them saved in its artifacts."""
    import backend.api.tuning as tuning
    artifacts = tmp_path / "artifacts" / "group/repo" / "94" / "d909ca8934d5f2"
    (artifacts / "qa/tests").mkdir(parents=True)
    (artifacts / "qa/tests/tests.yaml").write_text("ci:\n  inputs: [a]\nbroken:\n  inputs: [missing-input]\nboth:\n  inputs: [a]\n")
    (artifacts / "qa/tests/modes.yaml").write_text("both:\n  inputs: [a, b]\n")
    database = tmp_path / "db"
    (database / "a").mkdir(parents=True)
    (database / "b").mkdir(parents=True)
    config = {
        "project": {"name": "group/repo", "entrypoint": "qa/main.py"},
        "inputs": {
            "database": {"linux": str(database)},
            "batches": ["qa/tests/tests.yaml", "qa/tests/nightly.yaml", "qa/tests/modes.yaml"],
        },
    }
    project = SimpleNamespace(id="group/repo", id_relative="", data={"qatools_config": config})
    commit = SimpleNamespace(
        hexsha="94d909ca8934d5f214bd2280ff9ec7a4093f6ea2",
        uploaded_artifacts_dir=None,
        project=project,
        data={"qatools_config": config},
        repo_artifacts_dir=artifacts,
        artifacts_dir=artifacts,
    )
    ci_commit = MagicMock()
    ci_commit.query.filter.return_value.one.return_value = commit
    monkeypatch.setattr(tuning, "CiCommit", ci_commit)
    monkeypatch.setattr(tuning, "Project", MagicMock(get_or_create=MagicMock(return_value=project)))
    monkeypatch.setattr(tuning, "qaboard_data_shared_dir", tmp_path / "shared")
    # listing tests needs the developer role (tested in integration_tests/test_access.py)
    monkeypatch.setattr(tuning, "require_project_access", lambda *args, **kwargs: None)
    return SimpleNamespace(commit=commit, config=config, artifacts=artifacts, database=database, tmp_path=tmp_path)


def list_tests(app, name, commit="94d909ca", batches_files=None):
    from backend.api.tuning import get_group
    query = {"project": "group/repo", "name": name, **({"commit": commit} if commit else {})}
    body = {"groups": ["extra-batches", "alice"], **({"batches_files": batches_files} if batches_files else {})}
    with app.test_request_context("/api/v1/tests/group", method="POST", query_string=query, json=body):
        return get_group().get_json()


def test_lists_a_batch_from_sent_files(dummy_app, batches_setup):
    # e.g. the snapshot of an earlier batch, to run it again: it wins
    data = list_tests(dummy_app, "ci", batches_files=[{"path": "batches.yaml", "content": "ci: {inputs: [b]}\n"}])
    assert data["tests"] == [{"input_path": "b", "configurations": []}]
    assert data["definitions"] == [{"name": "ci", "files": ["qa/tests/tests.yaml", "batches.yaml"], "sources": ["commit", "sent"]}]
    from backend.api.tuning import get_group
    with dummy_app.test_request_context("/api/v1/tests/group", method="POST", query_string={"project": "group/repo", "name": "ci"}, json={"groups": [], "batches_files": "x"}):
        response, status = get_group()
    assert status == 400


def test_lists_a_batch_and_where_it_is_defined(dummy_app, batches_setup):
    data = list_tests(dummy_app, "ci")
    assert data["tests"] == [{"input_path": "a", "configurations": []}]
    assert data["definitions"] == [{"name": "ci", "files": ["qa/tests/tests.yaml"], "sources": ["commit"]}]
    assert [(f["path"], f["status"]) for f in data["files"]] == [
        ("qa/tests/tests.yaml", "ok"),
        ("qa/tests/nightly.yaml", "missing"),
        ("qa/tests/modes.yaml", "ok"),
        ("extra-batches.yml", "empty"),
        ("alice.yml", "empty"),
    ]
    assert data["files"][1]["location"] == str(batches_setup.artifacts / "qa/tests/nightly.yaml")
    # the file missing from the artifacts is a warning, even when the batch is found
    assert len(data["warnings"]) == 1
    assert "Not in this commit's artifacts" in data["warnings"][0] and "qa/tests/nightly.yaml" in data["warnings"][0]


def test_the_last_file_defining_a_batch_wins_like_for_qa_batch(dummy_app, batches_setup):
    data = list_tests(dummy_app, "both")
    assert data["definitions"] == [{"name": "both", "files": ["qa/tests/tests.yaml", "qa/tests/modes.yaml"], "sources": ["commit", "commit"]}]
    assert [t["input_path"] for t in data["tests"]] == ["a", "b"]


def test_lists_the_tests_of_several_batches(dummy_app, batches_setup):
    from backend.api.tuning import get_group
    query = [("project", "group/repo"), ("commit", "94d909ca"), ("name[]", "ci"), ("name[]", "both")]
    with dummy_app.test_request_context("/api/v1/tests/group", method="POST", query_string=query, json={"groups": []}):
        data = get_group().get_json()
    assert [t["input_path"] for t in data["tests"]] == ["a", "a", "b"]
    assert [d["name"] for d in data["definitions"]] == ["ci", "both"]


def test_lists_the_batches_people_can_run(dummy_app, batches_setup):
    """The form shows the batches to choose from: the commit's, the shared and the private ones, and the aliases"""
    from backend.api.tuning import list_batches
    shared = batches_setup.tmp_path / "shared/group/repo"
    shared.mkdir(parents=True)
    (shared / "extra-batches.yml").write_text(
        "lab: &lab {linux: /mnt/lab}\n.template: {inputs: [a]}\nhdr:\n  database: *lab\n  inputs: [x, y, z]\n  configs: [base, hdr]\n"
        "aliases:\n  everything: [ci, nightly-all]\n  nightly-all: [hdr]\n"
    )
    with dummy_app.test_request_context("/api/v1/tests/batches", method="POST", query_string={"project": "group/repo", "commit": "94d909ca"}, json={"groups": ["extra-batches", "alice"]}):
        data = list_batches().get_json()
    batches = {b["name"]: b for b in data["batches"]}
    # not the reused value, nor the template
    assert list(batches) == ["ci", "broken", "both", "hdr", "everything", "nightly-all"]
    assert batches["ci"] == {"name": "ci", "kind": "batch", "files": ["qa/tests/tests.yaml"], "sources": ["commit"], "inputs": 1}
    assert batches["both"]["files"] == ["qa/tests/tests.yaml", "qa/tests/modes.yaml"] and batches["both"]["inputs"] == 2
    assert batches["hdr"] == {"name": "hdr", "kind": "batch", "files": ["extra-batches.yml"], "sources": ["qaboard"], "inputs": 3, "configurations": 2}
    assert batches["everything"] == {"name": "everything", "kind": "alias", "batches": ["ci", "hdr"]}
    # the user's file doesn't exist yet: we don't create it, and it's not an error
    assert [(f["path"], f["status"]) for f in data["files"]] == [("qa/tests/tests.yaml", "ok"), ("qa/tests/nightly.yaml", "missing"), ("qa/tests/modes.yaml", "ok"), ("extra-batches.yml", "ok")]
    assert not (shared / "alice.yml").exists()
    assert len(data["warnings"]) == 1 and "qa/tests/nightly.yaml" in data["warnings"][0]


def test_gives_a_batch_definition_to_copy_it(dummy_app, batches_setup):
    """Copied to another file, the batch runs the same: its file's defaults come with it, and the last file wins"""
    from backend.api.tuning import list_batches
    (batches_setup.artifacts / "qa/tests/modes.yaml").write_text("database: {linux: /mnt/modes}\nconfigs: [base]\nboth:\n  inputs: [a, b]\nown:\n  inputs: [a]\n  configs: [hdr]\n")
    def definition(name):
        with dummy_app.test_request_context("/api/v1/tests/batches", method="POST", query_string={"project": "group/repo", "commit": "94d909ca", "definition": name}, json={"groups": []}):
            return list_batches().get_json()["definition"]
    assert definition("both") == {"inputs": ["a", "b"], "database": {"linux": "/mnt/modes"}, "configs": ["base"]}
    assert definition("own") == {"inputs": ["a"], "configs": ["hdr"], "database": {"linux": "/mnt/modes"}}
    assert definition("ci") == {"inputs": ["a"]}
    assert definition("nope") is None


def test_says_when_a_batch_is_not_defined(dummy_app, batches_setup):
    data = list_tests(dummy_app, "nightly")
    assert data["tests"] == []
    assert data["definitions"] == []
    assert any("`nightly` is not defined in the batch files QA-Board could read: `qa/tests/tests.yaml`, `qa/tests/modes.yaml`" in w for w in data["warnings"])


def test_says_which_inputs_are_missing(dummy_app, batches_setup):
    data = list_tests(dummy_app, "broken")
    assert data["tests"] == []
    assert data["definitions"] == [{"name": "broken", "files": ["qa/tests/tests.yaml"], "sources": ["commit"]}]
    assert f"Inputs not found by the QA-Board server: `missing-input` under `{batches_setup.database}`." in data["warnings"]


def test_says_when_the_server_cannot_see_the_database(dummy_app, batches_setup):
    batches_setup.config["inputs"]["database"] = {"linux": str(batches_setup.tmp_path / "not-mounted")}
    data = list_tests(dummy_app, "ci")
    assert data["tests"] == []
    assert any("can't see the database" in w and "not-mounted" in w for w in data["warnings"])


def test_says_when_the_artifacts_are_missing(dummy_app, batches_setup):
    batches_setup.commit.repo_artifacts_dir = batches_setup.tmp_path / "deleted"
    data = list_tests(dummy_app, "ci")
    assert data["tests"] == []
    assert {f["status"] for f in data["files"] if f["source"] == "commit"} == {"missing"}
    assert any(w.startswith("This commit's artifacts folder does not exist") for w in data["warnings"])


def test_says_when_a_file_is_invalid(dummy_app, batches_setup):
    (batches_setup.artifacts / "qa/tests/modes.yaml").write_text("both: [a\n")
    data = list_tests(dummy_app, "ci")
    assert data["tests"] == [{"input_path": "a", "configurations": []}]
    assert data["files"][2]["status"] == "invalid"
    assert any(w.startswith("Could not read `qa/tests/modes.yaml`:") for w in data["warnings"])


def test_commits_without_their_qaboard_yaml_use_the_projects(dummy_app, batches_setup):
    batches_setup.commit.data = {}
    data = list_tests(dummy_app, "ci")
    assert data["tests"] == [{"input_path": "a", "configurations": []}]
    assert any("doesn't have this commit's qaboard.yaml" in w for w in data["warnings"])


def test_patterns_and_the_commits_project_in_paths(dummy_app, batches_setup):
    (batches_setup.database / "repo" / "c").mkdir(parents=True)
    batches_setup.config["inputs"]["batches"] = "qa/*/tests.yaml"
    # filled with the commit's project, not the server's
    batches_setup.config["inputs"]["database"] = str(batches_setup.database / "{project.name}")
    (batches_setup.artifacts / "qa/tests/tests.yaml").write_text("ci:\n  inputs: [c]\n")
    data = list_tests(dummy_app, "ci")
    assert data["tests"] == [{"input_path": "c", "configurations": []}]
    assert data["files"][0]["path"] == "qa/tests/tests.yaml"
    assert data["warnings"] == []


def test_missing_inputs_from_qa_batch_logs():
    from backend.api.tuning import missing_inputs_from_logs
    logs = "\n".join([
        "Working	directory changed to: /mnt/qaboard/group/repo/94/d909ca8934d5f2",
        'WARNING: No inputs found for the batch "night/*.raw" under /stage/datasets',
        'WARNING: No inputs found matching "day" [[\'*.jpg\']] under "/stage/datasets/v2".',
    ])
    assert missing_inputs_from_logs(logs) == [
        {"input": "night/*.raw", "database": "/stage/datasets"},
        {"input": "day", "database": "/stage/datasets/v2"},
    ]


def test_says_which_input_is_wrong(dummy_app, batches_setup):
    (batches_setup.artifacts / "qa/tests/tests.yaml").write_text("ci:\n  inputs:\n  - a\n  -\n")
    data = list_tests(dummy_app, "ci")
    assert data["tests"] == []
    # the file as in qaboard.yaml, not its path in the artifacts
    assert data["error"] == 'qa/tests/tests.yaml:4: The batch "ci" has an empty input, after "a": a "-" with nothing after it. Remove the "-", or write the input after it.'
    assert data["definitions"] == [{"name": "ci", "files": ["qa/tests/tests.yaml"], "sources": ["commit"]}]


def test_lists_a_batch_without_a_commit_with_the_projects_config(dummy_app, batches_setup):
    import copy
    project_config = copy.deepcopy(batches_setup.config)
    (batches_setup.tmp_path / "shared" / "group/repo").mkdir(parents=True)
    (batches_setup.tmp_path / "shared" / "group/repo" / "alice.yml").write_text("mine:\n  inputs: [b]\n")
    data = list_tests(dummy_app, "mine", commit=None)
    assert data["tests"] == [{"input_path": "b", "configurations": []}]
    assert [f["source"] for f in data["files"]] == ["qaboard", "qaboard"]
    # the project's config is left as it was
    assert batches_setup.config == project_config


@pytest.fixture
def custom_iter_inputs(batches_setup, monkeypatch):
    """The commit's entrypoint defines iter_inputs: the server lists the tests with `qa batch --list`."""
    import backend.api.tuning as tuning
    (batches_setup.artifacts / "qa/main.py").write_text("def iter_inputs(*args):\n  pass\n")
    monkeypatch.setattr(tuning, "check_storage_path", lambda path: None)
    # the server runs the project's code only when admins opted in
    monkeypatch.setenv("QABOARD_TUNING_RUNNER", "local")
    return batches_setup


def list_tests_response(app, name):
    from backend.api.tuning import get_group
    query = {"project": "group/repo", "name": name, "commit": "94d909ca"}
    with app.test_request_context("/api/v1/tests/group", method="POST", query_string=query, json={"groups": []}):
        result = get_group()
        response, status = result if isinstance(result, tuple) else (result, result.status_code)
        return response.get_json(), status


def test_listing_with_the_projects_code_in_a_missing_folder(dummy_app, custom_iter_inputs):
    custom_iter_inputs.commit.artifacts_dir = custom_iter_inputs.tmp_path / "deleted"
    data, status = list_tests_response(dummy_app, "ci")
    assert status == 500
    assert data["error"].startswith("Could not list the tests with the project's code:")


def test_listing_with_the_projects_code_times_out(dummy_app, custom_iter_inputs, monkeypatch):
    import subprocess
    import backend.api.tuning as tuning
    def too_slow(cmd, cwd, timeout, env=None):
        assert timeout == tuning.LIST_TESTS_TIMEOUT
        raise subprocess.TimeoutExpired(cmd, timeout)
    monkeypatch.setattr(tuning, "run_with_timeout", too_slow)
    data, status = list_tests_response(dummy_app, "ci")
    assert status == 504
    assert "took more than" in data["error"]


def test_collection_refs_of_batch_files():
    from backend.api.tuning import collection_refs
    batches = [
        {"a": {"collections": [" night@2 ", {"name": "night@2", "configurations": [{"collections": 3}]}], "inputs": ["x.jpg"]},
         "b": {"matrix": {}, "collections": "g/r:day", "inputs": [{"collection": "not/a@ref"}]},
         "c": {"collections": [{"name": "hdr"}, {"configurations": []}, None, 3, {"name": ["x"]}]}},
        None,
    ]
    # in `collections`, as a ref or under `name`; a mapping in `inputs` is an input, even named "collection"
    assert collection_refs(batches) == ["night@2", "g/r:day", "hdr"]


def test_listing_with_the_projects_code_resolves_collections_first(dummy_app, custom_iter_inputs, monkeypatch):
    """`qa batch --list` started by the server has no token to ask it for collections: it gets them in a file"""
    import json
    import subprocess
    import backend.api.tuning as tuning
    import backend.api.collections as collections_api
    from qaboard.input_collections import Collection, CollectionError, CollectionInput, CollectionNotFound, resolver_from_file, RESOLVED_COLLECTIONS_ENV
    (custom_iter_inputs.artifacts / "qa/tests/tests.yaml").write_text("ci:\n  collections:\n    - night@2\n    - typo\n    - name: group:night@2\n      configurations: [x]\n    - other/secret:night@1\n")
    asked = []
    def in_process_resolver(project_id):
        def resolve(ref, project=None):
            asked.append((project_id, ref))
            if ref == 'typo':
                raise CollectionNotFound("No collection named typo in group/repo.", ref=ref, project=project_id, status=404)
            return Collection(ref=ref, project='group', name='night', version=2, id=7, inputs=[CollectionInput(1, '/db', 'a')])
        return resolve
    monkeypatch.setattr(collections_api, "in_process_resolver", in_process_resolver)
    seen = {}
    def qa_batch_list(cmd, cwd, timeout, env=None):
        path = env[RESOLVED_COLLECTIONS_ENV]
        seen['path'] = path
        resolve = resolver_from_file(path)
        night = resolve('night@2', 'group/repo')
        seen['night'] = (night.name, night.version, night.project, [(i.database, i.path) for i in night])
        with pytest.raises(CollectionNotFound, match='No collection named typo'):
            resolve('typo')
        # the commit's code reads the file: never another project's collections, even if the viewer reads them
        with pytest.raises(CollectionError, match='can only use its collections and its parent projects'):
            resolve('other/secret:night@1')
        runs = [{"rel_input_path": i.path, "configurations": []} for i in night.inputs]
        return subprocess.CompletedProcess(cmd, 0, json.dumps(runs), "")
    monkeypatch.setattr(tuning, "run_with_timeout", qa_batch_list)
    data, status = list_tests_response(dummy_app, "ci")
    assert status == 200 and data["tests"] == [{"input_path": "a", "configurations": []}]
    assert asked == [("group/repo", "night@2"), ("group/repo", "typo"), ("group/repo", "group:night@2")]
    assert seen['night'] == ('night', 2, 'group', [('/db', 'a')])
    # removed once listed
    assert not Path(seen['path']).exists()


def test_listing_with_the_projects_code_without_collections(dummy_app, custom_iter_inputs, monkeypatch):
    import subprocess
    import backend.api.tuning as tuning
    envs = []
    def qa_batch_list(cmd, cwd, timeout, env=None):
        envs.append(env)
        return subprocess.CompletedProcess(cmd, 0, "[]", "")
    monkeypatch.setattr(tuning, "run_with_timeout", qa_batch_list)
    data, status = list_tests_response(dummy_app, "ci")
    from qaboard.input_collections import RESOLVED_COLLECTIONS_ENV
    # the environment without the server's secrets, and without a collections file
    assert status == 200 and len(envs) == 1 and RESOLVED_COLLECTIONS_ENV not in envs[0]


@pytest.mark.parametrize("runner", [None, "lsf", "kubernetes"])
def test_listing_with_the_projects_code_needs_the_opt_in(dummy_app, custom_iter_inputs, monkeypatch, runner):
    import backend.api.tuning as tuning
    if runner:
        monkeypatch.setenv("QABOARD_TUNING_RUNNER", runner)
    else:
        monkeypatch.delenv("QABOARD_TUNING_RUNNER")
    def never(*args, **kwargs):
        raise AssertionError("ran the project's code")
    monkeypatch.setattr(tuning, "run_with_timeout", never)
    data, status = list_tests_response(dummy_app, "ci")
    assert status == 200
    assert data["tests"] == [] and data["unlisted"] is True
    assert any("its own `iter_inputs`" in w and "qa batch ci --list" in w for w in data["warnings"])


def test_listing_with_the_projects_code_has_no_server_secrets(dummy_app, custom_iter_inputs, monkeypatch):
    import subprocess
    import backend.api.tuning as tuning
    monkeypatch.setenv("QABOARD_DB_PASSWORD", "hunter2")
    monkeypatch.setenv("QABOARD_SECRET_KEY", "flask-secret")
    seen = {}
    def run(cmd, cwd, timeout, env=None):
        seen["env"] = env
        return subprocess.CompletedProcess(cmd, 0, '[{"rel_input_path": "a", "configurations": []}]', "")
    monkeypatch.setattr(tuning, "run_with_timeout", run)
    data, status = list_tests_response(dummy_app, "ci")
    assert data["tests"] == [{"input_path": "a", "configurations": []}]
    assert "PATH" in seen["env"]
    assert not {"QABOARD_DB_PASSWORD", "QABOARD_SECRET_KEY"} & set(seen["env"])


def test_run_with_timeout_stops_what_the_command_started(tmp_path):
    import time
    import subprocess
    from backend.api.tuning import run_with_timeout
    assert run_with_timeout(["bash", "-c", "echo out; echo err >&2"], cwd=tmp_path, timeout=10).stdout == "out\n"
    marker = tmp_path / "still-running"
    start = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired):
        run_with_timeout(["bash", "-c", f"(sleep 1; touch {marker}) & sleep 30"], cwd=tmp_path, timeout=0.3)
    assert time.monotonic() - start < 5
    time.sleep(1.5)
    assert not marker.exists()


def test_mkdir_for_everyone_leaves_the_umask_alone(tmp_path):
    import os
    from backend.api.tuning import mkdir_for_everyone
    (tmp_path / "existing").mkdir()
    (tmp_path / "existing").chmod(0o755)
    previous = os.umask(0o022)
    try:
        mkdir_for_everyone(tmp_path / "existing" / "batch" / "logs")
        assert os.umask(0o022) == 0o022
    finally:
        os.umask(previous)
    assert ((tmp_path / "existing" / "batch").stat().st_mode & 0o777) == 0o777
    assert ((tmp_path / "existing" / "batch" / "logs").stat().st_mode & 0o777) == 0o777
    assert ((tmp_path / "existing").stat().st_mode & 0o777) == 0o755
    mkdir_for_everyone(tmp_path / "existing" / "batch" / "logs")  # already there


def test_celery_dispatch_gives_the_broker_in_the_environment_not_the_script(tmp_path, monkeypatch):
    """The script is saved with the batch's logs: the broker's password stays out of it"""
    import backend.api.tuning as tuning
    script = tmp_path / "qa_batch.sh"
    script.write_text('#!/bin/bash\necho "broker=$CELERY_BROKER_URL db=${QABOARD_DB_PASSWORD:-none} host=$QABOARD_HOST"\n')
    monkeypatch.setenv("CELERY_BROKER_URL", "pyamqp://qaboard:secret@rabbitmq//")
    monkeypatch.setenv("QABOARD_DB_PASSWORD", "db-secret")
    monkeypatch.setenv("QABOARD_HOST", "qaboard.example.com")
    submission = tuning._dispatch_celery(script, tmp_path, "c0ffee00-0000")
    assert submission["status"] == "done", (tmp_path / "log.txt").read_text()
    assert "secret" not in script.read_text()
    assert "export QABOARD_HOST=qaboard.example.com\n" in script.read_text()
    assert "broker=pyamqp://qaboard:secret@rabbitmq// db=none host=qaboard.example.com" in (tmp_path / "log.txt").read_text()

    # without the celery runner, no broker either
    script.write_text('#!/bin/bash\necho "broker=${CELERY_BROKER_URL:-none}"\n')
    assert tuning._dispatch_local(script, tmp_path, "c0ffee00-0001")["status"] == "done"
    assert (tmp_path / "log.txt").read_text().splitlines()[-1] == "broker=none"
    # unless the project's runner may be celery
    commit = SimpleNamespace(project=SimpleNamespace(data={"qatools_config": {"runners": {"default": "lsf", "celery": {}}}}))
    tuning._dispatch_local(script, tmp_path, "c0ffee00-0002", commit)
    assert (tmp_path / "log.txt").read_text().splitlines()[-1] == "broker=pyamqp://qaboard:secret@rabbitmq//"


def test_local_dispatch_does_not_wait_for_qa_batch(tmp_path, monkeypatch):
    """qa batch runs detached: the request returns, and uWSGI's harakiri doesn't kill it. Stopping the batch kills it."""
    import time
    import socket
    import psutil
    import backend.api.tuning as tuning
    from backend.local_jobs import refresh_status, stop_local_submissions
    monkeypatch.setenv("QABOARD_LOCAL_START_WAIT", "0.5")
    script = tmp_path / "qa_batch.sh"
    # like `qa batch` with the local runner: runs in the background, one in its own session (with a timeout)
    script.write_text(
        '#!/bin/bash\ntrap \'echo "[qaboard] qa batch exited with code $?"\' EXIT\n'
        'sleep 600 & echo $! > child.pid\n'
        'setsid sleep 600 & echo $! > own-session.pid\n'
        'wait\n'
    )
    started = time.monotonic()
    submission = tuning._dispatch_local(script, tmp_path, "c0ffee00-0003")
    assert time.monotonic() - started < 10
    assert submission["status"] == "submitted", (tmp_path / "log.txt").read_text()
    assert submission["host"] == socket.gethostname()
    assert submission["pid"] != submission["pgid"]
    submission = {**submission, "id": "c0ffee00-0003", "runner": "local", "log_dir": str(tmp_path)}
    assert refresh_status(submission) == submission

    # Someone wrote a submission with our pid: it's not theirs
    forged = {**submission, "id": "forged-0000"}
    assert stop_local_submissions({"submissions": {"forged-0000": forged}})["stopped"] == []
    assert psutil.pid_exists(submission["pid"])

    # Stopping the batch kills qa batch and what it started
    children = [int((tmp_path / name).read_text()) for name in ("child.pid", "own-session.pid")]
    stopped = stop_local_submissions({"submissions": {submission["id"]: submission}})
    assert stopped == {"stopped": [submission["id"]], "errors": []}
    def running(pid):
        return psutil.pid_exists(pid) and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    for _ in range(50):
        if not any(running(pid) for pid in [submission["pid"], *children]):
            break
        time.sleep(0.1)
    else:
        raise AssertionError("qa batch, or what it started, still runs")
    # it's gone without an exit code
    assert refresh_status(submission)["status"] == "failed"


def test_local_submissions_on_other_hosts_are_not_stopped(tmp_path):
    from backend.local_jobs import stop_local_submissions, refresh_status
    submission = {"id": "c0ffee00-0004", "runner": "celery", "status": "submitted", "pid": 1, "pgid": 1, "host": "another-replica", "log_dir": str(tmp_path)}
    stopped = stop_local_submissions({"submissions": {submission["id"]: submission}})
    assert stopped["stopped"] == []
    assert "another-replica" in stopped["errors"][0]
    # we can't tell how it is
    assert refresh_status(submission) == submission
    # until it writes its exit code
    (tmp_path / "exit_code").write_text("2\n")
    assert refresh_status(submission) == {**submission, "status": "failed", "exit_code": 2}
    assert stop_local_submissions({"submissions": {submission["id"]: submission}}) == {"stopped": [], "errors": []}


def test_qa_environment_has_no_secrets():
    from backend.local_jobs import qa_environment
    server = {
        "PATH": "/usr/bin", "HOME": "/home/qaboard", "LANG": "C.UTF-8", "QABOARD_HOST": "qaboard", "QABOARD_PROTOCOL": "https",
        "http_proxy": "http://proxy:3128", "no_proxy": "localhost", "REQUESTS_CA_BUNDLE": "/etc/ssl/ca.pem", "SSL_CERT_FILE": "/etc/ssl/ca.pem",
        "QA_RUNNERS_LSF_BRIDGE": "ssh lsf {bsub_command}", "QA_STORAGE": "/mnt", "QABOARD_STORAGE_ROOTS": "/mnt",
        "SECRET_KEY": "x", "QABOARD_DB_PASSWORD": "x", "QABOARD_DB_HOST": "db", "QABOARD_DB_USER": "qaboard",
        "QABOARD_LDAP_PASSWORD": "x", "QABOARD_LDAP_BIND_DN": "cn=x", "QABOARD_SMTP_PASSWORD": "x", "QABOARD_SMTP_USER": "x",
        "QABOARD_OIDC_CLIENT_SECRET": "x", "QABOARD_OIDC_CLIENT_ID": "x", "QABOARD_SAML_DIR": "/saml", "QABOARD_ENCRYPTION_KEY": "x",
        "JENKINS_AUTH": "x", "GITLAB_AUTH": "x", "GITHUB_TOKEN": "x", "SENTRY_DSN": "https://x@sentry", "POSTHOG_API_KEY": "x",
        "DATABASE_URL": "postgresql://x", "AWS_SECRET_ACCESS_KEY": "x", "GOOGLE_APPLICATION_CREDENTIALS": "/key.json",
        "CELERY_BROKER_URL": "pyamqp://qaboard:x@rabbitmq//", "CELERY_RESULT_BACKEND": "rpc://",
        # credentials in a URL, whatever the name
        "SOME_SERVICE_URL": "https://user:pw@service", "https_proxy": "http://user:pw@proxy:3128",
    }
    env = qa_environment("c0ffee00", environ=server)
    assert env == {
        "PATH": "/usr/bin", "HOME": "/home/qaboard", "LANG": "C.UTF-8", "QABOARD_HOST": "qaboard", "QABOARD_PROTOCOL": "https",
        "http_proxy": "http://proxy:3128", "no_proxy": "localhost", "REQUESTS_CA_BUNDLE": "/etc/ssl/ca.pem", "SSL_CERT_FILE": "/etc/ssl/ca.pem",
        "QA_RUNNERS_LSF_BRIDGE": "ssh lsf {bsub_command}", "QA_STORAGE": "/mnt", "QABOARD_STORAGE_ROOTS": "/mnt",
        "QABOARD_SUBMISSION_ID": "c0ffee00",
    }
    celery_env = qa_environment("c0ffee00", celery=True, environ=server)
    assert celery_env == {**env, "CELERY_BROKER_URL": "pyamqp://qaboard:x@rabbitmq//", "CELERY_RESULT_BACKEND": "rpc://"}


# Batches started by API clients, like `qa batch --commit`: they get the web app form's defaults, and can send batch files

def test_requests_get_the_web_apps_defaults():
    from backend.api.tuning import with_defaults
    data = with_defaults({"batch_label": "x", "selected_group": "smoke"}, user_name="alice")
    # the shared and private batches the web app sends, a batch without tuning, existing runs are kept
    assert data["groups"] == ["extra-batches", "alice"]
    assert data["tuning_search"] == {"search_type": "grid", "parameter_search": {}}
    assert data["overwrite"] is False
    # what clients give is kept
    assert with_defaults({"groups": [], "overwrite": True})["groups"] == []
    assert with_defaults({"tuning_search": {"search_type": "sampler", "search_options": {"n_iter": 3}}})["tuning_search"] == {"search_type": "sampler", "search_options": {"n_iter": 3}, "parameter_search": {}}
    assert with_defaults({"tuning_search": {"search_type": "optimize", "parameter_search": "objective: {}"}})["tuning_search"]["parameter_search"] == "objective: {}"
    assert with_defaults(None)["groups"] == ["extra-batches"]


def test_several_batches_can_be_selected(tmp_path):
    from backend.api.tuning import check_tuning_request, selected_batches
    config = {"project": {"name": "repo"}, "inputs": {"batches": "sub/batches.yaml"}}
    ci_commit = make_commit(tmp_path, config, batches={"smoke": {}, "night": {}, "aliases": {"all": ["smoke", "night"]}})
    check = check_tuning_request(ci_commit, {"batch_label": "x", "selected_group": ["smoke", "all"], "groups": []})
    assert check["errors"] == []
    assert check["batches"] == ["smoke", "smoke", "night"]
    assert selected_batches({"selected_group": [" a ", "", None]}) == (["a"], [])
    assert selected_batches({"selected_group": ""})[1] == ["Select the batch of inputs to run on."]
    assert "list of names" in selected_batches({"selected_group": [{"a": 1}]})[1][0]


def test_sent_batch_files_are_read_last(tmp_path):
    from backend.api.tuning import check_tuning_request
    config = {"project": {"name": "repo"}, "inputs": {"batches": "sub/batches.yaml"}}
    ci_commit = make_commit(tmp_path, config, batches={"night": {"inputs": ["a"]}})
    sent = [{"path": "qa/local.yaml", "content": "night: {inputs: [b]}\nmine: {inputs: [c]}\n"}]
    data = {"batch_label": "x", "selected_group": ["night", "mine"], "groups": [], "batches_files": sent}
    check = check_tuning_request(ci_commit, data)
    assert check["errors"] == []
    # users see that their file wins
    assert check["definitions"] == [
        {"name": "night", "files": ["sub/batches.yaml", "qa/local.yaml"], "sources": ["commit", "sent"]},
        {"name": "mine", "files": ["qa/local.yaml"], "sources": ["sent"]},
    ]
    assert [(f["source"], f["path"]) for f in check["batches_files"]] == [("commit", "sub/batches.yaml"), ("sent", "qa/local.yaml")]


def test_invalid_sent_batch_files_are_errors(tmp_path):
    from backend.api.tuning import sent_batches_files, check_tuning_request, MAX_SENT_BATCHES_FILES
    assert sent_batches_files(None) == ([], [])
    assert "should be a list" in sent_batches_files({"path": "a.yaml"})[1][0]
    assert "Too many" in sent_batches_files([{"path": "a.yaml", "content": ""}] * (MAX_SENT_BATCHES_FILES + 1))[1][0]
    for invalid in ({"path": "a.yaml"}, {"path": "..", "content": "a: {}"}, {"path": "a\0.yaml", "content": "a: {}"}, "a.yaml"):
        files, errors = sent_batches_files([invalid])
        assert files == [] and "Invalid batch file" in errors[0], invalid
    assert "too large" in sent_batches_files([{"path": "a.yaml", "content": "#" * (2 * 1024 * 1024)}])[1][0]
    # unlike the commit's files, users can fix them before starting: we don't start
    files, errors = sent_batches_files([{"path": "a.yaml", "content": "a: [b"}, {"path": "b.yaml", "content": "- a"}])
    assert files == [] and len(errors) == 2
    assert errors[0].startswith("Could not read the batches in a.yaml:") and "Expected batch names" in errors[1]
    config = {"project": {"name": "repo"}, "inputs": {"batches": "sub/batches.yaml"}}
    ci_commit = make_commit(tmp_path, config, batches={"night": {}})
    check = check_tuning_request(ci_commit, {"batch_label": "x", "selected_group": "night", "groups": [], "batches_files": [{"path": "a.yaml", "content": "a: [b"}]})
    assert check["errors"][0].startswith("Could not read the batches in a.yaml:")


def test_missing_artifacts_tell_how_to_recreate_them(tmp_path, monkeypatch):
    import backend.api.tuning as tuning
    monkeypatch.setattr(tuning, "docs_link", lambda path: f"https://qaboard.example.com{path}")
    config = {"project": {"name": "repo"}, "inputs": {"batches": "sub/batches.yaml"}}
    ci_commit = make_commit(tmp_path, config)
    ci_commit.artifacts_status = lambda max_checked_files=500: {"ok": False, "problems": ["The artifacts were deleted."]}
    check = tuning.check_tuning_request(ci_commit, {"batch_label": "x", "selected_group": "smoke", "groups": []})
    warning = next(w for w in check["warnings"] if "artifacts are missing" in w)
    assert "`recreate_artifacts`" in warning and "https://qaboard.example.com/docs/storage/deleting-old-data#recreating-artifacts" in warning


def lookup(monkeypatch, hexshas, exact=None):
    import backend.api.tuning as tuning
    ci_commit = MagicMock()
    ci_commit.query.filter.return_value.first.return_value = SimpleNamespace(hexsha=exact) if exact else None
    ci_commit.query.filter.return_value.order_by.return_value.limit.return_value.all.return_value = [SimpleNamespace(hexsha=h) for h in hexshas]
    monkeypatch.setattr(tuning, "CiCommit", ci_commit)
    return tuning.lookup_commit("group/repo", "abc")


@pytest.mark.parametrize("runner, message", [
    (None, "doesn't start batches itself"),
    ("  ", "doesn't start batches itself"),
    ("typo", "(typo) isn't local, celery, lsf or kubernetes"),
])
def test_batches_are_refused_when_the_server_starts_none(tmp_path, monkeypatch, dummy_app, runner, message):
    """Without QABOARD_TUNING_RUNNER, the server doesn't run the projects' code in its container: the form says it first"""
    import backend.api.tuning as tuning
    if runner is None:
        monkeypatch.delenv("QABOARD_TUNING_RUNNER")
    else:
        monkeypatch.setenv("QABOARD_TUNING_RUNNER", runner)
    commit = make_commit(tmp_path, {"project": {"name": "repo"}, "inputs": {"batches": "sub/batches.yaml"}}, batches={"night": {"inputs": ["a"]}})
    with dummy_app.test_request_context():
        errors = tuning.check_tuning_request(commit, {"batch_label": "x", "selected_group": "night"})["errors"]
    assert len(errors) == 1 and message in errors[0]
    assert "`qa batch`" in errors[0] and "it still works" in errors[0] and "/docs/backend-admin/runners" in errors[0]
    # starting it is refused before anything is restored or written
    import flask
    monkeypatch.setattr(tuning, "lookup_commit", lambda project_id, hexsha: (commit, None))
    monkeypatch.setattr(tuning, "require_project_access", lambda user, project_id: None)
    commit.ensure_artifacts = MagicMock()
    commit.get_or_create_batch = MagicMock()
    with dummy_app.test_request_context("/api/v1/commit/abcdef/batch", method="POST", query_string={"project": "repo/sub"}, json={"batch_label": "x", "selected_group": "night"}):
        flask.g.user = {"user_name": "alice"}
        response, status = tuning.start_tuning("abcdef")
    assert status == 400 and response.get_json()["reason"] == "no_server_runner" and message in response.get_json()["error"]
    commit.ensure_artifacts.assert_not_called()
    commit.get_or_create_batch.assert_not_called()


@pytest.mark.parametrize("runner", ["local", "celery", "lsf", "kubernetes"])
def test_batches_start_with_a_server_runner(tmp_path, monkeypatch, runner):
    import backend.api.tuning as tuning
    monkeypatch.setenv("QABOARD_TUNING_RUNNER", runner)
    commit = make_commit(tmp_path, {"project": {"name": "repo"}, "inputs": {"batches": "sub/batches.yaml"}}, batches={"night": {"inputs": ["a"]}})
    assert tuning.check_tuning_request(commit, {"batch_label": "x", "selected_group": "night"})["errors"] == []


def test_unknown_or_ambiguous_commits(monkeypatch):
    commit, error = lookup(monkeypatch, ["abc123"])
    assert commit.hexsha == "abc123" and error is None
    commit, (body, status) = lookup(monkeypatch, [])
    assert commit is None and status == 404 and "doesn't know the commit abc in group/repo" in body["error"] and body["errors"] == [body["error"]]
    # a short prefix doesn't pick one of the commits for users
    commit, (body, status) = lookup(monkeypatch, ["abc123456789aa", "abc987654321bb", "abc0"])
    assert commit is None and status == 400 and "Several commits" in body["error"] and "abc123456" in body["error"]
    # ids that are not git hashes, like v1 and v10: the exact one wins
    commit, error = lookup(monkeypatch, ["abc", "abcd"], exact="abc")
    assert commit.hexsha == "abc" and error is None


def test_aliases_can_not_stand_for_too_many_batches(tmp_path):
    from backend.api.tuning import check_tuning_request, resolved_batches
    from qaboard.iterators import resolve_aliases
    # aliases that refer to each other stop
    assert list(resolve_aliases("x", {"x": ["x"]})) == ["x"]
    assert resolved_batches(["a"], {"a": ["b", "c"]}) == ["b", "c"]
    config = {"project": {"name": "repo"}, "inputs": {"batches": "sub/batches.yaml"}}
    ci_commit = make_commit(tmp_path, config, batches={"b0": {}})
    nested = "\n".join(f"  a{i}: [{', '.join([f'a{i + 1}'] * 10)}]" for i in range(8))
    sent = [{"path": "bomb.yaml", "content": f"aliases:\n{nested}\n  a8: [b0]\n"}]
    check = check_tuning_request(ci_commit, {"batch_label": "x", "selected_group": "a0", "groups": [], "batches_files": sent})
    assert "more than 10000 batches" in check["errors"][0]


def test_sent_batch_files_with_lone_surrogates_are_invalid():
    from backend.api.tuning import sent_batches_files
    for sent in ({"path": "a.yaml", "content": "a: {}\n\ud800"}, {"path": "\ud800.yaml", "content": "a: {}\n"}):
        files, errors = sent_batches_files([sent])
        assert files == [] and "Invalid batch file" in errors[0]


def test_requests_must_be_json(dummy_app, monkeypatch):
    import flask
    import backend.api.tuning as tuning
    monkeypatch.setattr(tuning, "lookup_commit", lambda project_id, hexsha: (SimpleNamespace(), None))
    for endpoint in (tuning.check_tuning, tuning.start_tuning):
        with dummy_app.test_request_context("/api/v1/commit/abc/batch", method="POST", query_string={"project": "repo"}, data="nope"):
            flask.g.user = {"user_name": "alice"}
            response, status = endpoint("abc")
        assert status == 400 and response.get_json()["error"] == "Send the request as a JSON object."


def test_start_a_batch_from_an_api_client(dummy_app, tmp_path, monkeypatch):
    """What `qa batch --commit` sends: no form defaults, several batches, a batch file of the user's"""
    import flask
    import backend.api.tuning as tuning
    config = {"project": {"name": "repo"}, "inputs": {"batches": "sub/batches.yaml"}}
    commit = make_commit(tmp_path, config, batches={"night": {"inputs": ["a"]}})
    batch = SimpleNamespace(id=3, label="from-cli", batch_dir=tmp_path / "outputs" / "batch", batch_dir_override=None, data={})
    commit.get_or_create_batch = lambda label: batch
    commit.outputs_dir = tmp_path / "outputs"
    monkeypatch.setattr(tuning, "lookup_commit", lambda project_id, hexsha: (commit, None))
    events = []
    def audit(action, *args, meta=None, **kwargs):
        events.append(SimpleNamespace(action=action, args=args, meta=meta, **kwargs))
        return events[-1]
    monkeypatch.setattr(tuning, "audit", audit)
    monkeypatch.setattr(tuning, "db_session", MagicMock())
    monkeypatch.setattr(tuning, "check_storage_path", lambda path: None)
    monkeypatch.setattr(tuning, "user_batch_dir", lambda batch_dir, user: batch_dir)
    monkeypatch.setattr(tuning, "qaboard_data_shared_dir", tmp_path / "shared")
    monkeypatch.setattr(tuning, "record_submission", lambda batch, submission: None)
    started = {}
    def dispatch_local(script, log_dir, command_id, ci_commit, token=None):
        started.update(script=script.read_text(), log_dir=log_dir)
        return {"status": "submitted"}
    monkeypatch.setattr(tuning, "_dispatch_local", dispatch_local)
    monkeypatch.setenv("QABOARD_TUNING_RUNNER", "local")
    request = {
        "batch_label": "from-cli",
        "selected_group": ["night", "mine"],
        "batches_files": [{"path": "local.yaml", "content": "mine: {inputs: [b]}\n"}],
        "notify": False,
    }
    with dummy_app.test_request_context("/api/v1/commit/abcdef/batch", method="POST", query_string={"project": "repo/sub"}, json=request):
        flask.g.user = {"user_name": "alice"}
        response = tuning.start_tuning("abcdef")
    body = response.get_json()
    assert body["submission"]["status"] == "submitted", body
    assert body["submission"]["batch"] == "night mine"
    assert body["notification"] is None
    command = body["submission"]["command"]
    assert "--batch night --batch mine" in command and "--action-on-existing sync --no-wait" in command
    assert '"parameter_search": {}' in command
    # one snapshot of the batches that run, from the commit's file and the sent one: not QA-Board's whole files
    assert [p.relative_to(started["log_dir"]).as_posix() for p in started["log_dir"].glob("**/*.y*ml")] == ["batches.yaml"]
    assert f"--batches-file {started['log_dir'] / 'batches.yaml'}" in command
    import yaml
    assert yaml.safe_load((started["log_dir"] / "batches.yaml").read_text()) == {"night": {"inputs": ["a"]}, "mine": {"inputs": ["b"]}}
    assert body["submission"]["batches_snapshot"] == {"batches": ["night", "mine"], "aliases": [], "files": ["sub/batches.yaml", "local.yaml (sent with qa batch --commit)"], "inputs": [], "path": "batches.yaml"}
    assert body["submission"]["request"]["selected_group"] == ["night", "mine"]
    # It runs code: the audit log says who started what, with which parameters, and how it went
    [event] = events
    assert event.action == "batch.start" and event.args == ("batch", 3, "from-cli") and event.project_id == "repo/sub"
    assert event.meta["command_id"] == body["submission"]["id"] and event.meta["status"] == "submitted"
    assert event.meta["batches"] == ["night", "mine"] and event.meta["runner"] == "local" and event.meta["search_type"] == "grid"
    import hashlib
    assert event.meta["parameters"] == '{"parameter_search":{},"search_type":"grid"}'
    assert event.meta["parameters_sha256"] == hashlib.sha256(event.meta["parameters"].encode()).hexdigest()
    assert "parameters_truncated" not in event.meta
    assert "export QABOARD_TUNING=true" in started["script"]
