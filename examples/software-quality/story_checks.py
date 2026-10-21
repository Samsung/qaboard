"""
Checks of story.yaml that need more than a metric: hook(ctx, **args) -> (ok, message). See ../STORY.md#checks.
They run in the seeder's Python (standard library, PyYAML), not the example's.
"""
import fnmatch
import json


def _statuses(ctx, commit, inputs, configs):
    runs = [r for r in ctx.runs(commit=commit, inputs=inputs) if not r.failed]
    if configs:
        runs = [r for r in runs if fnmatch.fnmatch(json.dumps(r.configurations), configs)]
    if len(runs) != 1:
        return None, f'expected one run of {inputs} {configs or ""} at {commit}, got {len(runs)}'
    lines = runs[0].file('tests.txt').read_text().splitlines()
    return dict(reversed(line.split(None, 1)) for line in lines if line.strip()), ''


def status_changes(ctx, inputs, before, after, min, configs=None):
    """
    At least `min` tests of `inputs` have the status `after` (FAIL) in tests.txt at the check's commit and `before`
    (PASS) at its parent: the lines the text viewer's diff shows.
    """
    new, error = _statuses(ctx, ctx.commit, inputs, configs)
    if new is None:
        return False, error
    ref, error = _statuses(ctx, ctx.parent(ctx.commit), inputs, configs)
    if ref is None:
        return False, error
    changed = [test for test, status in new.items() if status == after and ref.get(test) == before]
    return len(changed) >= min, f'{len(changed)} tests went from {before} to {after} (e.g. {changed[:2]})'
