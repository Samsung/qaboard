"""
Checks of story.yaml that need more than a metric: hook(ctx, **args) -> (ok, message). See ../STORY.md#checks.
They run in the seeder's Python (standard library, PyYAML), not the example's: no numpy here.
"""
import json
import statistics


def optimize_converged(ctx, min_gain=0.04, initial_points=8, label='tune-int8'):
    """
    In a `qa optimize` batch, the best iteration's objective is lower than the first iteration's by `min_gain` or more,
    and the optimizer found it after its `initial_points` random ones (`solver.n_startup_trials` in qa/tune-int8.yaml):
    the search did better than chance.

    What `qa optimize` stores for each iteration is its `objective` (the value it minimizes, see qa/tune-int8.yaml:
    -(AP small + mAP) + 0.005 per MB, means over the runs), its `iteration` and the objective's metrics: the Tuning
    Analysis view plots them.
    """
    iterations = sorted((r for r in ctx.runs(label=label) if 'iteration' in r.metrics and 'objective' in r.metrics),
                        key=lambda r: r.metrics['iteration'])
    if len(iterations) <= initial_points:
        return False, f'{len(iterations)} iterations in {label}, expected more than {initial_points}'
    first = iterations[0]
    best = min(iterations, key=lambda r: r.metrics['objective'])
    best_random = min(iterations[:initial_points], key=lambda r: r.metrics['objective'])
    gain = first.metrics['objective'] - best.metrics['objective']
    params = {k: v for k, v in best.extra_parameters.items() if not k.startswith('_')}
    message = (f"{len(iterations)} iterations: objective {first.metrics['objective']:.4f} at the first, "
               f"{best_random.metrics['objective']:.4f} at the best of the {initial_points} random ones, "
               f"{best.metrics['objective']:.4f} at the best (iteration {best.metrics['iteration']:.0f}: {json.dumps(params, sort_keys=True)})")
    return gain >= min_gain and best.metrics['iteration'] > initial_points, message


def _iou(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    inter = w * h
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def _found(labels, detections):
    """Indices of the labels found at IoU 0.5 by a detection of their class (greedy, by decreasing score)"""
    taken = set()
    for d in sorted(detections, key=lambda d: -d['score']):
        best, best_iou = None, 0.5
        for i, label in enumerate(labels):
            if i in taken or label['category_id'] != d['category_id']:
                continue
            iou = _iou(label['box'], d['box'])
            if iou >= best_iou:
                best, best_iou = i, iou
        if best is not None:
            taken.add(best)
    return taken


def misses_what_fp32_finds(ctx, inputs, min_objects=3, configs='*int8*', vs_configs='*fp32*'):
    """
    On the slice `inputs`, the int8 run misses at least `min_objects` labeled objects that the fp32 run of the same
    commit finds (at IoU 0.5, same class). Names the image where it misses the most, for the docs' screenshot.
    """
    new = [r for r in ctx.runs(inputs=inputs, configs=configs) if not r.failed]
    ref = [r for r in ctx.runs(inputs=inputs, configs=vs_configs) if not r.failed]
    if len(new) != 1 or len(ref) != 1:
        return False, f'expected one run of each, got {len(new)} and {len(ref)}'
    coco = json.loads((ctx.workspace / 'inputs' / new[0].input / 'labels.json').read_text())
    labels = {}
    for a in coco['annotations']:
        if not a.get('iscrowd'):
            x, y, w, h = a['bbox']
            labels.setdefault(a['image_id'], []).append({'category_id': a['category_id'], 'box': [x, y, x + w, y + h]})
    new_detections = json.loads(new[0].file('detections.json').read_text())
    ref_detections = json.loads(ref[0].file('detections.json').read_text())
    lost, gained, worst = 0, 0, (0, None, 0)
    for n, image in enumerate(coco['images'], start=1):
        objects = labels.get(image['id'], [])
        found_new = _found(objects, new_detections.get(image['file_name'], []))
        found_ref = _found(objects, ref_detections.get(image['file_name'], []))
        lost += len(found_ref - found_new)
        gained += len(found_new - found_ref)
        if len(found_ref - found_new) > worst[0]:
            worst = (len(found_ref - found_new), image['file_name'], n)
    message = f'int8 misses {lost} objects fp32 finds, and finds {gained} fp32 misses'
    if worst[1]:
        message += f'; the most in {worst[1]} (images/{worst[2]}.jpg: {worst[0]})'
    return lost >= min_objects, message


def every_slice(ctx, metric, vs='parent', min_change_pct=None, max_change_pct=None, configs=None):
    """Each run's `metric` changes by a percentage within [min_change_pct, max_change_pct] against the same run of `vs`"""
    reference = ctx.parent(ctx.commit) if vs == 'parent' else vs
    key = lambda r: (r.input, json.dumps(r.configurations, sort_keys=True))
    new = {key(r): r for r in ctx.runs(configs=configs) if not r.failed}
    ref = {key(r): r for r in ctx.runs(commit=reference, configs=configs) if not r.failed}
    changes = {}
    for k, run in new.items():
        if k in ref and ref[k].metrics.get(metric):
            changes[k] = (run.metrics[metric] - ref[k].metrics[metric]) / abs(ref[k].metrics[metric]) * 100
    if not changes:
        return False, f'no runs to compare with {reference}'
    ok = all((min_change_pct is None or c >= min_change_pct) and (max_change_pct is None or c <= max_change_pct) for c in changes.values())
    summary = ', '.join(f"{k[0].split('/')[-1]} {' '.join(map(str, json.loads(k[1])))}: {c:+.1f}%" for k, c in sorted(changes.items()))
    return ok, f'{metric} vs {reference}: {summary} (median {statistics.median(changes.values()):+.1f}%)'
