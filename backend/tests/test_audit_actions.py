"""
The audit log's coverage, read from the code (no app, no database):
- every action the code records is listed in backend/audit_actions.py, with a label and a category,
- every endpoint that changes things records an audit event, or says why not in audit_actions.NOT_AUDITED.
"""
import re
import ast
import importlib.util
from pathlib import Path

import pytest


BACKEND = Path(__file__).resolve().parent.parent / 'backend'
spec = importlib.util.spec_from_file_location('audit_actions_under_test', BACKEND / 'audit_actions.py')
audit_actions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_actions)

ACTION_NAME = re.compile(r'^[a-z_]+(\.[a-z_]+)+$')
MUTATING = {'POST', 'PUT', 'PATCH', 'DELETE'}
AUDIT_FUNCTIONS = {'audit', 'system_audit'}


def sources():
  for path in sorted(BACKEND.rglob('*.py')):
    if 'alembic' in path.parts or path.name == 'audit_actions.py':
      continue
    yield path, ast.parse(path.read_text(), filename=str(path))


def call_name(call: ast.Call):
  f = call.func
  if isinstance(f, ast.Attribute):
    return f.attr
  if isinstance(f, ast.Name):
    return f.id
  # (record or audit)(...)
  if isinstance(f, ast.BoolOp) and any(isinstance(v, ast.Name) and v.id in AUDIT_FUNCTIONS for v in f.values):
    return 'audit'
  return None


def constants(node):
  """The strings an expression can be: 'a', 'a' if x else 'b'"""
  if isinstance(node, ast.Constant) and isinstance(node.value, str):
    return [node.value]
  if isinstance(node, ast.IfExp):
    return constants(node.body) + constants(node.orelse)
  return []


def recorded_actions():
  """(literal actions, f-string prefixes, where) the code records"""
  literals, prefixes = {}, {}
  for path, tree in sources():
    for node in ast.walk(tree):
      where = f"{path.relative_to(BACKEND)}:{getattr(node, 'lineno', '?')}"
      if isinstance(node, ast.Call):
        values = []
        if call_name(node) in AUDIT_FUNCTIONS and node.args:
          values.append(node.args[0])
        values += [k.value for k in node.keywords if k.arg == 'audit_action']
        for value in values:
          for constant in constants(value):
            literals[constant] = where
          if isinstance(value, ast.JoinedStr) and value.values and isinstance(value.values[0], ast.Constant):
            prefixes[value.values[0].value] = where
      # action = 'grant.update' if previous else 'grant.create'
      if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ('action', 'audit_action') for t in node.targets):
        for constant in constants(node.value):
          if ACTION_NAME.match(constant):
            literals[constant] = where
  return literals, prefixes


def test_recorded_actions_are_registered():
  literals, prefixes = recorded_actions()
  assert len(literals) > 50, "the scan should find the actions the code records"
  missing = {action: where for action, where in literals.items() if action not in audit_actions.ACTIONS}
  assert not missing, f"Add these actions to backend/audit_actions.py ACTIONS: {missing}"
  for prefix, where in prefixes.items():
    assert any(name.startswith(prefix) for name in audit_actions.ACTIONS), f"{where}: no action starts with {prefix!r}"


def test_actions_are_well_formed():
  for name, action in audit_actions.ACTIONS.items():
    assert ACTION_NAME.match(name), name
    assert action.label and action.label[0].isupper() and not action.label.endswith('.'), name
    assert action.category in audit_actions.CATEGORIES, name


class Module:
  """A backend module's functions, and what its names refer to: its imports"""
  def __init__(self, path: Path):
    self.path = path
    self.tree = ast.parse(path.read_text())
    self.functions = {n.name: n for n in ast.walk(self.tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    # alias: module path, or (module path, function name)
    self.names = {}
    package = path.parent
    for node in ast.walk(self.tree):
      if isinstance(node, ast.ImportFrom):
        if node.level:
          base = package
          for _ in range(node.level - 1):
            base = base.parent
        elif node.module and node.module.startswith('backend.'):
          base, node_module = BACKEND, node.module[len('backend.'):]
          node = ast.ImportFrom(module=node_module, names=node.names, level=0)
        elif node.module == 'backend':
          base, node = BACKEND, ast.ImportFrom(module=None, names=node.names, level=0)
        else:
          continue
        target = base.joinpath(*node.module.split('.')) if node.module else base
        for alias in node.names:
          as_module = module_path(target / alias.name)
          if as_module:
            self.names[alias.asname or alias.name] = as_module
          elif module_path(target):
            self.names[alias.asname or alias.name] = (module_path(target), alias.name)

  def calls(self, function):
    """The (module path, function name) a function calls, as far as we can tell"""
    for node in ast.walk(function):
      if not isinstance(node, ast.Call):
        continue
      f = node.func
      if isinstance(f, ast.Name):
        if f.id in AUDIT_FUNCTIONS:
          yield ('audit', f.id)
        elif f.id in self.functions:
          yield (self.path, f.id)
        elif isinstance(self.names.get(f.id), tuple):
          yield self.names[f.id]
      elif isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and isinstance(self.names.get(f.value.id), Path):
        yield (self.names[f.value.id], f.attr)
      elif call_name(node) == 'audit':
        yield ('audit', 'audit')


def module_path(target: Path):
  if target.with_suffix('.py').is_file():
    return target.with_suffix('.py')
  if (target / '__init__.py').is_file():
    return target / '__init__.py'
  return None


def mutating_routes():
  for path in sorted((BACKEND / 'api').glob('*.py')):
    tree = ast.parse(path.read_text())
    for node in tree.body:
      if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        continue
      methods = set()
      for decorator in node.decorator_list:
        if not (isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute)):
          continue
        # @app.post(...), @app.delete(...)
        if decorator.func.attr in ('post', 'put', 'patch', 'delete'):
          methods.add(decorator.func.attr.upper())
        if decorator.func.attr == 'route':
          for keyword in decorator.keywords:
            if keyword.arg == 'methods':
              # ast.literal_eval fails on computed methods: list them literally, so that the test sees them
              methods |= set(ast.literal_eval(keyword.value))
      if methods & MUTATING:
        yield f"{path.name}:{node.name}", (path, node.name)


def test_routes_that_change_things_are_audited():
  modules = {}
  def module(path):
    if path not in modules:
      modules[path] = Module(path)
    return modules[path]

  def audits(path, name, seen):
    """Whether a function records an event, itself or through the functions it calls (methods aren't followed)"""
    if path == 'audit':
      return True
    if (path, name) in seen or len(seen) > 6:
      return False
    seen = seen | {(path, name)}
    m = module(path)
    if name not in m.functions:
      return False
    return any(audits(p, n, seen) for p, n in set(m.calls(m.functions[name])))

  routes = dict(mutating_routes())
  assert len(routes) > 100, "the scan should find the API's routes"
  unaudited = sorted(key for key, (path, name) in routes.items() if not audits(path, name, frozenset()) and key not in audit_actions.NOT_AUDITED and key not in audit_actions.AUDITED_IN_METHODS)
  assert not unaudited, (
    "These endpoints change things without recording an audit event. Call audit() (backend/audit.py), "
    f"or say why not in backend/audit_actions.py NOT_AUDITED: {unaudited}"
  )


def test_routes_are_declared_with_decorators():
  """add_url_rule() would hide routes from the test above"""
  for path in sorted((BACKEND / 'api').glob('*.py')):
    assert 'add_url_rule(' not in path.read_text(), f"{path.name}: declare routes with @app.route, the audit coverage test reads them"


def test_not_audited_lists_existing_routes():
  routes = dict(mutating_routes())
  stale = sorted((set(audit_actions.NOT_AUDITED) | set(audit_actions.AUDITED_IN_METHODS)) - set(routes))
  assert not stale, f"Remove from backend/audit_actions.py NOT_AUDITED, these endpoints don't exist: {stale}"


@pytest.mark.parametrize("key", sorted(audit_actions.NOT_AUDITED))
def test_not_audited_says_why(key):
  assert len(audit_actions.NOT_AUDITED[key]) > 10
