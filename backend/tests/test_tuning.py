"""
Unit tests for starting batches from QA-Board (backend/api/tuning.py)
"""
from types import SimpleNamespace


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
    errors = " ".join(optimize("evaluations: 0\nsearch_space: []"))
    assert "objective" in errors and "positive integer" in errors and "empty" in errors
    assert optimize("objective: {psnr: 1}\nevaluations: 10\nsearch_space:\n- Real: {name: x, low: 0, high: 1}") == []


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
    assert check["definitions"] == [{"name": "smoke", "files": ["sub/batches.yaml"]}]
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
        {"name": "night-1", "files": ["sub/batches.yaml"]},
        {"name": "night-2", "files": ["sub/batches.yaml", "alice.yml"]},
    ]
    # `qa batch` reads them in the same order as on the commit, QA-Board's last
    assert [f["path"] for f in check["batches_files"]] == ["sub/batches.yaml", "alice.yml"]


def test_copy_batches_files(tmp_path):
    # `qa batch` reads exact copies, with their comments and file-level defaults, so runs match local ones
    from backend.api.tuning import copy_batches_files
    content = "# nightly runs\nconfigurations: [base]\nnight: {inputs: [a]}\n"
    (tmp_path / "batches.yaml").write_text(content)
    (tmp_path / "alice.yml").write_text("night: {inputs: [b]}\n")
    files = [
        {"source": "commit", "path": "qa/batches.yaml", "location": tmp_path / "batches.yaml"},
        # paths from qaboard.yaml can be absolute or go up: the copies stay in the submission's folder
        {"source": "commit", "path": "/shared/../batches.yaml", "location": tmp_path / "batches.yaml"},
        {"source": "commit", "path": "batches.yaml", "location": tmp_path / "batches.yaml"},
        {"source": "qaboard", "path": "alice.yml", "location": tmp_path / "alice.yml"},
    ]
    log_dir = tmp_path / "log"
    copies = copy_batches_files(files, log_dir)
    assert [c.relative_to(log_dir).as_posix() for c in copies] == [
        "batches/commit/qa/batches.yaml",
        "batches/commit/shared/batches.yaml",
        "batches/commit/batches.yaml",
        "batches/qaboard/alice.yml",
    ]
    assert copies[0].read_text() == content
    assert copies[3].read_text() == "night: {inputs: [b]}\n"
    # two paths that end up the same don't overwrite each other
    copies = copy_batches_files([files[2], {**files[3], "source": "commit", "path": "batches.yaml"}], tmp_path / "log2")
    assert [c.name for c in copies] == ["batches.yaml", "1-batches.yaml"]
    assert copies[1].read_text() == "night: {inputs: [b]}\n"


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
    commit = SimpleNamespace(hexsha="94d909ca8934d5f214bd2280ff9ec7a4093f6ea2", outputs_dir=Path("/mnt/qaboard/outputs/qaboard/x"))
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


def list_tests(app, name, commit="94d909ca"):
    from backend.api.tuning import get_group
    query = {"project": "group/repo", "name": name, **({"commit": commit} if commit else {})}
    with app.test_request_context("/api/v1/tests/group", method="POST", query_string=query, json={"groups": ["extra-batches", "alice"]}):
        return get_group().get_json()


def test_lists_a_batch_and_where_it_is_defined(dummy_app, batches_setup):
    data = list_tests(dummy_app, "ci")
    assert data["tests"] == [{"input_path": "a", "configurations": []}]
    assert data["definitions"] == [{"name": "ci", "files": ["qa/tests/tests.yaml"]}]
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
    assert data["definitions"] == [{"name": "both", "files": ["qa/tests/tests.yaml", "qa/tests/modes.yaml"]}]
    assert [t["input_path"] for t in data["tests"]] == ["a", "b"]


def test_says_when_a_batch_is_not_defined(dummy_app, batches_setup):
    data = list_tests(dummy_app, "nightly")
    assert data["tests"] == []
    assert data["definitions"] == []
    assert any("`nightly` is not defined in the batch files QA-Board could read: `qa/tests/tests.yaml`, `qa/tests/modes.yaml`" in w for w in data["warnings"])


def test_says_which_inputs_are_missing(dummy_app, batches_setup):
    data = list_tests(dummy_app, "broken")
    assert data["tests"] == []
    assert data["definitions"] == [{"name": "broken", "files": ["qa/tests/tests.yaml"]}]
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
    assert data["definitions"] == [{"name": "ci", "files": ["qa/tests/tests.yaml"]}]


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
    return batches_setup


def list_tests_response(app, name):
    from backend.api.tuning import get_group
    query = {"project": "group/repo", "name": name, "commit": "94d909ca"}
    with app.test_request_context("/api/v1/tests/group", method="POST", query_string=query, json={"groups": []}):
        response, status = get_group()
        return response.get_json(), status


def test_listing_with_the_projects_code_in_a_missing_folder(dummy_app, custom_iter_inputs):
    custom_iter_inputs.commit.artifacts_dir = custom_iter_inputs.tmp_path / "deleted"
    data, status = list_tests_response(dummy_app, "ci")
    assert status == 500
    assert data["error"].startswith("Could not list the tests with the project's code:")


def test_listing_with_the_projects_code_times_out(dummy_app, custom_iter_inputs, monkeypatch):
    import subprocess
    import backend.api.tuning as tuning
    def too_slow(cmd, cwd, timeout):
        assert timeout == tuning.LIST_TESTS_TIMEOUT
        raise subprocess.TimeoutExpired(cmd, timeout)
    monkeypatch.setattr(tuning, "run_with_timeout", too_slow)
    data, status = list_tests_response(dummy_app, "ci")
    assert status == 504
    assert "took more than" in data["error"]


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


def test_celery_script_has_no_default_broker_credentials(tmp_path, monkeypatch):
    import backend.api.tuning as tuning
    monkeypatch.setattr(tuning, "_run_script", lambda path, log_dir: None)
    script = tmp_path / "qa_batch.sh"
    script.write_text("#!/bin/bash\nqa batch\n")
    monkeypatch.delenv("CELERY_BROKER_URL", raising=False)
    tuning._dispatch_celery(script, tmp_path)
    assert "CELERY_BROKER_URL" not in script.read_text()
    script.write_text("#!/bin/bash\nqa batch\n")
    monkeypatch.setenv("CELERY_BROKER_URL", "pyamqp://qaboard:secret@rabbitmq//")
    tuning._dispatch_celery(script, tmp_path)
    assert "export CELERY_BROKER_URL=pyamqp://qaboard:secret@rabbitmq//\n" in script.read_text()
