"""
Checks of story.yaml that need more than a metric: hook(ctx, **args) -> (ok, message). See ../STORY.md#checks.
"""
import fnmatch


def bit_accuracy(ctx, vs='parent', expect='same', only=None, batch='bitexact', platform='hw-model'):
    """
    Runs `qa check-bit-accuracy` on the check's commit against `vs` (`parent` or a commit id), and expects the outputs
    to be the `same` or to `differ`. With `only` (globs), the files that differ must all match one of them.
    """
    reference = ctx.parent(ctx.commit) if vs == 'parent' else vs
    result = ctx.qa('--platform', platform, 'check-bit-accuracy', '--batch', batch, '--reference', ctx.sha(reference))
    differing = sorted({line.split('❌', 1)[1].strip() for line in result.stdout.splitlines() if '❌' in line})
    same = result.returncode == 0
    summary = f'{ctx.commit} vs {reference}: ' + ('bit-accurate' if same else f'{len(differing)} files differ: {", ".join(differing[:12])}')
    if expect == 'same':
        return same, summary
    if same:
        return False, summary
    if only:
        unexpected = [f for f in differing if not any(fnmatch.fnmatch(f, pattern) for pattern in only)]
        if unexpected or not differing:
            return False, f'{summary}; not expected to differ: {", ".join(unexpected) or "(no file listed)"}'
    return True, summary
