"""The migrations form one chain: `alembic upgrade head` (migrate.sh) refuses to run with several heads, which a merge
of two branches that each added a migration makes easily. Read from the files, without a database."""
import ast
from pathlib import Path

VERSIONS = Path(__file__).resolve().parents[1] / 'backend' / 'alembic' / 'versions'


def revisions():
  found = {}
  for path in VERSIONS.glob('*.py'):
    values = {}
    for node in ast.parse(path.read_text()).body:
      if isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        for target in targets:
          if isinstance(target, ast.Name) and target.id in ('revision', 'down_revision') and node.value is not None:
            values[target.id] = ast.literal_eval(node.value)
    if 'revision' in values:
      found[values['revision']] = (path.name, values.get('down_revision'))
  return found


def test_the_migrations_have_a_single_head():
  found = revisions()
  assert found
  parents = set()
  for _, down in found.values():
    if isinstance(down, (tuple, list)):
      parents.update(down)
    elif down:
      parents.add(down)
  heads = sorted(f"{revision} ({name})" for revision, (name, _) in found.items() if revision not in parents)
  assert len(heads) == 1, f"several migration heads, set down_revision of the newest to the other: {heads}"


def test_the_migrations_revise_known_revisions():
  found = revisions()
  for revision, (name, down) in found.items():
    for parent in (down if isinstance(down, (tuple, list)) else [down]):
      assert parent is None or parent in found, f"{name} revises {parent}, which no migration defines"
