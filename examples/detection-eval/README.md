# Object detector: a QA-Board example

The object detector of a (fictional) robot, wrapped with QA-Board: `qa/main.py` runs torchvision's SSDlite
(MobileNetV3, COCO weights) with ONNX Runtime on the CPU, in fp32 or quantized to int8, at several input sizes, on
slices of a test set. Each run saves the images with their boxes, precision-recall curves, an HTML report, and COCO-style
metrics per class and per object size. [`SPEC.md`](SPEC.md) describes everything it computes; `story.yaml` is the six
weeks of history the QA-Board docs show: an int8 model that loses small objects, and is tuned back.

## Run it

```bash
pip install qaboard -r requirements.txt     # onnxruntime onnx numpy pillow pyyaml
cd examples/detection-eval

qa batch ci                                              # 4 slices, fp32 and int8 at 320 px (8 runs)
qa --config int8 --config size-320 run --input slices/small-objects
qa batch sizes                                           # fp32 and int8 at 320, 416 and 512 px (24 runs)
qa --share --label tune-int8 optimize --batch quant-search --config-file qa/tune-int8.yaml --checkpoint tune-int8.pkl
# (qa optimize reads each evaluation's results from a QA-Board server: start one first)
```

- The first time `qa` imports `qa/main.py`, it downloads the photos (`qa/fetch_inputs.py`, from a public mirror or
  their source, checked against `inputs.lock.yaml`) and builds the small-objects composites
  (`qa/make_small_objects.py`) in `inputs/`.
- The first run of each input size exports the model to ONNX (`qa/export_onnx.py`): it downloads the COCO weights
  (14 MB, checked by SHA-256) and runs PyTorch for CPU, installed by [uv](https://docs.astral.sh/uv/) from the
  script's metadata (about 200 MB, in uv's cache). Without uv, install `torch` and `torchvision` yourself. The models
  are cached in `models/` (`$DETECTOR_MODELS_DIR`).
- The first int8 run of a set of quantization flags calibrates the model on the `calib` slice (about 20 s), also cached.
- Without `--share` or a CI, results are saved in `output/`. To see them in QA-Board, start a server
  ([quickstart](https://samsung.github.io/qaboard/docs/get-started/quickstart)), and use `qa --share` or run in CI.

## How it's wired

| File | What it does |
|---|---|
| `qaboard.yaml` | Project name, inputs (each slice is a folder with its `labels.json`), visualizations, the quality gate |
| `qa/main.py` | `run(context)`: detects, evaluates, draws, plots, writes the report and returns the metrics |
| `qa/detector.py` | Pre- and post-processing in numpy (anchors, box decoding, score threshold, per-class NMS) and the ONNX Runtime session |
| `qa/models.py` | The model files: weights, ONNX export, calibration and int8 quantization (ONNX Runtime, QDQ), cached |
| `qa/evaluate.py` | COCO-style AP, AP by object size, recall, confusions |
| `qa/draw.py`, `qa/plots.py`, `qa/report.py` | Images with boxes, Plotly figures, the HTML report |
| `qa/metrics.yaml`, `qa/batches.yaml` | Metrics (labels, units, targets) and batches (`ci`, `sizes`, `quant-search`) |
| `qa/tune-int8.yaml` | The search space and objective of `qa optimize` |
| `qa/fetch_inputs.py`, `qa/make_small_objects.py`, `qa/propose_labels.py` | The test set: photos, composites, labels |

**Configurations** are the variant: `fp32` or `int8`, and `size-320`, `size-416` or `size-512`. **Flags** describe the
code's choices (quantization, thresholds, an evaluation fix): `qa/main.py` reads them from `build/flags.json`, over its
defaults, and tuning parameters override them:

```bash
echo '{"quant_calibration": "minmax", "quant_per_channel": false, "quant_keep_fp32": "none"}' > build/flags.json
qa --config int8 --config size-320 run --input slices/small-objects      # the first int8 model of the story
qa batch quant-search --tuning-search '{"search_type": "grid", "parameter_search": {"score_threshold": [0.2, 0.3], "nms_iou": [0.5, 0.7]}}'
```

**Determinism:** detections and metrics are the same from run to run, and on other x86-64 machines with AVX2 or
AVX-512 (any CI runner). The int8 model's detections come from its reference arithmetic: quantize and dequantize in
float, as its graph says, and fp32 in between (`qa/detector.py`). ONNX Runtime's int8 kernels, which it picks for the
CPU (AVX2, AVX-512 VNNI...), round and saturate differently: with them, a slice's mAP moved by a fifth between two
machines. Latency is measured with those kernels, so it varies.

## Inputs

The photos are CC0 or in the public domain, listed with their authors and sources in [`LICENSES.md`](LICENSES.md).
There is no well-known detection dataset under CC0, so the labels are machine-made: a much larger model
(torchvision's Faster R-CNN v2) proposed them, and nobody reviewed them. The detector is scored against what a better
model sees. The small-objects slice is made of people and cars cut out of the photos and pasted far away on empty
scenes: its labels are exact.

Object sizes are measured in the 320x320 frame the model sees: "small" is smaller than 64x64 px there, the detector's
smallest anchor box. SSDlite finds almost nothing smaller than COCO's 32x32 px at its input size.

To change the test set (maintainers): add photos to `inputs.lock.yaml` and `LICENSES.md`, then
`uv run qa/propose_labels.py slices/indoor` (labels), `uv run qa/propose_labels.py --donors` (the silhouettes of the
objects to paste) and `uv run qa/make_small_objects.py --plan` (a new recipe for the composites).
`uv run qa/fetch_inputs.py --upload` copies the photos to the mirror.
