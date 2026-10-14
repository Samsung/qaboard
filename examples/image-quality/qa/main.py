"""
QA-Board runs this file: `qa run --input charts/slanted-edge.png` calls run(context).

It simulates the K3 camera on the input (the "scene"), runs the ISP on the raw image, saves the output and each stage,
and measures the result against the scene it started from. Videos (clips/*.yaml) do the same on every frame.
- configurations (`--config base|low-light|night`) set the ISO,
- the code's flags come from build/flags.json (what a commit changed), tuning parameters override them,
- the `hw-model` platform runs the fixed-point model of the camera chip instead of the float pipeline.
"""
import json
import os
import time
from pathlib import Path

import numpy as np
import yaml
from PIL import Image

import camera
import isp
import isp_fxp
import measures
import plots
from make_charts import ensure_charts
from fetch_photos import ensure_photos

ROOT = Path(__file__).resolve().parent.parent

# The code's defaults: the head of `main`. A commit's changes are in build/flags.json.
DEFAULT_FLAGS = {
    'demosaic': 'hamilton-adams',        # or bilinear
    'denoise': 'bilateral',              # or gaussian
    'denoise_strength': 1.6,             # 0.5-3.0
    'detail_boost': 1.5,                 # sharpening, 1.0-2.0
    'sharpen_clamp': 'local-contrast',   # or none
    'tone_curve': 'filmic',              # or gamma
    'tile_size': 512,                    # tiles for big images, 0: the whole frame at once
    'fxp_rounding': 'half-even',         # hw-model: or truncate, half-up
    'fxp_bilateral_guard_bits': 2,       # hw-model: 0-4
    'chroma_denoise_low_light': False,   # an extra chroma denoise pass when the gain is 16x or more
}

# The first time qa imports this file, it downloads the photos and generates the charts in inputs/
ensure_photos(ROOT / 'inputs')
ensure_charts(ROOT / 'inputs')


def read_flags(params):
    flags = dict(DEFAULT_FLAGS)
    path = ROOT / 'build' / 'flags.json'
    if path.exists():
        flags.update({k: v for k, v in json.loads(path.read_text()).items() if v is not None})
    flags.update({k: v for k, v in params.items() if k in DEFAULT_FLAGS})   # tuning parameters
    return flags


def metadata(absolute_input_path, database, input_path):
    """Input metadata: ROI presets for the image viewer, and the regions charts are measured in."""
    path = absolute_input_path.with_suffix('.metadata.yaml')
    return yaml.safe_load(path.read_text()) if path.exists() else {}


def run(context):
    start = time.time()
    flags = read_flags(context.params)
    config = next((c for c in context.configs if isinstance(c, str)), 'base')
    seed_key = f"{os.environ.get('QA_SEED', 0)}:{context.rel_input_path.as_posix()}"   # the noise depends on the input
    output_dir = context.output_dir

    if context.input_path.suffix == '.tiff':   # the 113 MP test wall
        import deep_zoom
        return deep_zoom.run(context.input_path, output_dir, config, flags, seed_key, start)
    if context.input_path.suffix == '.yaml':   # a video: clips/<name>.yaml
        import video
        metrics = video.run(context.input_path, ROOT / context.database, output_dir, config, flags, seed_key)
        return {**metrics, 'runtime': time.time() - start, 'is_failed': False}

    scene = np.asarray(Image.open(context.input_path).convert('RGB'))
    raw = camera.capture(scene, config, seed_key)
    print(f'K3 camera: {context.rel_input_path}, {scene.shape[1]}x{scene.shape[0]}, ISO {raw.iso} (gain {raw.gain}x)')
    print(f"ISP ({context.platform}): {flags['demosaic']} demosaic, {flags['denoise']} denoise x{flags['denoise_strength']}, "
          f"sharpen x{flags['detail_boost']} (clamp: {flags['sharpen_clamp']}), {flags['tone_curve']} tone curve")

    metrics = {}
    (output_dir / 'stages').mkdir()
    if context.platform == 'hw-model':
        stages, buffers, registers = isp_fxp.process(raw.mosaic, raw.gain, flags)
        (output_dir / 'raw').mkdir()
        for stage, buffer in buffers.items():   # a 256x256 window of each stage's 16-bit buffer
            buffer.astype('<u2').tofile(output_dir / 'raw' / f'{stage}.u16')
        (output_dir / 'regs.txt').write_text(registers.text())
        metrics['fxp_psnr'] = measures.psnr(stages[5], isp.process(raw.mosaic, raw.gain, flags, all_stages=False)[5])
        Image.fromarray(stages[5]).save(output_dir / 'out.png')
        x, y, w, h = registers['DUMP_WINDOW']
        for stage in (1, 2, 3, 4, 5):   # the window of raw/*.u16, lossless, to be compared bit for bit
            Image.fromarray(stages[stage][y:y + h, x:x + w]).save(output_dir / 'stages' / f'{stage}.png')
    else:
        stages = isp.process(raw.mosaic, raw.gain, flags, log=print)
        Image.fromarray(stages[5]).save(output_dir / 'out.png')   # lossless, for Image Diff
        for stage in (1, 2, 3, 4, 5):
            Image.fromarray(stages[stage]).save(output_dir / 'stages' / f'{stage}.jpg', quality=85, optimize=True)

    # The ideal output: the scene, without blur or noise, through the same tone curve
    reference = isp.display(isp.tone_curve(camera.SRGB_TO_LINEAR[scene] / 65535, flags['tone_curve']))
    output = stages[5]
    metrics['psnr'] = measures.psnr(output, reference)
    metrics['ssim'] = measures.ssim(output, reference)
    measure = context.input_metadata.get('measure', {})
    if 'edge' in measure:
        edge = measures.slanted_edge(output, measure['edge'])
        metrics.update(mtf50=edge['mtf50'], overshoot=edge['overshoot'])
        plots.edge_profile(output_dir / 'edge.plotly.json', edge)
        plots.mtf(output_dir / 'mtf.plotly.json', edge)
    if 'patches' in measure:
        patches = measure['patches']
        stats = [measures.patch_stats(output, p) for p in patches]
        expected = np.array([measures.patch_stats(reference, p)[0][:3] for p in patches])
        delta_e = measures.delta_e2000(measures.srgb_to_lab(np.array([s[0][:3] for s in stats])), measures.srgb_to_lab(expected))
        metrics['delta_e'] = float(np.mean(delta_e))
        grays = [i for i, p in enumerate(patches) if p['name'] in ('white', 'black') or p['name'].startswith('neutral')]
        metrics['noise_flat'] = float(np.mean([stats[i][1][3] for i in grays]))
        plots.color_errors(output_dir / 'color.plotly.json', [p['name'] for p in patches], [p['srgb'] for p in patches], delta_e)
        plots.noise_vs_signal(output_dir / 'noise.plotly.json', np.array([stats[i][0] for i in grays]), np.array([stats[i][1] for i in grays]))
    if 'flat' in measure:
        metrics['noise_flat'] = float(measures.patch_stats(output, measure['flat'], inset=0)[1][3])

    metrics['runtime'] = time.time() - start
    print(' | '.join(f'{k} {v:.4g}' for k, v in metrics.items()))
    return {**metrics, 'is_failed': False}
