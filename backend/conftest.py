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
    # Pass-through: the decorator itself is tested in tests/test_security.py
    auth_mod.login_required = lambda f: f
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
    sys.modules['backend.models'] = models_mod
    sys.modules['backend.backend'] = types.ModuleType('backend.backend')

    # Mock SQLAlchemy
    sa_mod = sys.modules.setdefault('sqlalchemy', types.ModuleType('sqlalchemy'))
    sa_orm = sys.modules.setdefault('sqlalchemy.orm', types.ModuleType('sqlalchemy.orm'))
    sa_orm.selectinload = MagicMock()

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
