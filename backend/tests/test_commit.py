"""
Unit tests for the error handler in backend/api/commit.py (api_ci_commit)

Minimal dependencies - mocks database operations.
Tests the error handling without requiring the full app/database.
Uses a dummy flask app instead of a real one.

Regression test for the KeyError bug: when get_or_create fails and the request
body has no 'git_commit_sha', the except block used to crash with
KeyError: 'git_commit_sha', turning a clean 404 into a 500.
"""
import pytest

# ==========================================
# Samples
# ==========================================

PROJECT = 'CDE-Users/HW_ALG/CIS/tests/products/HPC'
BAD_REF = 'CIS/HPC/feature/smap_test_0706/batch'

# ==========================================
# Fixtures
# ==========================================

@pytest.fixture
def mock_ci_commit():
    """Yields the global CiCommit mock and resets it after each test."""
    import backend.models as models
    # Yield CiCommit to test and mock it there as you wish
    yield models.CiCommit

    # Teardown - resets CiCommit mock (return_value and side_effect only) so they don't pollute the next test
    models.CiCommit.reset_mock(return_value=True, side_effect=True)

# ==========================================
# Tests
# ==========================================

class TestCommitErrorHandler:
    """Tests for the api_ci_commit error handler."""

    def test_missing_git_commit_sha_returns_404(self, dummy_app, mock_ci_commit):
        """POST with a body missing 'git_commit_sha' returns 404 instead of crashing."""
        # get_or_create blows up (e.g. unresolvable ref), like the Sentry case
        mock_ci_commit.get_or_create.side_effect = Exception("BadName")

        from backend.api.commit import api_ci_commit

        # body has 'project' but NO 'git_commit_sha' (this is what triggered the bug)
        body = {'project': PROJECT}
        with dummy_app.test_request_context(f'/api/v1/commit/{BAD_REF}?project={PROJECT}', method='POST', json=body):
            # commit_id comes from the URL path
            response = api_ci_commit(commit_id=BAD_REF)
            assert response[1] == 404
            # the failing ref should appear in the message (we now use hexsha)
            assert BAD_REF in response[0]

    def test_project_only_in_query_string_returns_404(self, dummy_app, mock_ci_commit):
        """POST with 'project' only in the query string (not body) returns 404."""
        mock_ci_commit.get_or_create.side_effect = Exception("boom")

        from backend.api.commit import api_ci_commit

        # body is empty: no 'project', no 'git_commit_sha'
        with dummy_app.test_request_context(f'/api/v1/commit/{BAD_REF}?project={PROJECT}', method='POST', json={}):
            response = api_ci_commit(commit_id=BAD_REF)
            assert response[1] == 404