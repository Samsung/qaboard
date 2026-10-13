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
    commit = SimpleNamespace(artifacts_dir=Path("/mnt/qaboard/kitefin/detector/94/d909ca8934d5f2"))
    # inputs in the project: next to the code the batches started from QA-Board run
    assert commit_database(Path("inputs"), commit) == Path("/mnt/qaboard/kitefin/detector/94/d909ca8934d5f2/inputs")
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
