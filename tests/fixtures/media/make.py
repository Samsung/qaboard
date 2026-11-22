"""
Writes the run folder in tests/fixtures/media/run/ with qaboard/media.py, and expected.json: what both readers make
of its index (read_media() in Python, parseMedia() in webapp/src/viewers/media/media.js). Run it again after changing
the format: `uv run python tests/fixtures/media/make.py`.
"""
import json
import shutil
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
sys.path.insert(0, str(here.parent.parent.parent))
import numpy  # noqa: E402
from qaboard import media  # noqa: E402

run = here / 'run'
shutil.rmtree(run, ignore_errors=True)
log = media.MediaLog(run)
t = 1731500000.0
gradient = numpy.linspace(0, 1, 8 * 6 * 3).reshape(8, 6, 3)
for step in (0, 10, 20):
  # the loader shuffles: the ids say which sample is which
  log.add('val/samples', step, [media.Image(gradient * (1 - step / 40), caption=f"sample {i}", id=f"img_{(i + step // 10) % 2}",
                                            boxes=[{'x': 1, 'y': 1, 'w': 3, 'h': 2, 'label': 'cat', 'score': 0.5 + i / 10}])
                                for i in range(2)], time=t + step)
  log.add('weights/fc1', step, media.Histogram(numpy.random.default_rng(step).normal(step / 10, 1, 500), bins=8), time=t + step)
log.add('tts/sample', 10, media.Audio(numpy.sin(numpy.linspace(0, 440 * 6.283, 800)) * 0.5, sample_rate=8000, caption='hello'), time=t + 10)
log.add('answers', 20, media.Text("The answer is 42."), time=t + 20)
log.add('report', 20, media.Html("<h1>Step 20</h1>"), time=t + 20)
log.add('predictions', 20, media.Table(columns=['image', 'label', 'score'],
                                       data=[[media.Image(gradient), 'cat', 0.9], ['n/a', 'dog', float('nan')]]), time=t + 20)
# logged again: replaces the first
log.add('answers', 20, media.Text("The answer is 43."), time=t + 21)
with open(run / media.INDEX, 'a') as f:
  f.write('{"_step": 30, "kind": "image", "key": "without a time", "path": "media/val/samples/0_0.png"}\n')
  f.write('{"_step": 30, "_time": 1731500030, "key": "future", "kind": "point_cloud", "path": "x.pcd"}\n')
  f.write('{"_step": 40.0, "key": "float step", "kind": "text", "path": "media/answers/20_0.txt"}\n')  # read as 40
  f.write('{"_step": 40, "index": null, "key": "null index", "kind": "text", "path": "media/answers/20_0.txt"}\n')  # skipped
  f.write('{"_step": 40, "_time": 1731500040, "key": "val/sam')  # cut short by a killed run
(here / 'expected.json').write_text(json.dumps(media.read_media(run), indent=1) + '\n')
