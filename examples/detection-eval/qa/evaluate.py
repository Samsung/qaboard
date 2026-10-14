"""
COCO-style evaluation of a slice's detections against its labels, in numpy (the same matching as pycocotools).

- AP is averaged over IoU 0.50:0.05:0.95 and over the classes that have ground truth in the slice; AP50 at IoU 0.5.
- Object sizes are measured in the 320x320 frame the model sees at size-320, whatever the run's input size: small
  objects are smaller than 64x64 px there (the detector's smallest anchor box), large ones larger than 128x128. AP
  small only counts small objects (and the detections that match them, or that are small themselves), like
  pycocotools' area ranges.
- Crowd boxes (`iscrowd: 1`) are regions where the labels aren't sure. A detection that only matches a crowd box is
  ignored: neither a hit nor a false alarm, however many detections fall on it. With `crowd_many: false` (the bug the
  story fixes), a crowd box only absorbs its first detection, and the others count as false alarms.
- Recall is at IoU 0.5, over the detections the run kept (score above the threshold).
"""
import numpy as np

from detector import box_iou

IOU_THRESHOLDS = np.round(np.arange(0.5, 0.951, 0.05), 2)
RECALL_POINTS = np.linspace(0, 1, 101)
FRAME = 320
AREAS = {'all': (0, 1e10), 'small': (0, 64 ** 2), 'medium': (64 ** 2, 128 ** 2), 'large': (128 ** 2, 1e10)}


def scaled_area(box, image_size):
    """Area of an [x1, y1, x2, y2] box in the 320x320 frame (the image resized without keeping its aspect ratio)"""
    width, height = image_size
    return max(0.0, box[2] - box[0]) * FRAME / width * max(0.0, box[3] - box[1]) * FRAME / height


def size_bucket(area):
    return 'small' if area < AREAS['small'][1] else 'medium' if area < AREAS['medium'][1] else 'large'


def match_image(dets, gts, crowd, iou_threshold, area_range, image_size, crowd_many=True):
    """
    Matches one image's detections of one class (sorted by decreasing score) to its ground truth, like pycocotools.
    -> (det_matched [bool], det_ignored [bool], number of ground truth objects that count)
    """
    lo, hi = area_range
    gt_boxes = [g['box'] for g in gts] + [c['box'] for c in crowd]
    gt_crowd = [False] * len(gts) + [True] * len(crowd)
    gt_area = [scaled_area(b, image_size) for b in gt_boxes]
    # crowd boxes are ignored, ground truth outside the area range too
    gt_ignore = [is_crowd or not lo <= a < hi for is_crowd, a in zip(gt_crowd, gt_area)]
    n_positive = sum(1 for ignore in gt_ignore if not ignore)
    # non-ignored ground truth first, like pycocotools
    order = sorted(range(len(gt_boxes)), key=lambda i: gt_ignore[i])
    gt_boxes = [gt_boxes[i] for i in order]
    gt_ignore = [gt_ignore[i] for i in order]
    gt_crowd = [gt_crowd[i] for i in order]
    matched = np.zeros(len(dets), dtype=bool)
    ignored = np.zeros(len(dets), dtype=bool)
    if not dets:
        return matched, ignored, n_positive
    det_boxes = np.array([d['box'] for d in dets], dtype=np.float64).reshape(-1, 4)
    ious = box_iou(det_boxes, np.array(gt_boxes, dtype=np.float64).reshape(-1, 4)) if gt_boxes else np.zeros((len(dets), 0))
    if gt_boxes:
        # crowd boxes: intersection over the detection's area, like pycocotools
        det_area = (det_boxes[:, 2] - det_boxes[:, 0]) * (det_boxes[:, 3] - det_boxes[:, 1])
        for j, is_crowd in enumerate(gt_crowd):
            if is_crowd:
                g = np.array(gt_boxes[j])
                lt = np.maximum(det_boxes[:, :2], g[:2])
                rb = np.minimum(det_boxes[:, 2:], g[2:])
                inter = np.prod(np.clip(rb - lt, 0, None), axis=1)
                ious[:, j] = np.where(det_area > 0, inter / np.maximum(det_area, 1e-12), 0)
    gt_taken = [False] * len(gt_boxes)
    for d in range(len(dets)):
        best, best_iou = -1, min(iou_threshold, 1 - 1e-10)
        for g in range(len(gt_boxes)):
            # a crowd box absorbs any number of detections (the bug: only the first)
            if gt_taken[g] and not (gt_crowd[g] and crowd_many):
                continue
            # once matched to a non-ignored object, stop at the first ignored one
            if best > -1 and not gt_ignore[best] and gt_ignore[g]:
                break
            if ious[d, g] < best_iou:
                continue
            best, best_iou = g, ious[d, g]
        if best == -1:
            # an unmatched detection outside the area range is ignored
            ignored[d] = not lo <= scaled_area(dets[d]['box'], image_size) < hi
            continue
        gt_taken[best] = True
        matched[d] = True
        ignored[d] = gt_ignore[best]
    return matched, ignored, n_positive


def average_precision(scores, matched, ignored, n_positive):
    """101-point interpolated AP, like pycocotools. None when there is nothing to find."""
    if n_positive == 0:
        return None
    keep = ~ignored
    order = np.argsort(-scores[keep], kind='mergesort')
    tp = matched[keep][order].astype(np.float64)
    fp = 1 - tp
    if not tp.size:
        return 0.0, np.zeros(0), np.zeros(0)
    tp_sum, fp_sum = np.cumsum(tp), np.cumsum(fp)
    recall = tp_sum / n_positive
    precision = tp_sum / np.maximum(tp_sum + fp_sum, np.finfo(np.float64).eps)
    # monotonic precision envelope
    envelope = np.maximum.accumulate(precision[::-1])[::-1]
    idx = np.searchsorted(recall, RECALL_POINTS, side='left')
    interpolated = np.array([envelope[i] if i < len(envelope) else 0.0 for i in idx])
    return float(interpolated.mean()), recall, precision


def evaluate(images, detections, class_ids, crowd_many=True):
    """
    images: [{id, width, height}], labels: per image id, [{category_id, box, iscrowd}] (in the image's pixels)
    detections: per image id, [{category_id, score, box}]
    -> dict of metrics, and per-class precision-recall curves at IoU 0.5
    """
    results = {'ap': {}, 'ap50': {}, 'ap_area': {a: {} for a in AREAS}, 'recall_area': {}, 'curves': {}}
    per_class_iou_ap = {}
    for class_id in class_ids:
        aps_by_area = {a: [] for a in AREAS}
        for area_name, area_range in AREAS.items():
            for t in IOU_THRESHOLDS:
                scores, matched, ignored, n_pos = [], [], [], 0
                for image in images:
                    gts = [g for g in image['labels'] if g['category_id'] == class_id and not g.get('iscrowd')]
                    crowd = [g for g in image['labels'] if g['category_id'] == class_id and g.get('iscrowd')]
                    dets = sorted((d for d in detections.get(image['id'], []) if d['category_id'] == class_id), key=lambda d: -d['score'])
                    m, ig, n = match_image(dets, gts, crowd, t, area_range, (image['width'], image['height']), crowd_many)
                    scores.extend(d['score'] for d in dets)
                    matched.append(m)
                    ignored.append(ig)
                    n_pos += n
                scores = np.array(scores, dtype=np.float64)
                matched = np.concatenate(matched) if matched else np.zeros(0, dtype=bool)
                ignored = np.concatenate(ignored) if ignored else np.zeros(0, dtype=bool)
                ap = average_precision(scores, matched, ignored, n_pos)
                if ap is None:
                    aps_by_area[area_name].append(None)
                    continue
                aps_by_area[area_name].append(ap[0])
                if area_name == 'all' and t == 0.5:
                    results['curves'][class_id] = {'recall': ap[1], 'precision': ap[2], 'n_positive': n_pos}
                if t == 0.5 and area_name != 'all':
                    found = int(matched[~ignored].sum())
                    results['recall_area'].setdefault(area_name, [0, 0])
                    results['recall_area'][area_name][0] += found
                    results['recall_area'][area_name][1] += n_pos
        for area_name, aps in aps_by_area.items():
            if aps and aps[0] is not None:
                results['ap_area'][area_name][class_id] = float(np.mean(aps))
        if aps_by_area['all'] and aps_by_area['all'][0] is not None:
            per_class_iou_ap[class_id] = aps_by_area['all']
            results['ap'][class_id] = float(np.mean(aps_by_area['all']))
            results['ap50'][class_id] = float(aps_by_area['all'][0])
    return results


def summary_metrics(results):
    """mAP, AP50, AP by size, recall by size: means over the classes that have ground truth"""
    def mean(values):
        values = [v for v in values if v is not None]
        return float(np.mean(values)) if values else None
    metrics = {
        'map': mean(results['ap'].values()),
        'map50': mean(results['ap50'].values()),
        'ap_small': mean(results['ap_area']['small'].values()),
        'ap_medium': mean(results['ap_area']['medium'].values()),
        'ap_large': mean(results['ap_area']['large'].values()),
    }
    for area in ('small', 'medium', 'large'):
        found, total = results['recall_area'].get(area, (0, 0))
        metrics[f'recall_{area}'] = found / total if total else None
    return metrics


def greedy_matches(labels, detections, iou_threshold=0.5, same_class=True):
    """Pairs (label index, detection index): by decreasing score, each detection takes its best free label"""
    order = sorted(range(len(detections)), key=lambda d: -detections[d]['score'])
    targets = [i for i, a in enumerate(labels) if not a.get('iscrowd')]
    if not targets or not detections:
        return []
    ious = box_iou(np.array([detections[d]['box'] for d in order], dtype=np.float64).reshape(-1, 4),
                   np.array([labels[i]['box'] for i in targets], dtype=np.float64).reshape(-1, 4))
    taken, pairs = set(), []
    for row, d in enumerate(order):
        best, best_iou = None, iou_threshold
        for col, i in enumerate(targets):
            if i in taken or ious[row, col] < best_iou:
                continue
            if same_class and labels[i]['category_id'] != detections[d]['category_id']:
                continue
            best, best_iou = i, ious[row, col]
        if best is not None:
            taken.add(best)
            pairs.append((best, d))
    return pairs


def missed_labels(labels, detections):
    """Indices of the (non-crowd) labels that no detection of their class found at IoU 0.5"""
    found = {i for i, _ in greedy_matches(labels, detections)}
    return {i for i, a in enumerate(labels) if not a.get('iscrowd') and i not in found}


def counts(images):
    """Labeled objects by class and by size (crowd boxes excluded)"""
    by_class, by_size = {}, {}
    for image in images:
        for a in image['labels']:
            if a.get('iscrowd'):
                continue
            by_class[a['category_id']] = by_class.get(a['category_id'], 0) + 1
            size = size_bucket(scaled_area(a['box'], (image['width'], image['height'])))
            by_size[size] = by_size.get(size, 0) + 1
    return {'by_class': by_class, 'by_size': by_size}


def confusion_matrix(images, detections):
    """Labeled class (or background) x detected class (or background), matched at IoU 0.5 whatever their class"""
    from detector import CLASSES
    ids = list(CLASSES)
    index = {c: i for i, c in enumerate(ids)}
    background = len(ids)
    matrix = np.zeros((len(ids) + 1, len(ids) + 1), dtype=int)
    for image in images:
        labels, dets = image['labels'], detections.get(image['id'], [])
        pairs = greedy_matches(labels, dets, same_class=False)
        matched_labels = {i for i, _ in pairs}
        matched_dets = {d for _, d in pairs}
        for i, d in pairs:
            matrix[index[labels[i]['category_id']], index[dets[d]['category_id']]] += 1
        for i, a in enumerate(labels):
            if not a.get('iscrowd') and i not in matched_labels:
                matrix[index[a['category_id']], background] += 1
        crowd = np.array([a['box'] for a in labels if a.get('iscrowd')], dtype=np.float64).reshape(-1, 4)
        for d, det in enumerate(dets):
            if d in matched_dets:
                continue
            # detections on crowd boxes are ignored, like in the AP
            if len(crowd) and box_iou(np.array([det['box']], dtype=np.float64), crowd).max() >= 0.5:
                continue
            matrix[background, index[det['category_id']]] += 1
    return [CLASSES[c] for c in ids] + ['background'], matrix.tolist()
