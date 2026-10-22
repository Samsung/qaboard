"""
Unit tests for the error handler in backend/api/commit.py (api_ci_commit)

Minimal dependencies - mocks database operations.
Tests the error handling without requiring the full app/database.
Uses a dummy flask app instead of a real one.

Regression test for the KeyError bug: when get_or_create fails and the request
body has no 'git_commit_sha', the except block used to crash with
KeyError: 'git_commit_sha', turning a clean 404 into a 500.
"""
import json
from unittest.mock import MagicMock

import pytest

# ==========================================
# Samples
# ==========================================

PROJECT = 'CDE-Users/HW_ALG/CIS/tests/products/HPC'
BAD_REF = 'CIS/HPC/feature/smap_test_0706/batch'
HEXSHA = '0123456789abcdef0123456789abcdef01234567'

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
            assert BAD_REF in response[0].get_json()['error']

    def test_project_only_in_query_string_returns_400(self, dummy_app, mock_ci_commit):
        """POST with 'project' only in the query string (not body): which project? 400"""
        mock_ci_commit.get_or_create.side_effect = Exception("boom")

        from backend.api.commit import api_ci_commit

        # body is empty: no 'project', no 'git_commit_sha'
        with dummy_app.test_request_context(f'/api/v1/commit/{BAD_REF}?project={PROJECT}', method='POST', json={}):
            response = api_ci_commit(commit_id=BAD_REF)
            assert response[1] == 400 and response[0].get_json()['reason'] == 'invalid_project'

    def test_commit_sha_without_legacy_key(self, dummy_app, mock_ci_commit):
        """POST with 'commit_sha' but no 'git_commit_sha' (only sent for backward-compatibility)."""
        mock_ci_commit.get_or_create.return_value.data = {}

        from backend.api.commit import api_ci_commit

        body = {'project': PROJECT, 'commit_sha': HEXSHA}
        with dummy_app.test_request_context('/api/v1/commit/', method='POST', json=body):
            response = api_ci_commit()
            assert response.get_json() == {"status": "OK"}
        assert mock_ci_commit.get_or_create.call_args.kwargs['hexsha'] == HEXSHA

class TestCommitWithoutOutputs:
    """GET ?with_outputs=false: the web app's references that are not shown only need the commit and its batches."""

    def get(self, dummy_app, mock_ci_commit, query, monkeypatch):
        import backend.api.commit as commit_api
        import backend.api.auth as auth
        auth.is_authorized_user.return_value = True
        ci_commit = MagicMock()
        ci_commit.to_dict.return_value = {'id': HEXSHA, 'batches': {}}
        session = MagicMock()
        session.query.return_value.options.return_value.filter.return_value.order_by.return_value.first.return_value = ci_commit
        monkeypatch.setattr(commit_api, 'db_session', session)
        artifacts = MagicMock(return_value={'ok': True})
        monkeypatch.setattr(commit_api, 'commit_artifacts_info', artifacts)
        with dummy_app.test_request_context(f'/api/v1/commit/{HEXSHA}?project={PROJECT}{query}', method='GET'):
            response = commit_api.api_ci_commit(commit_id=HEXSHA)
        return ci_commit, artifacts, json.loads(response.get_data())

    def test_without_outputs(self, dummy_app, mock_ci_commit, monkeypatch):
        ci_commit, artifacts, data = self.get(dummy_app, mock_ci_commit, '&with_outputs=false', monkeypatch)
        assert ci_commit.to_dict.call_args.kwargs['with_outputs'] is False
        # checking the artifacts reads the storage: not for this
        artifacts.assert_not_called()
        assert 'artifacts' not in data

    def test_with_outputs_by_default(self, dummy_app, mock_ci_commit, monkeypatch):
        ci_commit, artifacts, data = self.get(dummy_app, mock_ci_commit, '', monkeypatch)
        assert ci_commit.to_dict.call_args.kwargs['with_outputs'] is True
        artifacts.assert_called_once()
        assert data['artifacts'] == {'ok': True}


class TestCommitLookup:
    """GET /api/v1/commit/<ref>: a commit, a branch or a tag (e.g. `qa check-bit-accuracy --reference v1.0`)"""

    @pytest.fixture
    def api(self, monkeypatch):
        import backend.api.commit as commit_api
        import backend.api.auth as auth
        auth.is_authorized_user.return_value = True
        session = MagicMock()
        monkeypatch.setattr(commit_api, 'db_session', session)
        monkeypatch.setattr(commit_api, 'commit_artifacts_info', MagicMock(return_value={'ok': True}))
        # the models are shared mocks
        monkeypatch.setattr(commit_api, 'Project', MagicMock())
        return commit_api

    def results(self, api, *found):
        """What the successive lookups in the database find"""
        api.db_session.query.return_value.options.return_value.filter.return_value.order_by.return_value.first.side_effect = list(found)

    def get(self, dummy_app, api, ref, query=''):
        with dummy_app.test_request_context(f'/api/v1/commit/{ref}?project={PROJECT}{query}', method='GET'):
            response = api.api_ci_commit(commit_id=ref)
        return response if isinstance(response, tuple) else (response, response.status_code)

    def test_tags_are_resolved_but_not_created(self, dummy_app, api, monkeypatch):
        ci_commit = MagicMock()
        ci_commit.to_dict.return_value = {'id': HEXSHA}
        # not a commit or a branch we know, git knows the tag
        self.results(api, None, None, ci_commit)
        repo = MagicMock()
        repo.commit.return_value.hexsha = HEXSHA
        api.Project.query.filter.return_value.one_or_none.return_value = MagicMock(repo=repo)
        response, status = self.get(dummy_app, api, 'v1.0')
        assert status == 200 and json.loads(response.get_data())['id'] == HEXSHA
        repo.commit.assert_called_once_with('v1.0')
        # a GET doesn't create commits
        api.db_session.add.assert_not_called()
        api.db_session.commit.assert_not_called()

    def test_unknown_refs(self, dummy_app, api):
        self.results(api, None, None)
        repo = MagicMock()
        repo.commit.side_effect = ValueError('BadName')
        repo.refs.__getitem__.side_effect = IndexError('no such ref')
        repo.tags.__getitem__.side_effect = IndexError('no such tag')
        api.Project.query.filter.return_value.one_or_none.return_value = MagicMock(repo=repo)
        response, status = self.get(dummy_app, api, 'nope')
        assert status == 404 and 'nope' in response.get_json()['error']
        api.db_session.add.assert_not_called()

    def test_unknown_commits_fail_fast(self, dummy_app, api):
        self.results(api, None, None)
        response, status = self.get(dummy_app, api, HEXSHA)
        assert status == 404
        api.Project.query.filter.assert_not_called()

    def test_invalid_metrics(self, dummy_app, api):
        self.results(api, MagicMock())
        response, status = self.get(dummy_app, api, HEXSHA, '&metrics={psnr')
        assert status == 400 and 'metrics' in response.get_json()['error']
