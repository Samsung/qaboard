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
    def transcript(commit):
        runs = [r for r in ctx.runs(commit=commit, inputs=inputs) if not r.failed]
        if len(runs) != 1:
            return None, f'expected one run of {inputs} at {commit}, got {len(runs)}'
        return runs[0].file('transcript.txt').read_text(), None

    text, error = transcript(ctx.commit)
    if error:
        return False, error
    found = re.search(pattern, text, re.M)
    message = f'{ctx.commit}: ' + (f'"{found.group(0)}"' if found else f'no match for /{pattern}/')
    if not found or not not_in:
        return bool(found), message
    reference = ctx.parent(ctx.commit) if not_in == 'parent' else not_in
    ref_text, error = transcript(reference)
    if error:
        return False, error
    ref_found = re.search(pattern, ref_text, re.M)
    message += f'; {reference}: ' + (f'"{ref_found.group(0)}"' if ref_found else 'no match')
    return not ref_found, message
