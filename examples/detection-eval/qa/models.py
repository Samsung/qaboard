"""
The model files, built once and cached in models/ (or $DETECTOR_MODELS_DIR):

- the weights: torchvision's SSDlite320 MobileNetV3-Large COCO weights, downloaded and checked by SHA-256 (see
  inputs.lock.yaml), always from download.pytorch.org: their terms come with the data they were trained on, so we
  don't republish them.
- fp32-<size>.onnx and anchors-<size>.npy: exported by qa/export_onnx.py (PyTorch for CPU), once per input size.
- calib-<size>-<method>-<hash>.pkl: activation statistics of the fp32 model on the `calib` slice (min/max, or
  histograms for the percentile and entropy methods), collected once per input size and method.
- int8-<size>-<hash>.onnx: quantized with ONNX Runtime from the fp32 model, those statistics and the quantization
  flags. The hash covers everything that changes the result, so each set of flags is quantized once.

Builds take a file lock: runs started in parallel wait for the first one.
"""
import contextlib
import fcntl
import hashlib
import io
import json
import os
import pickle
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / 'inputs.lock.yaml'
USER_AGENT = 'QA-Board-docs-demo/1.0 (https://github.com/Samsung/qaboard)'
QUANT_FLAGS = ('quant_calibration', 'quant_percentile', 'quant_per_channel', 'quant_keep_fp32', 'bug_qdq_se_gate')
CALIBRATION_CHUNK = 8   # images per inference pass: the calibration keeps every activation of a chunk in memory


def models_dir() -> Path:
    path = Path(os.environ.get('DETECTOR_MODELS_DIR', ROOT / 'models'))
    path.mkdir(parents=True, exist_ok=True)
    return path


@contextlib.contextmanager
def locked(name):
    with open(models_dir() / f'.{name}.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def short_hash(data) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:12]


def download(url, path, sha256):
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    tmp = path.with_name(path.name + '.tmp')
    with urllib.request.urlopen(request, timeout=300) as response, open(tmp, 'wb') as f:
        shutil.copyfileobj(response, f)
    actual = sha256_file(tmp)
    if actual != sha256:
        tmp.unlink()
        raise ValueError(f'SHA-256 {actual[:12]}..., expected {sha256[:12]}...')
    tmp.replace(path)


def weights(log=print) -> Path:
    """The pretrained weights (.pth), from download.pytorch.org, checked by SHA-256"""
    lock = yaml.safe_load(LOCK.read_text())
    entry = lock['weights']
    path = models_dir() / Path(entry['url']).name
    if path.exists():
        return path
    with locked('weights'):
        if path.exists():
            return path
        sources = [entry['url']]
        problems = []
        for url in sources:
            try:
                download(url, path, entry['sha256'])
                log(f'Downloaded the weights from {url}')
                return path
            except Exception as e:
                problems.append(f'{url}: {e}')
        raise SystemExit(f"ERROR: could not download the model's weights ({'; '.join(problems)})")


def export_command():
    """qa/export_onnx.py with uv (it installs PyTorch for CPU from the script's metadata), or else with this Python
    if it has PyTorch"""
    script = str(ROOT / 'qa' / 'export_onnx.py')
    if shutil.which('uv'):
        return ['uv', 'run', '--quiet', '--script', script]
    try:
        import torch  # noqa: F401
        import torchvision  # noqa: F401
    except ImportError:
        raise SystemExit('ERROR: exporting the model needs uv (https://docs.astral.sh/uv/), or torch and torchvision in this Python')
    return [sys.executable, script]


def fp32(size, log=print):
    """(model, anchors) paths of the fp32 model at this input size"""
    model, anchors = models_dir() / f'fp32-{size}.onnx', models_dir() / f'anchors-{size}.npy'
    if model.exists() and anchors.exists():
        return model, anchors
    pth = weights(log)
    with locked('export'):
        if not (model.exists() and anchors.exists()):
            log(f'Exporting the model to ONNX at {size}x{size} (qa/export_onnx.py)')
            start = time.time()
            subprocess.run([*export_command(), '--weights', str(pth), '--out', str(models_dir()), '--size', str(size)], check=True)
            log(f'  done in {time.time() - start:.0f}s')
    return model, anchors


def quant_settings(flags):
    """The flags the int8 model depends on (the percentile only for percentile calibration)"""
    settings = {k: flags[k] for k in QUANT_FLAGS if flags.get(k) is not None}
    if settings.get('quant_calibration', 'percentile') != 'percentile':
        settings.pop('quant_percentile', None)
    if not settings.get('bug_qdq_se_gate'):
        settings.pop('bug_qdq_se_gate', None)
    return settings


def int8(size, flags, calibration_images, log=print):
    """(model, anchors) paths of the int8 model for these quantization flags"""
    import onnxruntime
    fp32_model, anchors = fp32(size, log)
    settings = quant_settings(flags)
    key = short_hash({'settings': settings, 'size': size, 'fp32': sha256_file(fp32_model), 'onnxruntime': onnxruntime.__version__,
                      'calibration': [sha256_file(p) for p in calibration_images]})
    model = models_dir() / f'int8-{size}-{key}.onnx'
    if model.exists():
        return model, anchors
    with locked(f'int8-{key}'):
        if not model.exists():
            start = time.time()
            describe = ', '.join(f'{k.replace("quant_", "")} {v}' for k, v in settings.items())
            log(f'Quantizing to int8 at {size}x{size}: {describe}')
            quantize(fp32_model, model, size, settings, calibration_images, log)
            log(f'  done in {time.time() - start:.0f}s')
    return model, anchors


def excluded_nodes(model, keep_fp32):
    """The nodes that stay in fp32: the first convolution, the detection head, or both"""
    keep = set((keep_fp32 or 'none').split('+')) - {'none'}
    names = []
    if 'first-conv' in keep:
        names.append(next(n.name for n in model.graph.node if n.op_type == 'Conv'))
    if 'head' in keep:
        names += [n.name for n in model.graph.node if n.name.startswith('/head/')]
    return names


def calibration_statistics(fp32_model, size, method, images, log=print):
    """Activation statistics of the fp32 model on the calibration images, cached: min/max (TensorsData) for minmax,
    else ONNX Runtime's histogram collector, from which percentile and entropy ranges are computed"""
    import onnxruntime
    from onnxruntime.quantization import CalibrationDataReader, CalibrationMethod
    from onnxruntime.quantization.calibrate import create_calibrator
    from PIL import Image

    from detector import preprocess

    family = 'minmax' if method == 'minmax' else method
    key = short_hash({'fp32': sha256_file(fp32_model), 'method': family, 'images': [sha256_file(p) for p in images],
                      'onnxruntime': onnxruntime.__version__})
    path = models_dir() / f'calib-{size}-{family}-{key}.pkl'
    if path.exists():
        return pickle.loads(path.read_bytes())
    with locked(f'calib-{key}'):
        if path.exists():
            return pickle.loads(path.read_bytes())

        class Reader(CalibrationDataReader):
            def __init__(self, paths):
                self.paths = iter(paths)

            def get_next(self):
                p = next(self.paths, None)
                if p is None:
                    return None
                with Image.open(p) as image:
                    return {'image': preprocess(image, size)}

        log(f'Calibrating ({family}) on {len(images)} images of the calib slice')
        start = time.time()
        calibrate_method = {'minmax': CalibrationMethod.MinMax, 'percentile': CalibrationMethod.Percentile,
                            'entropy': CalibrationMethod.Entropy}[family]
        with tempfile.TemporaryDirectory(prefix='calib-') as tmp, contextlib.redirect_stdout(io.StringIO()):
            calibrator = create_calibrator(
                Path(fp32_model), None, augmented_model_path=str(Path(tmp) / 'augmented.onnx'),
                calibrate_method=calibrate_method,
            )
            for i in range(0, len(images), CALIBRATION_CHUNK):
                calibrator.collect_data(Reader(images[i:i + CALIBRATION_CHUNK]))
            statistics = calibrator.compute_data() if family == 'minmax' else calibrator.collector
            del calibrator
        tmp_path = path.with_name(path.name + '.tmp')
        tmp_path.write_bytes(pickle.dumps(statistics))
        tmp_path.replace(path)
        log(f'  done in {time.time() - start:.0f}s')
        return statistics


def tensor_ranges(statistics, settings):
    """The activations' quantization ranges for the calibration method and its settings"""
    from onnxruntime.quantization import CalibrationMethod
    from onnxruntime.quantization.calibrate import TensorsData
    method = settings.get('quant_calibration', 'percentile')
    if method == 'minmax':
        return statistics
    collector = statistics
    with contextlib.redirect_stdout(io.StringIO()):
        if method == 'percentile':
            collector.percentile = float(settings.get('quant_percentile', 99.999))
            return TensorsData(CalibrationMethod.Percentile, collector.compute_collection_result())
        return TensorsData(CalibrationMethod.Entropy, collector.compute_collection_result())


def quantize(fp32_model, out, size, settings, calibration_images, log=print):
    """Static int8 quantization (QDQ: uint8 activations, int8 weights) with ONNX Runtime"""
    import onnx
    from onnxruntime.quantization import QuantFormat, QuantType, quantize_static
    from onnxruntime.quantization.calibrate import save_tensors_data

    method = settings.get('quant_calibration', 'percentile')
    statistics = calibration_statistics(fp32_model, size, method, calibration_images, log)
    ranges = tensor_ranges(statistics, settings)
    model = onnx.load(str(fp32_model))
    with tempfile.TemporaryDirectory(prefix='quantize-') as tmp:
        cache = Path(tmp) / 'ranges.json'
        save_tensors_data(ranges, cache)
        result = Path(tmp) / 'int8.onnx'
        quantize_static(
            model, result, None,
            quant_format=QuantFormat.QDQ,
            per_channel=bool(settings.get('quant_per_channel', True)),
            activation_type=QuantType.QUInt8,
            weight_type=QuantType.QInt8,
            nodes_to_exclude=excluded_nodes(model, settings.get('quant_keep_fp32', 'none')),
            calibrate_method=ranges.calibration_method,
            calibration_cache_path=cache,
        )
        if settings.get('bug_qdq_se_gate'):
            feed_se_gates_in_int8(result)
        tmp_out = out.with_name(out.name + '.tmp')
        shutil.move(str(result), tmp_out)
        tmp_out.replace(out)


def feed_se_gates_in_int8(path):
    """
    The bug of the story's `qdq-se-gates` commit: saving a dequantization per squeeze-and-excite block by feeding the
    gate's quantized output straight to its Mul. ONNX Runtime refuses to load the model: Mul can't multiply a float
    tensor by a uint8 one.
    """
    import onnx
    model = onnx.load(str(path))
    producers = {o: n for n in model.graph.node for o in n.output}
    for mul in model.graph.node:
        if mul.op_type != 'Mul':
            continue
        for i, name in enumerate(mul.input):
            dq = producers.get(name)
            q = producers.get(dq.input[0]) if dq is not None and dq.op_type == 'DequantizeLinear' else None
            gate = producers.get(q.input[0]) if q is not None and q.op_type == 'QuantizeLinear' else None
            if gate is not None and gate.op_type == 'HardSigmoid':
                mul.input[i] = q.output[0]
    onnx.save(model, str(path))


def size_mb(path) -> float:
    return Path(path).stat().st_size / 1e6
