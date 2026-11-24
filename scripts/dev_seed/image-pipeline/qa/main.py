"""
A fake image pipeline, for the development server's data (scripts/dev.py seed): standard library only, a few ms a run.
Each input names a scene. The output image, profile and metrics depend on the scene, the configurations and the
commit's flags (build/flags.json, written by the seeder): `denoise` ("box" or "bilateral"), `strength`, `sharpen`.
"""
import json
import math
import time
import zlib
import struct
import hashlib
from pathlib import Path


def flags() -> dict:
  path = Path('build/flags.json')
  return json.loads(path.read_text()) if path.exists() else {}


def uniform(*parts) -> float:
  """A deterministic number in [0, 1)"""
  return int(hashlib.sha256(':'.join(map(str, parts)).encode()).hexdigest()[:8], 16) / 2**32


def write_png(path: Path, width: int, height: int, pixel):
  """8-bit RGB PNG"""
  rows = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(width)) for y in range(height))
  def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
  header = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
  path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


SCENES = {
  # base color, edge position, brightness
  'indoor': ((200, 160, 120), 0.45, 0.8),
  'outdoor': ((110, 170, 230), 0.6, 1.0),
  'night': ((40, 50, 90), 0.5, 0.35),
  'chart': ((128, 128, 128), 0.33, 0.9),
}


def run(context):
  start = time.time()
  f = {'denoise': 'box', 'strength': 1.0, 'sharpen': 0.5, **flags(), **context.params}
  scene = context.input_path.stem
  (r0, g0, b0), edge, brightness = SCENES.get(scene, ((128, 128, 128), 0.5, 0.7))
  low_light = 'low-light' in context.configs
  if low_light:
    brightness *= 0.5
  strength, sharpen = float(f['strength']), float(f['sharpen'])
  noise_level = (6.0 if low_light else 2.0) / (1 + strength) * (1.0 if f['denoise'] == 'bilateral' else 1.4)
  halo = 0.02 + 0.08 * sharpen * (0.5 if f['denoise'] == 'bilateral' else 1.0)
  print(f"{scene} ({', '.join(map(str, context.configs))}): denoise={f['denoise']} strength={strength} sharpen={sharpen}")

  width, height = 160, 100
  def value(x, y):
    """the row's intensity in [0, 1]: a step at the edge, with an overshoot (halo) and noise"""
    d = x / width - edge
    step = 1.0 if d > 0 else 0.3
    overshoot = halo * math.copysign(math.exp(-abs(d) * 60), d)
    return min(1.0, max(0.0, brightness * (step + overshoot) + noise_level / 255 * (uniform(scene, x, y, low_light) - 0.5) * 8))
  def pixel(x, y):
    v = value(x, y)
    return (int(r0 * v), int(g0 * v), int(b0 * v))
  write_png(context.output_dir / 'out.png', width, height, pixel)

  profile = [value(x, height // 2) for x in range(width)]
  (context.output_dir / 'profile.plotly.json').write_text(json.dumps({
    'data': [{'y': profile, 'type': 'scatter', 'mode': 'lines', 'name': 'row profile'}],
    'layout': {'title': f'{scene}: middle row', 'yaxis': {'range': [0, 1.1]}},
  }))
  psnr = 20 * math.log10(255 / max(0.1, noise_level)) - 10 * halo + 0.3 * uniform(scene, low_light, 'psnr')
  metrics = {
    'psnr': round(psnr, 3),
    'noise': round(noise_level, 3),
    'halo': round(halo, 4),
    'runtime': round(time.time() - start, 4),
  }
  (context.output_dir / 'report.txt').write_text(''.join(f"{k}: {v}\n" for k, v in {**f, **metrics}.items()))
  return metrics
