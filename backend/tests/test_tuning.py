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
    return SimpleNamespace(commit=commit, config=config, artifacts=artifacts, database=database, tmp_path=tmp_path)


def list_tests(app, name, commit="94d909ca"):
    from backend.api.tuning import get_group
    query = {"project": "group/repo", "name": name, **({"commit": commit} if commit else {})}
    with app.test_request_context("/api/v1/tests/group", method="POST", query_string=query, json={"groups": ["extra-batches", "alice"]}):
        return get_group().get_json()


def test_lists_a_batch_and_where_it_is_defined(dummy_app, batches_setup):
    data = list_tests(dummy_app, "ci")
    assert data["tests"] == [{"input_path": "a", "configurations": []}]
    assert data["definitions"] == [{"name": "ci", "file": "qa/tests/tests.yaml"}]
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
    assert data["definitions"] == [{"name": "both", "file": "qa/tests/modes.yaml"}]
    assert [t["input_path"] for t in data["tests"]] == ["a", "b"]


def test_says_when_a_batch_is_not_defined(dummy_app, batches_setup):
    data = list_tests(dummy_app, "nightly")
    assert data["tests"] == []
    assert data["definitions"] == []
    assert any("`nightly` is not defined in the batch files QA-Board could read: `qa/tests/tests.yaml`, `qa/tests/modes.yaml`" in w for w in data["warnings"])


def test_says_which_inputs_are_missing(dummy_app, batches_setup):
    data = list_tests(dummy_app, "broken")
    assert data["tests"] == []
    assert data["definitions"] == [{"name": "broken", "file": "qa/tests/tests.yaml"}]
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
    assert data["definitions"] == [{"name": "ci", "file": "qa/tests/tests.yaml"}]
