"""
The K3 detector at inference time: SSDlite (MobileNetV3) in ONNX Runtime, with its pre- and post-processing in numpy.

The ONNX model (qa/models.py) is the network only: it takes a 1x3xSxS image in [-1, 1] and returns, for each of its
anchors, 4 box deltas and 91 class logits (COCO's ids, 0 is the background). Everything else happens here, the same
for every variant: resize, normalization, box decoding against the anchors, score threshold, per-class NMS.
"""
import math
import os
import time

import numpy as np
from PIL import Image

# The classes the K3 cares about, by COCO id. The model's other classes are ignored.
CLASSES = {
    1: 'person', 2: 'bicycle', 3: 'car', 8: 'truck', 62: 'chair', 44: 'bottle', 27: 'backpack', 64: 'potted plant',
}
CLASS_IDS = list(CLASSES)
BOX_WEIGHTS = (10.0, 10.0, 5.0, 5.0)    # torchvision's SSD box coder
MAX_LOG_SCALE = math.log(1000.0 / 16)
TOPK_CANDIDATES = 300                    # per class, before NMS
MAX_DETECTIONS = 300                     # per image


def preprocess(image: Image.Image, size: int) -> np.ndarray:
    """RGB image -> 1x3xSxS float32 in [-1, 1], like torchvision's SSDlite transform (fixed size, no aspect ratio)"""
    resized = image.convert('RGB').resize((size, size), Image.Resampling.BILINEAR)
    x = np.asarray(resized, dtype=np.float32) / 255.0
    x = (x - 0.5) / 0.5
    return np.ascontiguousarray(x.transpose(2, 0, 1)[None])


def decode_boxes(deltas: np.ndarray, anchors: np.ndarray) -> np.ndarray:
    """Box deltas (A, 4) against anchors (A, 4, x1 y1 x2 y2) -> boxes (A, 4, x1 y1 x2 y2)"""
    widths = anchors[:, 2] - anchors[:, 0]
    heights = anchors[:, 3] - anchors[:, 1]
    ctr_x = anchors[:, 0] + 0.5 * widths
    ctr_y = anchors[:, 1] + 0.5 * heights
    wx, wy, ww, wh = BOX_WEIGHTS
    dx, dy = deltas[:, 0] / wx, deltas[:, 1] / wy
    dw = np.minimum(deltas[:, 2] / ww, MAX_LOG_SCALE)
    dh = np.minimum(deltas[:, 3] / wh, MAX_LOG_SCALE)
    cx, cy = dx * widths + ctr_x, dy * heights + ctr_y
    w, h = np.exp(dw) * widths, np.exp(dh) * heights
    return np.stack([cx - 0.5 * w, cy - 0.5 * h, cx + 0.5 * w, cy + 0.5 * h], axis=1)


def softmax(logits: np.ndarray) -> np.ndarray:
    z = logits - logits.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def box_iou(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """IoU of boxes (N, 4) with boxes (M, 4) -> (N, M)"""
    area_a = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1])
    area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    lt = np.maximum(a[:, None, :2], b[None, :, :2])
    rb = np.minimum(a[:, None, 2:], b[None, :, 2:])
    wh = np.clip(rb - lt, 0, None)
    inter = wh[..., 0] * wh[..., 1]
    union = area_a[:, None] + area_b[None, :] - inter
    return np.where(union > 0, inter / np.maximum(union, 1e-12), 0.0)


def nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float) -> np.ndarray:
    """Greedy non-maximum suppression; returns the kept indices, by decreasing score"""
    order = np.argsort(-scores, kind='stable')
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        if order.size == 1:
            break
        ious = box_iou(boxes[i:i + 1], boxes[order[1:]])[0]
        order = order[1:][ious <= iou_threshold]
    return np.array(keep, dtype=np.int64)


def postprocess(deltas, logits, anchors, size, image_size, score_threshold, nms_iou):
    """Raw outputs for one image -> detections [(class_id, score, [x1, y1, x2, y2] in the image's pixels)]"""
    boxes = decode_boxes(deltas.astype(np.float64), anchors.astype(np.float64))
    boxes = np.clip(boxes, 0, size)
    scores = softmax(logits)
    width, height = image_size
    scale = np.array([width / size, height / size, width / size, height / size])
    candidates = []
    for class_id in CLASS_IDS:
        s = scores[:, class_id]
        idx = np.nonzero(s > score_threshold)[0]
        if not idx.size:
            continue
        idx = idx[np.argsort(-s[idx], kind='stable')[:TOPK_CANDIDATES]]
        kept = idx[nms(boxes[idx], s[idx], nms_iou)]
        candidates.extend((class_id, float(s[i]), boxes[i] * scale) for i in kept)
    candidates.sort(key=lambda d: -d[1])
    return [(c, s, [float(v) for v in b]) for c, s, b in candidates[:MAX_DETECTIONS]]


def session(model_path, threads=4, reference=False):
    """
    An ONNX Runtime session on the CPU. ONNX Runtime refuses broken models here.

    With `reference`, a quantized (QDQ) model computes what its graph says: each QuantizeLinear rounds and clips in
    float, each DequantizeLinear scales back, and the operators between them run in fp32. The outputs are the same, bit
    for bit, on x86-64 CPUs with FMA (AVX2 or AVX-512: CI runners, PCs since 2013). By default, ONNX Runtime fuses the
    QuantizeLinear/DequantizeLinear pairs around an operator into an int8 kernel (QLinearConv...), which it picks for
    the CPU (AVX2, AVX-512 VNNI, AMX...). Those kernels round and saturate differently: on another CPU, an int8 model's
    mAP on a slice moved by a fifth. The extended optimizations keep the plain fp32 kernels, not the NCHWc ones, which
    ONNX Runtime lays out for the CPU's vector width.
    """
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.log_severity_level = 3
    if reference:
        options.add_session_config_entry('session.disable_quant_qdq', '1')
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    return ort.InferenceSession(str(model_path), options, providers=['CPUExecutionProvider'])


class Detector:
    """
    ONNX Runtime sessions for one model file, at one input size. A quantized model's detections come from its
    reference arithmetic (see session()), the same on CPUs with FMA; its latency is that of ONNX Runtime's int8
    kernels on this CPU, what a CPU deployment would run.
    """

    def __init__(self, model_path, anchors_path, size, threads=4, quantized=False):
        self.session = session(model_path, threads, reference=quantized)
        self.timed = session(model_path, threads) if quantized else self.session
        self.anchors = np.load(anchors_path)
        self.size = size
        self.input_name = self.session.get_inputs()[0].name

    def latency(self, images, warmup=5):
        """Seconds per image (PIL images) of the deployed model, after `warmup` runs, without pre- and post-processing"""
        inputs = [preprocess(image, self.size) for image in images]
        for _ in range(warmup):
            self.timed.run(None, {self.input_name: inputs[0]})
        seconds = []
        for x in inputs:
            start = time.perf_counter()
            self.timed.run(None, {self.input_name: x})
            seconds.append(time.perf_counter() - start)
        return seconds

    def infer(self, image):
        """-> (deltas, logits) for a PIL image"""
        deltas, logits = self.session.run(None, {self.input_name: preprocess(image, self.size)})
        return deltas[0], logits[0]

    def detect(self, image, score_threshold, nms_iou):
        deltas, logits = self.infer(image)
        return postprocess(deltas, logits, self.anchors, self.size, image.size, score_threshold, nms_iou)


def default_threads():
    return int(os.environ.get('DETECTOR_THREADS', 4))
