# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["torch==2.14.1", "torchvision==0.29.1", "numpy", "pillow", "pyyaml"]
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# torchvision = { index = "pytorch-cpu" }
# ///
"""
Maintainers: labels a slice of photos with a larger reference model, torchvision's Faster R-CNN ResNet-50 FPN v2
(COCO box AP 46.7, against 21.3 for the SSDlite under test), at the photos' full resolution. Nobody reviewed them:
there is no well-known detection dataset under CC0 to take labels from. The detector is evaluated against what a
much better model sees, and the docs say so.

    uv run qa/propose_labels.py slices/indoor     # writes inputs/slices/indoor/labels.json
    uv run qa/propose_labels.py --donors          # the objects qa/make_small_objects.py --plan can paste

The policy, for the K3's 8 classes (other COCO classes are ignored):
- score >= 0.6, and at least 24x24 px in the 320x320 frame: an object to find,
- score 0.4-0.6, or smaller than that: a crowd box (`iscrowd: 1`), a region where the evaluation ignores detections
  (the labels aren't sure, or the object is too small to matter).
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLASSES = {1: 'person', 2: 'bicycle', 3: 'car', 8: 'truck', 62: 'chair', 44: 'bottle', 27: 'backpack', 64: 'potted plant'}
LABEL_SCORE, CROWD_SCORE, MIN_FRAME_SIDE = 0.6, 0.4, 24
REFERENCE = 'fasterrcnn_resnet50_fpn_v2 (COCO_V1 weights), torchvision 0.29.1'


def frame_side(box, width, height):
    """sqrt(area) of an [x1, y1, x2, y2] box in the 320x320 frame"""
    return (max(0.0, box[2] - box[0]) * 320 / width * max(0.0, box[3] - box[1]) * 320 / height) ** 0.5


def to_annotations(detections, width, height):
    """Reference detections [{category_id, score, box}] -> COCO annotations (bbox as x, y, w, h)"""
    annotations = []
    for d in sorted(detections, key=lambda d: -d['score']):
        if d['category_id'] not in CLASSES or d['score'] < CROWD_SCORE:
            continue
        x1, y1, x2, y2 = (round(float(v), 1) for v in d['box'])
        crowd = d['score'] < LABEL_SCORE or frame_side(d['box'], width, height) < MIN_FRAME_SIDE
        annotations.append({'category_id': d['category_id'], 'bbox': [x1, y1, round(x2 - x1, 1), round(y2 - y1, 1)],
                            'area': round((x2 - x1) * (y2 - y1), 1), 'iscrowd': int(crowd), 'score': round(d['score'], 3)})
    return annotations


def coco(images, description):
    """images: [{file_name, width, height, annotations, source...}] -> a COCO labels.json document"""
    out_images, out_annotations = [], []
    for image_id, image in enumerate(images, start=1):
        out_images.append({'id': image_id, **{k: v for k, v in image.items() if k != 'annotations'}})
        for a in image['annotations']:
            out_annotations.append({'id': len(out_annotations) + 1, 'image_id': image_id, **a})
    return {
        'info': {'description': description, 'labels': f'proposed by {REFERENCE}, not reviewed (qa/propose_labels.py)',
                 'license': 'CC0-1.0'},
        'images': out_images, 'annotations': out_annotations,
        'categories': [{'id': c, 'name': n} for c, n in CLASSES.items()],
    }


def main(folder):
    import numpy as np
    import torch
    import torchvision
    import yaml
    from PIL import Image

    torch.set_num_threads(4)
    weights = torchvision.models.detection.FasterRCNN_ResNet50_FPN_V2_Weights.COCO_V1
    model = torchvision.models.detection.fasterrcnn_resnet50_fpn_v2(weights=weights, box_score_thresh=0.3).eval()
    lock = yaml.safe_load((ROOT / 'inputs.lock.yaml').read_text())
    database = ROOT / 'inputs'
    images = []
    for rel, photo in lock['photos'].items():
        if Path(rel).parent.as_posix() != folder:
            continue
        with Image.open(database / rel) as image:
            image = image.convert('RGB')
            x = torch.from_numpy(np.asarray(image).copy()).permute(2, 0, 1).float() / 255
            with torch.inference_mode():
                r = model([x])[0]
        detections = [{'category_id': int(c), 'score': float(s), 'box': [float(v) for v in b]}
                      for b, c, s in zip(r['boxes'], r['labels'], r['scores'])]
        images.append({'file_name': Path(rel).name, 'width': image.width, 'height': image.height,
                       'annotations': to_annotations(detections, image.width, image.height)})
        print(f"{rel}: {sum(1 for a in images[-1]['annotations'] if not a['iscrowd'])} objects")
    path = database / folder / 'labels.json'
    path.write_text(dumps(coco(images, f'Kitefin detector test set, {Path(folder).name} slice')))


def dumps(doc):
    """Compact JSON, one image or annotation per line"""
    return json.dumps(doc, separators=(',', ':')).replace('{"id":', '\n{"id":') + '\n'


def rle_encode(mask):
    """Row-major run lengths of a boolean array, starting with a run of False"""
    import numpy as np
    flat = mask.astype(np.uint8).ravel()
    bounds = np.concatenate([[0], np.flatnonzero(np.diff(flat)) + 1, [len(flat)]])
    counts = np.diff(bounds).tolist()
    return counts if not flat[0] else [0, *counts]


def is_donor(a, image):
    """A confident label, big enough to be cut out cleanly, away from the image's borders"""
    x, y, w, h = a['bbox']
    return (not a['iscrowd'] and a['score'] >= 0.75 and max(w, h) >= 64 and min(w, h) >= 16
            and x >= 4 and y >= 4 and x + w <= image['width'] - 4 and y + h <= image['height'] - 4)


def donors(folders):
    """
    The objects the small-objects composites are made of: confident labels of the photo slices, with their silhouette
    from the reference's sibling Mask R-CNN v2 (same class, box IoU 0.7 or more), as run lengths over the label's box.
    Writes inputs/slices/small-objects/donors.json, that qa/make_small_objects.py --plan reads.
    """
    import numpy as np
    import torch
    import torchvision
    from PIL import Image

    torch.set_num_threads(4)
    weights = torchvision.models.detection.MaskRCNN_ResNet50_FPN_V2_Weights.COCO_V1
    model = torchvision.models.detection.maskrcnn_resnet50_fpn_v2(weights=weights, box_score_thresh=0.5).eval()
    database = ROOT / 'inputs'
    found = []
    for folder in folders:
        labels = json.loads((database / folder / 'labels.json').read_text())
        for image in labels['images']:
            candidates = [a for a in labels['annotations'] if a['image_id'] == image['id'] and is_donor(a, image)]
            if not candidates:
                continue
            with Image.open(database / folder / image['file_name']) as picture:
                x = torch.from_numpy(np.asarray(picture.convert('RGB')).copy()).permute(2, 0, 1).float() / 255
            with torch.inference_mode():
                r = model([x])[0]
            for a in candidates:
                bx, by, bw, bh = a['bbox']
                box = np.array([bx, by, bx + bw, by + bh])
                best, best_iou = None, 0.7
                for i, (b, c) in enumerate(zip(r['boxes'].numpy(), r['labels'].numpy())):
                    if int(c) != a['category_id']:
                        continue
                    lt, rb = np.maximum(box[:2], b[:2]), np.minimum(box[2:], b[2:])
                    inter = np.prod(np.clip(rb - lt, 0, None))
                    iou = inter / (bw * bh + (b[2] - b[0]) * (b[3] - b[1]) - inter)
                    if iou >= best_iou:
                        best, best_iou = i, iou
                if best is None:
                    continue
                x1, y1 = int(np.floor(box[0])), int(np.floor(box[1]))
                x2, y2 = int(np.ceil(box[2])), int(np.ceil(box[3]))
                mask = r['masks'][best, 0].numpy()[y1:y2, x1:x2] >= 0.5
                if mask.mean() < 0.15:
                    continue
                # the box of the silhouette: the composite's label
                ys, xs = np.nonzero(mask)
                tight = [x1 + int(xs.min()), y1 + int(ys.min()), x1 + int(xs.max()) + 1, y1 + int(ys.max()) + 1]
                mask = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
                found.append({'file': f"{folder}/{image['file_name']}", 'category_id': a['category_id'], 'box': tight,
                              'mask': {'size': list(mask.shape), 'counts': rle_encode(mask)}})
            print(f"{folder}/{image['file_name']}: {sum(1 for d in found if d['file'].endswith(image['file_name']) and d['file'].startswith(folder))} donors")
    path = database / 'slices' / 'small-objects' / 'donors.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'info': 'Objects cut out of the photo slices for the small-objects composites: label boxes '
                                        'of qa/propose_labels.py, silhouettes from maskrcnn_resnet50_fpn_v2 (COCO_V1).',
                                'donors': found}, separators=(',', ':')) + '\n')
    print(f'{len(found)} donors')


if __name__ == '__main__':
    if sys.argv[1] == '--donors':
        donors(['slices/indoor', 'slices/outdoor', 'slices/warehouse'])
    else:
        main(sys.argv[1].rstrip('/'))
