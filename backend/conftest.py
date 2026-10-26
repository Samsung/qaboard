import os
import pytest
from flask import Flask

# This conftest mocks globally all packages that are used but not tested in backend unit tests.
# For more explanation about the unit tests suite, see tests/TESTING.md.

def pytest_configure():
    # Escape mocking by setting this env var
    if os.getenv("BACKEND_TEST_MODE") == "no-mock":
        return
    
    # Imports for the mocks
    import sys
    import types
    from unittest.mock import MagicMock

    # ==========================================
    # Modules Mock
    # ==========================================

    # Using MagicMock: allows us to treat mocked objects as context managers, iterables, or dictionaries out-of-the-box

    base_dir = os.path.dirname(os.path.abspath(__file__))
    inner_backend_dir = os.path.join(base_dir, 'backend')

    # Mock the top-level 'backend' package
    backend_mod = types.ModuleType('backend')
    backend_mod.__path__ = [inner_backend_dir]
    backend_mod.__package__ = 'backend'  # Critical for relative imports
    backend_mod.app = MagicMock()
    backend_mod.db_session = MagicMock()
    # Keep backend app routes to test them (@app.route)
    backend_mod.app.route = lambda *args, **kwargs: lambda f: f
    sys.modules['backend'] = backend_mod

    # Mock 'backend.api' namespace
    api_mod = types.ModuleType('backend.api')
    api_mod.__path__ = [os.path.join(inner_backend_dir, 'api')]
    api_mod.__package__ = 'backend.api'
    sys.modules['backend.api'] = api_mod
    backend_mod.api = api_mod

    # Mock 'backend.api.auth' to break circular dependencies
    auth_mod = types.ModuleType('backend.api.auth')
    auth_mod.__package__ = 'backend.api'
    auth_mod.get_current_user = MagicMock()
    auth_mod.is_authorized_user = MagicMock()
    auth_mod.restrictions = MagicMock(return_value={})
    auth_mod.restricted_project_key = MagicMock()
    auth_mod.is_login_restricted = False
    auth_mod.matches_rules = MagicMock()
    # Pass-through: the decorator itself is tested in tests/test_security.py
    auth_mod.login_required = lambda f: f
    auth_mod.session_required = lambda f: f
    auth_mod.authenticated = lambda f: f
    auth_mod.admin_required = lambda f: f
    # Unverified results, accepted (tests/test_security.py tests the real one)
    auth_mod.ingest_access = MagicMock(return_value=(None, None))
    # Like the real one, follows is_authorized_user (tests/test_security.py tests the real one)
    def jsonify_forbidden():
        from flask import jsonify
        return jsonify({"error": "Forbidden: You don't have permission to access this project", "reason": "forbidden_project"}), 403
    def require_project_access(user_info, project_id, permission='runs.act'):
        if auth_mod.is_authorized_user(user_info, project_id):
            return None
        from flask import jsonify
        return jsonify({"error": "Forbidden: You don't have permission to access this project"}), 403
    auth_mod.require_project_access = require_project_access
    auth_mod.forbidden_project = lambda project_id=None, permission='project.read': (jsonify_forbidden())
    sys.modules['backend.api.auth'] = auth_mod
    api_mod.auth = auth_mod

    # Mock 'backend.models' and 'backend.backend'
    models_mod = types.ModuleType('backend.models')
    models_mod.__package__ = 'backend'
    models_mod.Project = MagicMock()
    models_mod.Output = MagicMock()
    models_mod.CiCommit = MagicMock()
    models_mod.latest_successful_commit = MagicMock()
    models_mod.Batch = MagicMock()
    models_mod.ProjectView = MagicMock()
    models_mod.Milestone = MagicMock()
    models_mod.MilestoneFavorite = MagicMock()
    models_mod.MilestoneGroupFavorite = MagicMock()
    models_mod.TestInput = MagicMock()
    models_mod.User = MagicMock()
    models_mod.Token = MagicMock()
    models_mod.DeviceAuthorization = MagicMock()
    models_mod.AuditEvent = MagicMock()
    models_mod.Setting = MagicMock()
    for name in ('AuthProvider', 'UserIdentity', 'UserSession', 'AccessRequest', 'Group', 'GroupMember', 'GroupRule', 'RoleGrant', 'ProjectVisibility'):
        setattr(models_mod, name, MagicMock())
    models_mod.batches_stats = MagicMock()
    models_mod.BatchNotification = MagicMock()
    sys.modules['backend.models'] = models_mod
    sys.modules['backend.backend'] = types.ModuleType('backend.backend')

    # Mock SQLAlchemy
    sa_mod = sys.modules.setdefault('sqlalchemy', types.ModuleType('sqlalchemy'))
    sa_orm = sys.modules.setdefault('sqlalchemy.orm', types.ModuleType('sqlalchemy.orm'))
    sa_orm.selectinload = MagicMock()
    if not hasattr(sa_mod, 'or_'):
        sa_mod.or_ = MagicMock()

    sa_attrs = types.ModuleType('sqlalchemy.orm.attributes')
    sa_attrs.flag_modified = MagicMock()
    sys.modules['sqlalchemy.orm.attributes'] = sa_attrs

    import json as _json
    ujson_mod = types.ModuleType('ujson')
    ujson_mod.dumps = _json.dumps
    ujson_mod.loads = _json.loads
    sys.modules['ujson'] = ujson_mod


    class MockNoResultFound(Exception):
        pass

    sa_exc = types.ModuleType('sqlalchemy.orm.exc')
    sa_exc.NoResultFound = MockNoResultFound
    sys.modules['sqlalchemy.orm.exc'] = sa_exc

    # used by backend/notifications/batches.py
    if not hasattr(sa_mod, 'text'):
        sa_mod.text = lambda sql: sql

    class MockIntegrityError(Exception):
        pass

    sa_sql_exc = sys.modules.setdefault('sqlalchemy.exc', types.ModuleType('sqlalchemy.exc'))
    if not hasattr(sa_sql_exc, 'IntegrityError'):
        sa_sql_exc.IntegrityError = MockIntegrityError

# ==========================================
# Fixtures
# ==========================================

@pytest.fixture(scope='session')
def dummy_app():
    """
    Provides a barebones Flask app globally for request contexts.
    Assumes only usage with it is: `dummy_app.test_request_context()` and therefore shared per session.
    """
    return Flask(__name__)


@pytest.fixture
def storage_in_tmp(monkeypatch):
    """
    The API endpoints that read files only read those in the storage ($QABOARD_STORAGE_ROOTS):
    for tests whose files are in the temporary folder, it's the storage. Use /s{path} as their URLs.
    """
    import tempfile
    from pathlib import Path
    import backend.files as files
    monkeypatch.setattr(files, "storage_roots", [Path(tempfile.gettempdir())])
    monkeypatch.setattr(files, "private_dirs", lambda: [])
