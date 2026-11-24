# Testing Guide

This document outlines the testing architecture, mocking strategy, and troubleshooting steps for the backend test suite.

**Goal**: Run tests in complete isolation from all other QABoard services.

## 🚀 Run Tests

Outside the container, install the backend's dependencies first. Some are built from source on purpose
(`tool.uv.no-binary-package` in `backend/pyproject.toml`: lxml and xmlsec must link the same libxml2), so they need
the C headers the Dockerfile installs (Debian/Ubuntu names):
```bash
sudo apt-get update && sudo apt-get install -y --no-install-recommends build-essential pkg-config \
  libpq-dev libsasl2-dev libldap-dev libxml2-dev libxmlsec1-dev libxslt1-dev zlib1g-dev
cd backend && uv sync
uv run python -m pytest -q -p no:cacheprovider tests
```
Without them, `uv sync` fails building psycopg2 (`pg_config.h: No such file`), python-ldap (`lber.h`) or lxml
(`Please make sure the libxml2 and libxslt development packages are installed`).

Run all tests:
```bash
# From root folder:
pytest backend

# Run a specific file
pytest backend/tests/test_milestones.py

# The tests of SQL queries need a PostgreSQL (they use temporary tables, in transactions they roll back), else they're skipped.
# CI runs them in the backend's container:
docker compose exec -e QABOARD_TEST_DATABASE_URL=postgresql://qaboard:password@db:5432/qaboard backend python -m pytest -q -p no:cacheprovider tests
```

## 🧠 Mock Strategy

Two-tier mocking architecture to ensure tests run fast and without side-effects.

### 1. Global Infrastructure (`conftest.py`)
`conftest.py` acts as a **global import shield**. It prevents Python from initializing real SQLAlchemy connections or Flask routing when test files are collected.
*   **`sys.modules` Hijacking:** We intercept imports for `backend.models`, `backend.api`, and `sqlalchemy` and replace them with `types.ModuleType` and `MagicMock`.
*   **Decorator Pass-Through:** Flask route decorators (`@app.route`) are replaced with `lambda *args, **kwargs: lambda f: f` so the underlying handler functions remain exposed and testable.
*   **Session-Scoped Dummy App:** A barebones `Flask(__name__)` instance (`dummy_app`) is provided to power request contexts safely.

Derived Instructions:
- Use `dummy_app` fixture to use flask client
- Call handlers directly and not via API call

### 2. Local State Control (Pytest Fixtures)
We strictly avoid global `@patch` decorators. Instead, we use local **Fixtures** to manage test data.
*   **The Singleton Mock:** Fixtures retrieve the global mock via in-fixture import and then yield them to each test. Example from `test_milestones.py`: Inside `mock_project` fixture, we start with `import backend.models as models` and then `yield models.Project` yields the `Project` mock to each test using this fixture.
*   **Don't `monkeypatch` the shared mocks' attributes** (`monkeypatch.setattr(api.Project, 'query', ...)`): since pytest 9.2, undoing it deletes the attribute from the shared `MagicMock` (pytest#10644), and later tests get `AttributeError`. Replace the module's name with a fresh mock instead: `monkeypatch.setattr(api, 'Project', MagicMock())`. Setting return values on the shared mocks (`mock_project.query.filter.return_value = ...`) is fine.


## ➕ Add a New Test

When adding a new route test, follow those rules:

1.  **Do not use `test_client()`:** To bypass global middleware and test the function in pure isolation, call the route handler directly inside a `test_request_context()`.
2.  **Import after setup:** Always import your route module *inside* the test function, after your mocks are configured.
3. **Follow working tests:** Mock strategy can sometimes confuse and might seen as magic. In order to implement it correctly, you should follow working tests templates in your new test.

**Template:**
```python
def test_example_route(dummy_app, mock_project):
    # 1. Configure the mock for this specific test
    mock_project.query.filter.return_value.one.return_value.data = {'key': 'value'}
    
    # 2. Import the route handler
    from backend.api.example import route_handler
    
    # 3. Execute inside the request context
    with dummy_app.test_request_context('/api/example?q=1', method='GET'):
        response = route_handler()
        
        # 4. Verify using native Flask Response properties
        assert response.status_code == 200
        assert response.get_json()['key'] == 'value'
```

## 🛠️ Troubleshoot (Common Errors)

Here is a ledger of import quirks and context errors we have solved, and how to fix them if they reappear:

| Error Message | Cause | Solution |
| :--- | :--- | :--- |
| `ModuleNotFoundError: No module named 'backend.tests'` | `conftest.py` set the `backend` package `__path__` to empty `[]`. | Ensure `backend_mod.__path__` points to the absolute path of the inner backend directory. |
| `AttributeError: module 'backend.api' has no attribute 'X'` | Python failed to resolve relative imports or the submodule wasn't explicitly loaded before a `@patch`. | Define `__package__` in the global `conftest.py` mocks. Import the target module explicitly inside your test/helper function. |
| `RuntimeError: Working outside of request context.` | The route function called `request` or `jsonify()` but the Flask engine was shut off. | Wrap the function execution in `with dummy_app.test_request_context():` |
| `AssertionError: assert <MagicMock name="mock.route..."> == 200` | The `@app.route` decorator swallowed the route function during import. | Ensure `backend_mod.app.route` is set to the pass-through lambda in `conftest.py`. |
| `TypeError: 'Response' object is not subscriptable` | Attempting to access response data via tuples (e.g., `response[1]`). | Use the native Flask response attributes: `response.status_code` and `response.get_json()`. |
| `ModuleNotFoundError: No module named 'sqlalchemy.orm.exc'` | The app tried to catch a specific exception that wasn't globally mocked. | Create a dummy `class MockNoResultFound(Exception)` in `conftest.py` and assign it to `sys.modules['sqlalchemy.orm.exc'].NoResultFound`. |
| `ImportError: cannot import name 'Output' from 'backend.models'` | The app tried to import a model that hasn't been added to the global `sys.modules` fake. | Add `models_mod.Output = MagicMock()` to the `backend.models` section in `conftest.py`. |
| `AttributeError: <MagicMock ...> has no attribute 'query'` (or `AttributeError: query`) in tests that pass alone | An earlier test monkeypatched an attribute of a shared mock: undoing it deleted the attribute. | In that earlier test, `monkeypatch.setattr(module, 'Model', MagicMock(...))`, not `monkeypatch.setattr(module.Model, 'attribute', ...)`. |
| *Tests fail randomly during `ThreadPoolExecutor` concurrency* | Using `with patch(...)` inside thread workers causes race conditions on the global mock dictionary. | Apply `patch.object()` **outside** the thread pool executor block to keep the mock state stable for all workers. |