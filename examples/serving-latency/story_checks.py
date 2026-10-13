"""
Checks of story.yaml that need more than a metric: hook(ctx, **args) -> (ok, message). See ../STORY.md#checks.
"""
import re
import statistics


def _read_folded(path):
    stacks = {}
    if path.exists():
        for line in path.read_text().splitlines():
            stack, _, count = line.rpartition(' ')
            if stack and count.isdigit():
                stacks[stack] = stacks.get(stack, 0) + int(count)
    return stacks


def _share(runs, pattern):
    """Median over the runs of the share of CPU samples with a frame matching the regex"""
    regex = re.compile(pattern)
    shares = []
    for run in runs:
        stacks = _read_folded(run.file('cpu.folded'))
        total = sum(stacks.values())
        if total:
            shares.append(sum(c for s, c in stacks.items() if any(regex.search(f) for f in s.split(';'))) / total)
    return statistics.median(shares) if shares else None


def flame_share(ctx, match, min_share, parent_max_share=None, inputs=None):
    """
    In the commit's CPU profiles (cpu.folded, the data of cpu.flame.json), frames matching `match` take at least
    `min_share` of the samples, and at most `parent_max_share` in its parent's.
    """
    runs = [r for r in ctx.runs(inputs=inputs) if not r.failed]
    share = _share(runs, match)
    if share is None:
        return False, f'no CPU profile in {ctx.commit}'
    message = f'/{match}/: {share:.1%} of the CPU samples in {ctx.commit} (at least {min_share:.0%})'
    ok = share >= min_share
    if parent_max_share is not None:
        parent = ctx.parent(ctx.commit)
        parent_share = _share([r for r in ctx.runs(commit=parent, inputs=inputs) if not r.failed], match)
        if parent_share is None:
            return False, f'{message}; no CPU profile in {parent}'
        message += f', {parent_share:.1%} in {parent} (at most {parent_max_share:.0%})'
        ok = ok and parent_share <= parent_max_share
    return ok, message


def on_frontier(ctx, x, y, params, tolerance=None):
    """
    In a tuning batch, the configuration `params` is on the efficient frontier of metrics x and y (smaller is better
    for both), like QA-Board's tuning analysis shows it: each configuration's metrics are its median over the tests.
    Measurements are noisy: another configuration only dominates when it beats this one on both metrics by more than
    `tolerance` (relative, per metric; default 5% on x, 50% on y: on a 4-CPU runner, identical configurations of a
    sweep measured with 3 repeats of 2 s land a few percent apart on CPU per request, and up to tens of percent on p99).
    """
    tolerance = tolerance or {x: 0.05, y: 0.5}
    by_params = {}
    for run in ctx.runs():
        if run.failed or run.pending or x not in run.metrics or y not in run.metrics:
            continue
        key = tuple(sorted((k, v) for k, v in run.extra_parameters.items() if k in params or not k.startswith('_')))
        by_params.setdefault(key, []).append(run)
    points = {key: (statistics.median(r.metrics[x] for r in runs), statistics.median(r.metrics[y] for r in runs)) for key, runs in by_params.items()}
    chosen = next((key for key in points if all(dict(key).get(k) == v for k, v in params.items())), None)
    if chosen is None:
        return False, f'no tuning run with {params} among {len(points)} configurations'
    cx, cy = points[chosen]
    dominating = [
        (dict(key), px, py) for key, (px, py) in points.items()
        if key != chosen and px < cx * (1 - tolerance[x]) and py < cy * (1 - tolerance[y])
    ]
    summary = f'{params}: {x} {cx:.4g}, {y} {cy:.4g}, among {len(points)} configurations'
    if dominating:
        better = '; '.join(f'{p}: {x} {px:.4g}, {y} {py:.4g}' for p, px, py in dominating[:3])
        return False, f'{summary}; dominated by {better}'
    return True, summary
