#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Seeds the local stack (stack.py) with training runs created from Python with qaboard.start_run():

  main                  "Train the denoiser on procedural scenes"     batch default: train.py (the reference)
                                                                       batch wandb-shim, mlflow-plugin
  feat/attention-skips  "Add attention to the skip connections"       batch default: train.py (the new run)
                                                                       batch lr-sweep: 3 runs, lr 3e-4, 1e-3, 3e-3
                                                                       batch wandb-shim, mlflow-plugin

The demo project is a git repository made from project/ (default: $TMPDIR/qaboard-demo-project). Runs go through the
web app's address (Vite proxies /api to the backend), as CI jobs (CI=true, GIT_COMMIT, GIT_BRANCH) with the user's
token, and send their files to the server (no `storage` in qaboard.yaml). The trainings run with the repository's
qaboard (uv run --project <repo>, with the mlflow extra; --inexact keeps the other extras installed).

  uv run docs-media/demo/local-stack/seed.py            # creates the repository (again) and runs everything
  uv run docs-media/demo/local-stack/seed.py --only wandb mlflow
"""
import argparse
import json
import os
import shutil
import subprocess
import tempfile
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
TEMPORARY = Path(tempfile.gettempdir())
STACK = Path(os.environ.get('QABOARD_LOCAL_STACK', TEMPORARY / 'qaboard-local-stack'))
WEB_URL = 'http://localhost:3000'
PROJECT = 'kitefin/denoiser'
FEATURE = 'feat/attention-skips'
AUTHOR = {'GIT_AUTHOR_NAME': 'Maya Chen', 'GIT_AUTHOR_EMAIL': 'maya@example.com',
          'GIT_COMMITTER_NAME': 'Maya Chen', 'GIT_COMMITTER_EMAIL': 'maya@example.com'}


def log(message):
  print(f"[seed] {message}", file=sys.stderr, flush=True)


def git(workdir, *args):
  return subprocess.run(['git', *args], cwd=workdir, check=True, capture_output=True, text=True,
                        env={**os.environ, **AUTHOR}).stdout.strip()


def make_repository(workdir: Path):
  if workdir.exists():
    shutil.rmtree(workdir)
  shutil.copytree(HERE / 'project', workdir, ignore=shutil.ignore_patterns('__pycache__', 'output'))
  git(workdir, 'init', '-q', '-b', 'main')
  git(workdir, 'add', '-A')
  git(workdir, 'commit', '-q', '-m', 'Train the denoiser on procedural scenes')
  main = git(workdir, 'rev-parse', 'HEAD')
  git(workdir, 'checkout', '-q', '-b', FEATURE)
  model = workdir / 'model.py'
  text = model.read_text()
  text = (text.replace('"name": "unet-s"', '"name": "unet-s-attn"')
              .replace('"attention_skips": False', '"attention_skips": True')
              .replace('CAPACITY = 0.84', 'CAPACITY = 0.90')
              .replace('CONFIDENCE = 0.0', 'CONFIDENCE = 0.06'))
  model.write_text(text)
  git(workdir, 'commit', '-q', '-am', 'Add attention to the skip connections')
  feature = git(workdir, 'rev-parse', 'HEAD')
  return main, feature


def run(workdir: Path, branch: str, args, extra_env=None, with_packages=()):
  git(workdir, 'checkout', '-q', branch)
  sha = git(workdir, 'rev-parse', 'HEAD')
  token = (STACK / 'token').read_text().strip()
  env = {k: v for k, v in os.environ.items() if not k.startswith('VIRTUAL_ENV')}
  env.update({
    'QABOARD_URL': WEB_URL, 'QABOARD_TOKEN': token,
    # as a CI job: runs go to the batch they name (not "@maya| ..."), and the commit and branch are given
    'CI': 'true', 'GIT_COMMIT': sha, 'GIT_BRANCH': branch,
    'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost',
    'MLFLOW_DISABLE_AGENT_HINT': '1', 'PYTHONUNBUFFERED': '1',
    **(extra_env or {}),
  })
  command = ['uv', 'run', '--project', str(REPO), '--inexact', '--extra', 'mlflow', '--quiet',
             *[f'--with={p}' for p in with_packages], 'python', *args]
  log(f"{branch} ({sha[:8]}): {' '.join(args)}")
  result = subprocess.run(command, cwd=workdir, env=env, capture_output=True, text=True)
  lines = (result.stdout + result.stderr).splitlines()
  for line in lines:
    if 'qaboard' in line.lower() or 'error' in line.lower() or 'warn' in line.lower() or 'http' in line:
      print(f"    {line}", file=sys.stderr)
  if result.returncode != 0:
    print('\n'.join(lines[-40:]), file=sys.stderr)
    sys.exit(f"failed: {' '.join(args)}")
  return sha


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('--workdir', type=Path, default=TEMPORARY / 'qaboard-demo-project')
  parser.add_argument('--only', nargs='*', choices=['baseline', 'new', 'sweep', 'wandb', 'mlflow'])
  args = parser.parse_args()
  only = set(args.only or ['baseline', 'new', 'sweep', 'wandb', 'mlflow'])
  if args.only and args.workdir.exists():
    main_sha = git(args.workdir, 'rev-parse', 'main')
    feature_sha = git(args.workdir, 'rev-parse', FEATURE)
  else:
    main_sha, feature_sha = make_repository(args.workdir)
  log(f"repository: {args.workdir}, main {main_sha[:8]}, {FEATURE} {feature_sha[:8]}")

  wandb = ['-m', 'qaboard.integrations.wandb', 'train_wandb.py']
  mlflow_env = {'MLFLOW_TRACKING_URI': 'qaboard:'}
  # MLflow itself needs Pillow for log_image(array) and pandas for log_table (an overlay: the repository's venv is unchanged)
  mlflow_packages = ('pillow', 'pandas')
  if 'baseline' in only:
    run(args.workdir, 'main', ['train.py'])
  if 'wandb' in only:
    run(args.workdir, 'main', wandb)
  if 'mlflow' in only:
    run(args.workdir, 'main', ['train_mlflow.py'], mlflow_env, mlflow_packages)
  if 'new' in only:
    run(args.workdir, FEATURE, ['train.py'])
  if 'sweep' in only:
    for lr in ('3e-4', '1e-3', '3e-3'):
      run(args.workdir, FEATURE, ['train.py', '--lr', lr, '--batch', 'lr-sweep'])
  if 'wandb' in only:
    run(args.workdir, FEATURE, wandb + ['--lr', '1.5e-3'])
  if 'mlflow' in only:
    run(args.workdir, FEATURE, ['train_mlflow.py', '--lr', '1.5e-3'], mlflow_env, mlflow_packages)

  commit = f"{WEB_URL}/{PROJECT}/commit/{feature_sha}"
  urls = {
    'new run vs reference': f"{commit}?reference={main_sha}",
    'lr sweep, summary': f"{commit}?batch=lr-sweep&reference={main_sha}&selected_views=summary",
    'wandb shim': f"{commit}?batch=wandb-shim&reference={main_sha}&batch_ref=wandb-shim",
    'mlflow plugin': f"{commit}?batch=mlflow-plugin&reference={main_sha}&batch_ref=mlflow-plugin",
    'reference commit': f"{WEB_URL}/{PROJECT}/commit/{main_sha}",
    'commits': f"{WEB_URL}/{PROJECT}/commits",
  }
  (STACK / 'seeded.json').write_text(json.dumps({'main': main_sha, 'feature': feature_sha, 'urls': urls}, indent=2))
  print(json.dumps(urls, indent=2))


if __name__ == '__main__':
  main()
