"""
Unit tests for the milestones CRUD logic in backend/api/milestones.py

Minimal dependencies - mocks database operations.
Tests the core business logic without requiring the full app/database.
Uses a dummy flask app instead of a real one.
"""
import pytest

from unittest.mock import MagicMock

# ==========================================
# Milestone Samples
# ==========================================

SAMPLE_MILESTONE = {
    'commit': 'abc123',
    'branch': 'main',
    'batch': 'default',
    'label': 'v1.0',
    'notes': 'Test milestone',
    'date': '2024-01-15T10:00:00Z',
}

MILESTONE_WITH_OWNER = {
    'commit': 'abc123',
    'branch': 'main',
    'batch': 'default',
    'label': 'v1.0',
    'notes': 'Test milestone',
    'date': '2024-01-15T10:00:00Z',
    'owners': [
        {'user_name': 'alice', 'full_name': 'Alice User'}
    ]
}

MILESTONE_NO_OWNER = {
    'commit': 'noowner',
    'branch': 'main',
    'batch': 'default',
    'label': 'no owner',
}

MILESTONE_NO_OWNER_KEY = 'test-project/noowner/default'
SAMPLE_MILESTONE_KEY = 'test-project/abc123/default'

SAMPLE_POST_JSON = {
    'project': 'test-project',
    'key': 'test/key',
    'milestone': SAMPLE_MILESTONE
}

SAMPLE_DELETE_JSON = {
    'project': 'test-project',
    'key': SAMPLE_MILESTONE_KEY
}

# ==========================================
# Fixtures
# ==========================================

@pytest.fixture
def mock_project():
    """Yields the global Project mock and resets it after each test."""
    import backend.models as models
    # Yield Project to test and mock it there as you wish
    yield models.Project
    
    # Teardown - resets project mock (return_value and side_effect only) so they don't pollute the next test
    models.Project.reset_mock(return_value=True, side_effect=True)


@pytest.fixture
def configure_project(mock_project):
    """Factory fixture to wire up the SQLAlchemy query chain with custom data."""
    def _builder(custom_data):
        project_instance = MagicMock()
        project_instance.data = custom_data
        mock_project.query.filter.return_value.one.return_value = project_instance
        return mock_project
        
    # Return the function itself so it'll be used as a fixture
    return _builder

@pytest.fixture
def mock_get_user():
    """Yields the global get_current_user mock and resets it after each test."""
    import backend.api.auth as auth
    # Yield get_current_user to test and mock it there as you wish
    yield auth.get_current_user
    
    # Teardown - resets get_current_user mock (return_value and side_effect only) to clean before next test
    auth.get_current_user.reset_mock(return_value=True, side_effect=True)

# ==========================================
# Tests
# ==========================================

class TestMilestoneCRUD:
    """Tests for milestone CRUD operations logic."""

    def test_get_returns_milestones_dict(self, dummy_app, configure_project):
        """GET returns milestones dict from project data."""
        # Setup project milestones mock
        configure_project({'milestones': {'key1': SAMPLE_MILESTONE}})

        # Import after patching
        from backend.api.milestones import crud_milestones
        
        # Use flask dummy app to achieve real flask app without backend dependencies
        with dummy_app.test_request_context(method='GET', json={'project': 'test-project'}):
            response = crud_milestones()
            assert response.status_code == 200            
            data = response.get_json()
            assert 'key1' in data
            assert data['key1']['label'] == 'v1.0'

    def test_get_returns_empty_dict_when_no_milestones(self, dummy_app, configure_project):
        """GET returns empty dict when project has no milestones."""
        configure_project({})

        from backend.api.milestones import crud_milestones
        
        with dummy_app.test_request_context(method='GET', json={'project': 'test-project'}):
            response = crud_milestones()
            assert response.status_code == 200
            data = response.get_json()
            assert data == {}

    def test_post_requires_authentication(self, dummy_app, configure_project, mock_get_user):
        """POST without auth returns 401."""
        configure_project({'milestones': {}})
        mock_get_user.return_value = {'is_authenticated': False}

        from backend.api.milestones import crud_milestones
        
        with dummy_app.test_request_context(method='POST', json=SAMPLE_POST_JSON):
            response = crud_milestones()
            assert response[1] == 401

    def test_post_creates_milestone(self, dummy_app, configure_project, mock_get_user):
        """Authenticated POST creates a new milestone."""
        configure_project({'milestones': {}})
        mock_get_user.return_value = {
            'is_authenticated': True,
            'user_name': 'bob',
            'full_name': 'Bob User'
        }

        from backend.api.milestones import crud_milestones
        
        with dummy_app.test_request_context(method='POST', json=SAMPLE_POST_JSON):
            response = crud_milestones()
            assert response.status_code == 200
            data = response.get_json()
            assert SAMPLE_POST_JSON['key'] in data
            # Verify owner was added
            assert 'owners' in data[SAMPLE_POST_JSON['key']]
            assert data[SAMPLE_POST_JSON['key']]['owners'][0]['user_name'] == 'bob'

    def test_post_edits_existing_milestone(self, dummy_app, configure_project, mock_get_user):
        """POST adds new owner to existing milestone if not already present."""
        new_label = 'Updated l of m'        
        configure_project({'milestones': {SAMPLE_MILESTONE_KEY: dict(MILESTONE_WITH_OWNER)}})
        mock_get_user.return_value = { 'is_authenticated': True } | MILESTONE_WITH_OWNER['owners'][0]

        from backend.api.milestones import crud_milestones
        
        UPDATE_POST_JSON = {
            'project': 'test-project',
            'key': SAMPLE_MILESTONE_KEY,
            'milestone': {'label': new_label}
        }
        with dummy_app.test_request_context(method='POST', json=UPDATE_POST_JSON):
            response = crud_milestones()
            
            # Assert alice is permitted to edit this milestone
            assert response.status_code == 200
            
            # Assert alice user name shows in owners
            data = response.get_json()
            owners = data[SAMPLE_MILESTONE_KEY]['owners']
            owner_usernames = [o['user_name'] for o in owners]
            assert MILESTONE_WITH_OWNER['owners'][0]['user_name'] in owner_usernames

            # Assert milestone label updated by this POST request
            assert data[SAMPLE_MILESTONE_KEY]['label'] == new_label

    def test_delete_blocked_for_non_owner(self, dummy_app, configure_project, mock_get_user):
        """DELETE returns 403 when user is not an owner."""
        configure_project({'milestones': {SAMPLE_MILESTONE_KEY: dict(MILESTONE_WITH_OWNER)}})
        mock_get_user.return_value = {
            'is_authenticated': True,
            'user_name': 'bob',  # Not the owner
            'full_name': 'Bob User'
        }

        from backend.api.milestones import crud_milestones

        with dummy_app.test_request_context(method='DELETE', json=SAMPLE_DELETE_JSON):
            response = crud_milestones()
            assert response[1] == 403
            data = response[0].get_json()
            assert 'error' in data

    def test_delete_success_by_owner(self, dummy_app, configure_project, mock_get_user):
        """Owner can delete their own milestone."""
        configure_project({'milestones': {SAMPLE_MILESTONE_KEY: dict(MILESTONE_WITH_OWNER)}})
        mock_get_user.return_value = { 'is_authenticated': True } | MILESTONE_WITH_OWNER['owners'][0]

        from backend.api.milestones import crud_milestones

        with dummy_app.test_request_context(method='DELETE', json=SAMPLE_DELETE_JSON):
            response = crud_milestones()
            assert response.status_code == 200
            # Delete returns updated milestones, should be without deleted one
            data = response.get_json()
            assert SAMPLE_MILESTONE_KEY not in data

    def test_delete_allowed_for_milestone_without_owners(self, dummy_app, configure_project, mock_get_user):
        """Cannot delete milestone that has no owners (requires admin action)."""
        configure_project({'milestones': {MILESTONE_NO_OWNER_KEY: dict(MILESTONE_NO_OWNER)}})
        mock_get_user.return_value = {
            'is_authenticated': True,
            'user_name': 'bob',
            'full_name': 'Bob User'
        }

        from backend.api.milestones import crud_milestones
        
        NOOWNER_DELETE_JSON = {
            'project': 'test-project',
            'key': MILESTONE_NO_OWNER_KEY
        }
        with dummy_app.test_request_context(method='DELETE', json=NOOWNER_DELETE_JSON):
            response = crud_milestones()
            assert response.status_code == 200
            # Delete returns updated milestones, should be without deleted one
            data = response.get_json()
            assert MILESTONE_NO_OWNER_KEY not in data

    def test_edit_allowed_for_milestone_without_owners(self, dummy_app, configure_project, mock_get_user):
        """Any authenticated user can edit a milestone that has no owners."""
        configure_project({'milestones': {MILESTONE_NO_OWNER_KEY: dict(MILESTONE_NO_OWNER)}})
        mock_get_user.return_value = {
            'is_authenticated': True,
            'user_name': 'bob',
            'full_name': 'Bob User'
        }

        from backend.api.milestones import crud_milestones
        
        NOOWNER_EDIT_JSON = {
            'project': 'test-project',
            'key': MILESTONE_NO_OWNER_KEY,
            'milestone': {'label': 'Updated no-owner milestone'}
        }
        with dummy_app.test_request_context(method='POST', json=NOOWNER_EDIT_JSON):
            response = crud_milestones()
            assert response.status_code == 200
            data = response.get_json()
            assert data[MILESTONE_NO_OWNER_KEY]['label'] == 'Updated no-owner milestone'
            # Verify the user was added as owner
            owners = data[MILESTONE_NO_OWNER_KEY].get('owners', [])
            owner_usernames = [o['user_name'] for o in owners]
            assert 'bob' in owner_usernames

    def test_delete_by_post_with_delete_flag(self, dummy_app, configure_project, mock_get_user):
        """POST with delete=true in data deletes milestone."""
        configure_project({'milestones': {SAMPLE_MILESTONE_KEY: dict(MILESTONE_WITH_OWNER)}})
        mock_get_user.return_value = { 'is_authenticated': True } | MILESTONE_WITH_OWNER['owners'][0]

        from backend.api.milestones import crud_milestones
        
        DELETE_BY_POST_JSON = {
            'project': 'test-project',
            'key': SAMPLE_MILESTONE_KEY,
            'delete': True
        }
        with dummy_app.test_request_context(method='POST', json=DELETE_BY_POST_JSON):
            response = crud_milestones()
            assert response.status_code == 200
            data = response.get_json()
            assert SAMPLE_MILESTONE_KEY not in data


class TestProjectNotFound:
    """Tests for project not found scenario."""

    def test_get_project_not_found(self, dummy_app, mock_project):
        """GET returns 404 when project doesn't exist."""
        from sqlalchemy.orm.exc import NoResultFound
        mock_project.query.filter.return_value.one.side_effect = NoResultFound()

        from backend.api.milestones import crud_milestones
        
        with dummy_app.test_request_context(method='GET', json={'project': 'non-existent'}):
            response = crud_milestones()
            assert response[1] == 404
