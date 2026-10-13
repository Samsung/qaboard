"""
QA-Board runs this file: `qa --config fp32 --config size-320 run --input slices/outdoor` calls run(context).

A run evaluates one variant of the K3's object detector on one slice of the test set (a folder of images and their
labels.json): it detects objects in every image, matches them to the labels, and saves the images with their boxes,
precision-recall curves, an HTML report and the metrics.
- configurations choose the variant: `fp32` or `int8`, and the input size `size-320`, `size-416` or `size-512`,
- the code's flags come from build/flags.json (what a commit changed), tuning parameters override them.
"""
import json
import os
import statistics
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import draw  # noqa: E402
import evaluate  # noqa: E402
import models  # noqa: E402
import plots  # noqa: E402
import report  # noqa: E402
from detector import CLASSES, Detector  # noqa: E402
from fetch_inputs import ensure_inputs  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
INPUTS = ROOT / 'inputs'

# The code's defaults: the head of `main` at T0. A commit's changes are in build/flags.json.
DEFAULT_FLAGS = {
    'model_version': '1.3',              # the release the code builds, shown on runs' model badge
    'quant_calibration': 'percentile',   # minmax, percentile, entropy
    'quant_percentile': 99.999,          # 99.9-99.999, for percentile calibration
    'quant_per_channel': True,           # int8 weights per output channel, or one scale per tensor
    'quant_keep_fp32': 'first-conv',     # none, first-conv, head, first-conv+head: nodes left in fp32
    'score_threshold': 0.2,              # 0.05-0.6: detections kept above this score
    'nms_iou': 0.7,                      # 0.3-0.8: per-class non-maximum suppression
    'eval_crowd_many': True,             # false: the evaluation bug the story fixes (a crowd box absorbs one detection)
    'bug_qdq_se_gate': False,            # true: the int8 model's squeeze-excite gates feed Mul in uint8 (fails to load)
}
WARMUP = 5
THREADS = int(os.environ.get('DETECTOR_THREADS', 4))
METRIC_NAMES = {class_id: 'ap_' + name.replace(' ', '_') for class_id, name in CLASSES.items()}

# The first time qa imports this file, it downloads the photos and builds the small-objects composites in inputs/
ensure_inputs(INPUTS)


def read_flags(params):
    flags = dict(DEFAULT_FLAGS)
    path = ROOT / 'build' / 'flags.json'
    if path.exists():
        flags.update({k: v for k, v in json.loads(path.read_text()).items() if v is not None})
    flags.update({k: v for k, v in params.items() if k in DEFAULT_FLAGS})   # tuning parameters
    return flags


def variant(configs):
    """('fp32' or 'int8', input size) from the run's configurations"""
    names = [c for c in configs if isinstance(c, str)]
    kind = 'int8' if 'int8' in names else 'fp32'
    size = next((int(c.split('-', 1)[1]) for c in names if c.startswith('size-')), 320)
    return kind, size


def load_slice(folder):
    """A slice's images and labels (COCO format, boxes as [x1, y1, x2, y2])"""
    coco = json.loads((folder / 'labels.json').read_text())
    by_image = {}
    for a in coco['annotations']:
        x, y, w, h = a['bbox']
        by_image.setdefault(a['image_id'], []).append({'category_id': a['category_id'], 'box': [x, y, x + w, y + h], 'iscrowd': a.get('iscrowd', 0)})
    return [{**image, 'path': folder / image['file_name'], 'labels': by_image.get(image['id'], [])} for image in coco['images']]


def calibration_images():
    return sorted((INPUTS / 'slices' / 'calib').glob('*.jpg'))


def run(context):
    flags = read_flags(context.params)
    kind, size = variant(context.configs)
    output_dir = context.output_dir
    images = load_slice(context.input_path)
    name = context.rel_input_path.as_posix().split('/')[-1]
    model_id = f"kd-{flags['model_version']}-{kind}-{size}"
    print(f'{name}: {len(images)} images, {sum(1 for i in images for a in i["labels"] if not a["iscrowd"])} labeled objects')
    print(f'{model_id}: score > {flags["score_threshold"]}, NMS IoU {flags["nms_iou"]}, {THREADS} threads')

    if kind == 'int8':
        model_path, anchors = models.int8(size, flags, calibration_images())
    else:
        model_path, anchors = models.fp32(size)
    # int8: detections from the quantized model's reference arithmetic, the same on every CI runner (detector.session)
    detector = Detector(model_path, anchors, size, threads=THREADS, quantized=kind == 'int8')   # ONNX Runtime refuses broken models here

    pictures = [Image.open(i['path']).convert('RGB') for i in images]
    seconds = detector.latency(pictures, warmup=WARMUP)
    detections = {}
    for image, picture in zip(images, pictures):
        found = detector.detect(picture, flags['score_threshold'], flags['nms_iou'])
        detections[image['id']] = [{'category_id': c, 'score': s, 'box': b} for c, s, b in found]

    results = evaluate.evaluate(images, detections, list(CLASSES), crowd_many=flags['eval_crowd_many'])
    metrics = evaluate.summary_metrics(results)
    metrics.update({METRIC_NAMES[c]: results['ap'].get(c) for c in CLASSES})
    latency = {'median_ms': statistics.median(seconds) * 1000, 'p90_ms': sorted(seconds)[int(0.9 * (len(seconds) - 1))] * 1000,
               'images': len(seconds), 'warmup': WARMUP, 'threads': THREADS}
    metrics['latency_ms'] = latency['median_ms']
    metrics['model_mb'] = models.size_mb(model_path)

    # Outputs: images with boxes, plots, the report, raw detections
    (output_dir / 'images').mkdir(exist_ok=True)
    missed_counts = []
    for n, (image, picture) in enumerate(zip(images, pictures), start=1):
        missed = evaluate.missed_labels(image['labels'], detections[image['id']])
        draw.draw_detections(picture, image['labels'], detections[image['id']], missed, output_dir / 'images' / f'{n}.jpg')
        labeled = sum(1 for a in image['labels'] if not a['iscrowd'])
        missed_counts.append((len(missed), -labeled, n, image['file_name'], labeled))
    worst = [(n, file, m, labeled) for m, _, n, file, labeled in sorted(missed_counts, key=lambda t: (-t[0], t[1], t[2]))[:6] if m]
    title = f'{name}, {model_id}'
    plots.precision_recall(output_dir / 'pr.plotly.json', results['curves'], results['ap50'], f'{title}: precision-recall at IoU 0.5')
    counts = evaluate.counts(images)
    plots.recall_by_size(output_dir / 'size_recall.plotly.json',
                         {s: metrics[f'recall_{s}'] for s in ('small', 'medium', 'large') if metrics[f'recall_{s}'] is not None},
                         counts['by_size'], f'{title}: recall by object size')
    labels, matrix = evaluate.confusion_matrix(images, detections)
    plots.confusions(output_dir / 'confusion.plotly.json', matrix, labels, f'{title}: confusions at IoU 0.5')
    report.write(output_dir / 'report.html', f'{name}: {model_id}',
                 f"{len(images)} images, score > {flags['score_threshold']}, NMS IoU {flags['nms_iou']}, model {metrics['model_mb']:.1f} MB",
                 metrics, results, counts, worst, latency)
    (output_dir / 'detections.json').write_text(json.dumps(
        {image['file_name']: [{**d, 'box': [round(v, 1) for v in d['box']], 'score': round(d['score'], 4)} for d in detections[image['id']]]
         for image in images}, indent=1))

    shown = ['map', 'map50', 'ap_small', 'recall_small', 'latency_ms', 'model_mb']
    print(' | '.join(f'{k} {metrics[k]:.4g}' for k in shown if metrics.get(k) is not None))
    return {
        **metrics,
        'is_failed': False,
        'params': {
            'model': model_id,
            'badges': [{'text': f"Model card kd-{flags['model_version']}", 'icon': 'id-number',
                        'href': f"https://models.kitefin.example/detector/kd-{flags['model_version']}#{kind}-{size}"}],
        },
    }
