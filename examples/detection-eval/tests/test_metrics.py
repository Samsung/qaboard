"""
Unit tests of the example's metric code. The parity test needs pycocotools:

    uv run --with numpy --with pillow --with pyyaml --with pycocotools python -m unittest discover examples/detection-eval/tests
"""
import random
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'qa'))
import detector  # noqa: E402
import evaluate  # noqa: E402
import make_small_objects  # noqa: E402
import propose_labels  # noqa: E402

PERSON, CAR = 1, 3


def image(labels, size=(320, 320), id='a'):
    return {'id': id, 'width': size[0], 'height': size[1], 'labels': labels}


def label(box, category=PERSON, crowd=0):
    return {'category_id': category, 'box': box, 'iscrowd': crowd}


def detection(box, score, category=PERSON):
    return {'category_id': category, 'score': score, 'box': box}


class TestPostprocessing(unittest.TestCase):
    def test_zero_deltas_give_the_anchors(self):
        anchors = np.array([[10, 20, 50, 80], [0, 0, 32, 32]], dtype=np.float64)
        np.testing.assert_allclose(detector.decode_boxes(np.zeros((2, 4)), anchors), anchors)

    def test_deltas_move_and_scale(self):
        anchors = np.array([[0, 0, 10, 20]], dtype=np.float64)
        # dx = 10 * 0.1 -> +0.1 width, dw = 5 * log(2) -> twice as wide
        boxes = detector.decode_boxes(np.array([[1.0, 0.0, 5 * np.log(2), 0.0]]), anchors)
        np.testing.assert_allclose(boxes, [[-4, 0, 16, 20]])

    def test_nms_keeps_the_best_of_overlapping_boxes(self):
        boxes = np.array([[0, 0, 10, 10], [1, 1, 11, 11], [20, 20, 30, 30]], dtype=np.float64)
        kept = detector.nms(boxes, np.array([0.5, 0.9, 0.4]), 0.5)
        self.assertEqual(kept.tolist(), [1, 2])

    def test_postprocess_scales_to_the_image_and_drops_other_classes(self):
        anchors = np.array([[0, 0, 160, 160], [160, 160, 320, 320]], dtype=np.float32)
        logits = np.full((2, 91), -10.0, dtype=np.float32)
        logits[0, PERSON] = 10   # a person
        logits[1, 17] = 10       # a cat: not one of the K3's classes
        found = detector.postprocess(np.zeros((2, 4), dtype=np.float32), logits, anchors, 320, (640, 480), 0.3, 0.5)
        self.assertEqual(len(found), 1)
        class_id, score, box = found[0]
        self.assertEqual(class_id, PERSON)
        self.assertGreater(score, 0.99)
        np.testing.assert_allclose(box, [0, 0, 320, 240])


class TestEvaluation(unittest.TestCase):
    def test_perfect_detections(self):
        images = [image([label([10, 10, 100, 200]), label([150, 20, 300, 300], CAR)])]
        dets = {'a': [detection([10, 10, 100, 200], 0.9), detection([150, 20, 300, 300], 0.8, CAR)]}
        metrics = evaluate.summary_metrics(evaluate.evaluate(images, dets, [PERSON, CAR]))
        self.assertAlmostEqual(metrics['map'], 1.0)
        self.assertAlmostEqual(metrics['map50'], 1.0)

    def test_a_false_alarm_ranked_first(self):
        images = [image([label([10, 10, 100, 200])])]
        dets = {'a': [detection([200, 200, 300, 300], 0.9), detection([10, 10, 100, 200], 0.5)]}
        results = evaluate.evaluate(images, dets, [PERSON])
        # precision 0.5 at every recall, on the 101-point grid
        self.assertAlmostEqual(results['ap50'][PERSON], 0.5)

    def test_sizes_are_measured_in_the_320_frame(self):
        # a 128x96 box in a 1280x960 image is 32x32 in the 320x320 frame
        self.assertAlmostEqual(evaluate.scaled_area([0, 0, 128, 96], (1280, 960)), 32 * 32)
        self.assertEqual(evaluate.size_bucket(63 * 63), 'small')
        self.assertEqual(evaluate.size_bucket(64 * 64), 'medium')
        self.assertEqual(evaluate.size_bucket(128 * 128), 'large')

    def test_crowd_boxes_absorb_every_detection_once_fixed(self):
        images = [image([label([10, 10, 100, 200]), label([150, 150, 300, 300], crowd=1)])]
        dets = {'a': [detection([160, 160, 220, 290], 0.95), detection([230, 160, 290, 290], 0.9), detection([10, 10, 100, 200], 0.8)]}
        fixed = evaluate.summary_metrics(evaluate.evaluate(images, dets, [PERSON], crowd_many=True))
        buggy = evaluate.summary_metrics(evaluate.evaluate(images, dets, [PERSON], crowd_many=False))
        self.assertAlmostEqual(fixed['map'], 1.0)
        # the bug: the crowd box absorbs the first detection, the second is a false alarm ranked above the object
        self.assertAlmostEqual(buggy['map'], 0.5)

    def test_recall_by_size(self):
        images = [image([label([0, 0, 40, 40]), label([100, 100, 140, 140]), label([0, 150, 200, 320])])]
        dets = {'a': [detection([0, 0, 40, 40], 0.9), detection([0, 150, 200, 320], 0.8)]}
        metrics = evaluate.summary_metrics(evaluate.evaluate(images, dets, [PERSON]))
        self.assertAlmostEqual(metrics['recall_small'], 0.5)
        self.assertAlmostEqual(metrics['recall_large'], 1.0)
        self.assertIsNone(metrics['recall_medium'])

    def test_missed_labels_and_confusions(self):
        images = [image([label([0, 0, 50, 50]), label([100, 100, 200, 200], CAR), label([250, 250, 300, 300])])]
        dets = {'a': [detection([0, 0, 50, 50], 0.9), detection([100, 100, 200, 200], 0.7, PERSON), detection([5, 200, 60, 240], 0.6, CAR)]}
        self.assertEqual(evaluate.missed_labels(images[0]['labels'], dets['a']), {1, 2})
        names, matrix = evaluate.confusion_matrix(images, dets)
        index = {n: i for i, n in enumerate(names)}
        self.assertEqual(matrix[index['person']][index['person']], 1)
        self.assertEqual(matrix[index['car']][index['person']], 1)
        self.assertEqual(matrix[index['person']][index['background']], 1)
        self.assertEqual(matrix[index['background']][index['car']], 1)


class TestPycocotoolsParity(unittest.TestCase):
    """Same AP as pycocotools, on random 320x320 images (where the 320 frame is the image)"""

    def test_random_detections(self):
        try:
            from pycocotools.coco import COCO
            from pycocotools.cocoeval import COCOeval
        except ImportError:
            self.skipTest('pycocotools is not installed')
        rng = random.Random(7)
        images, detections, gt, dt = [], {}, [], []
        for i in range(12):
            labels = []
            for _ in range(rng.randint(1, 6)):
                w, h = rng.uniform(20, 200), rng.uniform(20, 200)
                x, y = rng.uniform(0, 320 - w), rng.uniform(0, 320 - h)
                labels.append(label([x, y, x + w, y + h], rng.choice([PERSON, CAR]), crowd=int(rng.random() < 0.15)))
            dets = []
            for a in labels:
                if rng.random() < 0.75:
                    jitter = [v + rng.uniform(-12, 12) for v in a['box']]
                    dets.append(detection(jitter, rng.uniform(0.1, 1), a['category_id']))
            for _ in range(rng.randint(0, 3)):
                w, h = rng.uniform(20, 120), rng.uniform(20, 120)
                x, y = rng.uniform(0, 320 - w), rng.uniform(0, 320 - h)
                dets.append(detection([x, y, x + w, y + h], rng.uniform(0.1, 1), rng.choice([PERSON, CAR])))
            images.append(image(labels, id=i + 1))
            detections[i + 1] = dets
            for a in labels:
                x1, y1, x2, y2 = a['box']
                gt.append({'id': len(gt) + 1, 'image_id': i + 1, 'category_id': a['category_id'], 'bbox': [x1, y1, x2 - x1, y2 - y1],
                           'area': (x2 - x1) * (y2 - y1), 'iscrowd': a['iscrowd']})
            for d in dets:
                x1, y1, x2, y2 = d['box']
                dt.append({'image_id': i + 1, 'category_id': d['category_id'], 'bbox': [x1, y1, x2 - x1, y2 - y1], 'score': d['score']})
        coco = COCO()
        coco.dataset = {'images': [{'id': i['id'], 'width': 320, 'height': 320} for i in images], 'annotations': gt,
                        'categories': [{'id': PERSON, 'name': 'person'}, {'id': CAR, 'name': 'car'}]}
        coco.createIndex()
        evaluation = COCOeval(coco, coco.loadRes(dt), 'bbox')
        evaluation.params.areaRng = [list(evaluate.AREAS[a]) for a in ('all', 'small', 'medium', 'large')]
        evaluation.evaluate()
        evaluation.accumulate()
        evaluation.summarize()
        ours = evaluate.summary_metrics(evaluate.evaluate(images, detections, [PERSON, CAR]))
        self.assertAlmostEqual(ours['map'], evaluation.stats[0], places=6)
        self.assertAlmostEqual(ours['map50'], evaluation.stats[1], places=6)
        self.assertAlmostEqual(ours['ap_small'], evaluation.stats[3], places=6)
        self.assertAlmostEqual(ours['ap_medium'], evaluation.stats[4], places=6)
        self.assertAlmostEqual(ours['ap_large'], evaluation.stats[5], places=6)


class TestTestSet(unittest.TestCase):
    def test_masks_round_trip(self):
        mask = np.random.default_rng(3).random((17, 9)) > 0.5
        for m in (mask, ~mask):
            encoded = {'size': list(m.shape), 'counts': propose_labels.rle_encode(m)}
            np.testing.assert_array_equal(make_small_objects.rle_decode(encoded), m)

    def test_label_policy(self):
        detections = [
            {'category_id': PERSON, 'score': 0.9, 'box': [0, 0, 300, 400]},     # an object to find
            {'category_id': PERSON, 'score': 0.5, 'box': [400, 0, 600, 400]},   # unsure: crowd
            {'category_id': CAR, 'score': 0.9, 'box': [700, 700, 720, 715]},    # too small: crowd
            {'category_id': 17, 'score': 0.9, 'box': [0, 0, 100, 100]},         # a cat: ignored
            {'category_id': CAR, 'score': 0.35, 'box': [0, 0, 100, 100]},       # not sure at all: ignored
        ]
        annotations = propose_labels.to_annotations(detections, 1024, 768)
        self.assertEqual([(a['category_id'], a['iscrowd']) for a in annotations], [(PERSON, 0), (CAR, 1), (PERSON, 1)])


if __name__ == '__main__':
    unittest.main()
