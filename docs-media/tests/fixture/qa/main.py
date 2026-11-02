"""
The seeder's test project: a fake image pipeline whose results depend on its flags (build/flags.json).
Standard library only. Inputs are text files in inputs/.
"""
import os
import json
import time
import zlib
import struct
import hashlib
from pathlib import Path


def flags():
  path = Path('build/flags.json')
  return json.loads(path.read_text()) if path.exists() else {}


def uniform(*parts) -> float:
  """A deterministic number in [0, 1)"""
  return int(hashlib.sha256(':'.join(map(str, parts)).encode()).hexdigest()[:8], 16) / 2**32


def write_png(path: Path, width: int, height: int, pixel):
  """8-bit grayscale PNG"""
  rows = b''.join(b'\x00' + bytes(pixel(x, y) for x in range(width)) for y in range(height))
  def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
  header = struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0)
  path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def run(context):
  start = time.time()
  f = {**flags(), **context.params}
  seed = os.environ.get('QA_SEED', '0')
  name = context.input_path.stem
  low_light = 'low-light' in context.configs
  print(f"Processing {context.input_path.name} ({', '.join(map(str, context.configs))}) with {json.dumps(f, sort_keys=True)}")

  if f.get('bug_crash') and name.startswith('b-'):
    raise IndexError("median filter: index out of bounds at the frame's edge")
  if f.get('whole_frame') and name.startswith('big-'):
    buffers = []
    for i in range(40):  # up to 2 GB, unless the seeder kills us before
      buffers.append(b'\x01' * (50 * 2**20))
      print(f"whole frame: {50 * (i + 1)} MB", flush=True)
      time.sleep(0.1)
  if f.get('slow'):
    print("waiting for the frame lock...", flush=True)
    time.sleep(30)
  # runs take a little time, like real ones: the seeder can stop a batch while they run
  time.sleep(1)

  gain = float(f.get('gain', 1.0))
  strength = float(f.get('strength', 1.0))
  noise = (4.0 if low_light else 1.5) / (1 + strength) * (1.3 if f.get('denoise', 'box') == 'box' else 1.0)
  noise += 0.1 * uniform(seed, name, low_light)
  score = 10 * gain * (0.8 if low_light else 1.0) - noise + 0.2 * uniform(seed, name, 'score')
  level = min(255, int(100 * gain))
  write_png(context.output_dir / 'out.png', 96, 64, lambda x, y: (level + x + int(noise * y)) % 256)
  (context.output_dir / 'report.txt').write_text(f"gain={gain}\nstrength={strength}\n")
  return {
    'score': round(score, 4),
    'noise': round(noise, 4),
    'runtime': round(time.time() - start, 3),
    'is_failed': False,
  }
