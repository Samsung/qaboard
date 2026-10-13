"""
Prepares what the runs need, like a CI job's build step: the photos and composites in inputs/, the model's weights,
and its ONNX export at each input size (models/, or $DETECTOR_MODELS_DIR). Everything is cached: a second build does
nothing. Runs do it themselves when it's missing; docs-media/seed.py calls this once before a story.

    python qa/build.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import models  # noqa: E402
from fetch_inputs import ensure_inputs  # noqa: E402

SIZES = (320, 416, 512)

if __name__ == '__main__':
    if not ensure_inputs(models.ROOT / 'inputs'):
        raise SystemExit('ERROR: could not get the inputs')
    for size in SIZES:
        model, _ = models.fp32(size)
        print(f'{model.name}: {models.size_mb(model):.1f} MB')
