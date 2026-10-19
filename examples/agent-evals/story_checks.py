"""
Checks of story.yaml that need more than a metric: hook(ctx, **args) -> (ok, message). See ../STORY.md#checks.
They run in the seeder's Python (standard library, PyYAML), not the example's.
"""
import re


def transcript_has(ctx, inputs, pattern, not_in=None):
    """
    The transcript of the task `inputs` (transcript.txt) matches the regex `pattern` at the check's commit, and, with
    `not_in: parent` (or a commit id), doesn't at that commit: what the transcript diff shows.
    """
    def search(commit):
        runs = [r for r in ctx.runs(commit=commit, inputs=inputs) if not r.failed]
        if len(runs) != 1:
            return None, f'expected one run of {inputs} at {commit}, got {len(runs)}'
        text = runs[0].file('transcript.txt').read_text()
        found = re.search(pattern, text, re.M)
        if not found:
            return False, f'{commit}: no match'
        line = text.count('\n', 0, found.start()) + 1
        return True, f'{commit}: matches at line {line} ({found.group(0).splitlines()[0][:80]!r}...)'

    found, message = search(ctx.commit)
    if not found or not not_in:
        return bool(found), f'/{pattern}/ in {inputs}: {message}'
    reference = ctx.parent(ctx.commit) if not_in == 'parent' else not_in
    ref_found, ref_message = search(reference)
    return ref_found is False, f'/{pattern}/ in {inputs}: {message}; {ref_message}'
