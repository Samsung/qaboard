#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6", "requests>=2.31", "jsonschema>=4.21", "psutil>=5.9", "pillow>=10", "pytest>=8", "pytest-benchmark>=5"]
# ///
"""
Makes the stand-ins of the performance viewers, without the demo stack: it measures an example at two commits of its
story, then takes pictures of the web app's playground for the viewer on the two files (light and dark).

  uv run docs-media/standins/make.py                     # both, about 15 minutes
  uv run docs-media/standins/make.py commit/benchmarks   # one of them
  uv run docs-media/standins/make.py --reuse             # only the pictures, from the last measurements

- commit/benchmarks: the fleet SDK's benchmarks (examples/software-quality/benchmarks/, pytest-benchmark), at the
  commit that decodes frames with the deprecated parse() and at the commit before.
- commit/flame-top-functions: the gateway's CPU profile on steady-high (examples/serving-latency, needs Rust), with
  the shared cache and at its parent.

Needs `npm ci` in webapp/ (vite and Playwright, with its Chromium), and a quiet machine: the numbers are this
machine's. It writes standins/<id>.webp and <id>-dark.webp and prints their size: update `width`, `height`, and the
numbers in `alt` and `caption`, in ../shots.yaml. Measurements are kept in docs-media/out/standins/.
"""
import argparse
import importlib.util
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlencode

from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
EXAMPLES = REPO / 'examples'
WEBAPP = REPO / 'webapp'
OUT = HERE.parent / 'out' / 'standins'
PORT = 5199

STANDINS = {
  'commit/benchmarks': dict(
    project='software-quality', new='legacy-parse', ref='reserve-tests',
    page='benchmark-viewer.html', file='pytest.benchmarks.json', title='pytest.benchmarks.json',
    width=1212, max_height=648,
  ),
  'commit/flame-top-functions': dict(
    project='serving-latency', new='cache-shared', ref='batch-overflow-fix',
    page='flame-graph-viewer.html', file='cpu.folded', title='profiles/steady-high.yaml · cpu.folded',
    width=1244, max_height=1400,
  ),
}


def story_of(project):
  """The example's story, read by seed.py: each commit's effective flags and branch"""
  spec = importlib.util.spec_from_file_location('seed', HERE.parent / 'seed.py')
  seed = importlib.util.module_from_spec(spec)
  sys.modules['seed'] = seed
  spec.loader.exec_module(seed)
  return seed.Story(EXAMPLES / project / 'story.yaml', seed.default_t0())


def with_flags(example: Path, flags: dict, measure):
  """Runs measure() on the example's code as of a commit: its flags in build/flags.json, as the seeder writes them"""
  path = example / 'build' / 'flags.json'
  before = path.read_text() if path.exists() else None
  had_build = path.parent.exists()
  path.parent.mkdir(exist_ok=True)
  path.write_text(json.dumps(flags, indent=2, sort_keys=True) + '\n')
  try:
    measure()
  finally:
    if before is None:
      path.unlink()
      if not had_build and not any(path.parent.iterdir()):
        path.parent.rmdir()
    else:
      path.write_text(before)


def one_cpu():
  """Benchmarks of single-threaded code are steadier on one CPU"""
  return ['taskset', '-c', str(max(os.sched_getaffinity(0)))] if shutil.which('taskset') else []


def measure_benchmarks(example: Path, output: Path):
  # long rounds (50 ms or more of calls each) average the machine's jitter out of the spread pytest-benchmark reports
  subprocess.run([
    *one_cpu(), sys.executable, '-m', 'pytest', 'benchmarks', '-o', 'testpaths=benchmarks', '-q', '-p', 'no:cacheprovider',
    f'--benchmark-json={output}', '--benchmark-disable-gc', '--benchmark-warmup=on',
    '--benchmark-min-time=0.05', '--benchmark-max-time=3', '--benchmark-min-rounds=30',
  ], cwd=example, check=True)
  # pytest-benchmark records the git checkout it ran in: the playground doesn't show it, and it isn't the demo's
  data = json.loads(output.read_text())
  data.pop('commit_info', None)
  output.write_text(json.dumps(data, indent=1))


def measure_flame_graph(example: Path, output: Path):
  results = example / 'output'
  started = time.time()
  subprocess.run(['uv', 'run', '--project', str(REPO), 'qa', 'run', '--input', 'profiles/steady-high.yaml'], cwd=example, check=True)
  profiles = [p for p in results.rglob('cpu.folded') if p.stat().st_mtime >= started]
  if len(profiles) != 1:
    raise SystemExit(f"Expected the run's cpu.folded under {results}, found {len(profiles)}")
  shutil.copyfile(profiles[0], output)


MEASURES = {'commit/benchmarks': measure_benchmarks, 'commit/flame-top-functions': measure_flame_graph}

# Runs with webapp/'s Playwright: a picture of the playground's content, down to max_height
SCREENSHOT = """
const { chromium } = require('@playwright/test');
const [url, path, width, max_height] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: +width, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(url);
  await page.waitForSelector('#root table, #root canvas, #root svg');
  await page.waitForTimeout(1500);
  // the content's own height: its box is at least as tall as the window
  const box = await page.locator('#root > div').boundingBox();
  const height = await page.evaluate(() => {
    const root = document.querySelector('#root > div');
    return Math.max(...[...root.children].map(e => e.getBoundingClientRect().bottom)) + 16 + window.scrollY;
  });
  await page.setViewportSize({ width: +width, height: Math.ceil(Math.min(height, +max_height)) });
  await page.waitForTimeout(500);
  await page.screenshot({ path, clip: { x: box.x, y: 0, width: box.width, height: Math.ceil(Math.min(height, +max_height)) } });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
"""


def pictures(shot_id: str, standin: dict, labels: dict):
  """The playground on the two files, light and dark, as WebP at scale 2"""
  public = WEBAPP / 'public' / '_standin'   # vite serves webapp/public/
  shutil.rmtree(public, ignore_errors=True)
  public.mkdir(parents=True)
  script = OUT / 'screenshot.cjs'
  script.write_text(SCREENSHOT)
  # in its own process group: vite starts children, which must stop with it
  vite = subprocess.Popen([str(WEBAPP / 'node_modules' / '.bin' / 'vite'), '--port', str(PORT), '--strictPort'], cwd=WEBAPP,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
  try:
    for side in ('new', 'ref'):
      shutil.copyfile(OUT / shot_id / f"{side}-{standin['file']}", public / f"{side}-{standin['file']}")
    for _ in range(60):
      try:
        socket.create_connection(('localhost', PORT), timeout=1).close()
        break
      except OSError:
        time.sleep(1)
    else:
      raise SystemExit("vite didn't start: run `npm ci` in webapp/")
    query = urlencode({
      'new': f"/_standin/new-{standin['file']}", 'ref': f"/_standin/ref-{standin['file']}", 'name': standin['title'],
      'new_label': labels['new'], 'ref_label': labels['ref'],
    })
    for theme in ('', '-dark'):
      png = OUT / shot_id / f"picture{theme}.png"
      url = f"http://localhost:{PORT}/{standin['page']}?{query}{'&dark' if theme else ''}"
      subprocess.run(['node', str(script), url, str(png), str(standin['width']), str(standin['max_height'])], check=True,
                     env={**os.environ, 'NODE_PATH': str(WEBAPP / 'node_modules')})
      webp = HERE / f"{shot_id}{theme}.webp"
      webp.parent.mkdir(parents=True, exist_ok=True)
      image = Image.open(png).convert('RGB')
      image.save(webp, quality=90, method=6)
      print(f"{webp.relative_to(REPO)}: width {image.width // 2}, height {image.height // 2}, {webp.stat().st_size // 1000} kB")
  finally:
    os.killpg(vite.pid, signal.SIGTERM)
    shutil.rmtree(public, ignore_errors=True)


def main():
  parser = argparse.ArgumentParser(description=__doc__.strip().split('\n')[0])
  parser.add_argument('shots', nargs='*', choices=[*STANDINS, []], help="default: all of them")
  parser.add_argument('--reuse', action='store_true', help="Don't measure again: only take the pictures")
  args = parser.parse_args()
  for shot_id in args.shots or STANDINS:
    standin = STANDINS[shot_id]
    story = story_of(standin['project'])
    example = EXAMPLES / standin['project']
    (OUT / shot_id).mkdir(parents=True, exist_ok=True)
    labels = {}
    for side in ('ref', 'new'):
      commit = story.commits[standin[side]]
      # what the web app calls the runs: the reference by its branch, the new commit by its branch, or its id on the same one
      labels[side] = commit.branch
      output = OUT / shot_id / f"{side}-{standin['file']}"
      if not args.reuse:
        print(f"{shot_id}: measuring {standin['project']} at {commit.id}", flush=True)
        with_flags(example, commit.flags, lambda: MEASURES[shot_id](example, output))
    if labels['new'] == labels['ref']:
      labels['new'] = standin['new']
    pictures(shot_id, standin, labels)


if __name__ == '__main__':
  main()
