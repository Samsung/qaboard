#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["jinja2"]
# ///
"""
Renders example "batch ended" emails, to check how they look after changing templates/batch_ended.html:
  uv run backend/backend/notifications/preview.py [output directory]
Open the .html files in a browser. To check Outlook, send one to yourself: --send you@example.com (uses QABOARD_SMTP_*).
"""
import sys
import random
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from batch_email import render_batch_email, summarize  # noqa: E402


metrics_config = {
  'main_metrics': ['psnr', 'ssim', 'noise_flat', 'mtf50'],
  'available_metrics': {
    'psnr': {'label': 'PSNR', 'suffix': ' dB', 'smaller_is_better': False, 'target': 30},
    'ssim': {'label': 'SSIM', 'smaller_is_better': False, 'target': 0.9},
    'noise_flat': {'label': 'Noise in flat patches', 'short_label': 'Noise', 'suffix': ' DN', 'smaller_is_better': True, 'target': 2.0},
    'mtf50': {'label': 'MTF50', 'suffix': ' cy/px', 'smaller_is_better': False},
  },
}

info = {
  'qaboard_url': 'https://qaboard.example.com',
  'project_id': 'isp/denoiser',
  'project_name': 'isp/denoiser',
  'hexsha': '3f9c2a71be0d4c1e8a5b',
  'branch': 'feature/temporal-denoise',
  'commit_message': 'Temporal denoiser: adapt the blending to motion',
  'selected_group': 'low-light-scenes',
  'platform': 'linux',
  'source': 'webapp',
  'user_name': 'jdoe',
  'started_at': 'Mon 19 Oct, 14:02 IDT',
  'docs_url': 'https://qaboard.example.com/docs/user-guide/running-from-the-webapp#emails-when-batches-end',
}


def runs(n_inputs, strengths, failures=0, seed=1):
  rng = random.Random(seed)
  result = []
  for strength in strengths:
    for i in range(n_inputs):
      quality = 1 - abs(strength - 0.35)
      result.append({
        'id': len(result) + 1,
        'input': f"low_light/scene_{i:03d}/frame_0042.dng",
        'platform': 'linux',
        'batch': 'denoise-sweep',
        'params': {'denoise.strength': strength, 'denoise.temporal': True} if len(strengths) > 1 else {},
        'is_failed': False,
        'metrics': {
          'psnr': 28 + 4 * quality + rng.gauss(0, 0.4),
          'ssim': 0.85 + 0.08 * quality + rng.gauss(0, 0.005),
          'noise_flat': 2.6 - 1.2 * quality + rng.gauss(0, 0.05),
          'mtf50': 0.24 + 0.03 * quality + rng.gauss(0, 0.004),
        },
      })
  for run in rng.sample(result, failures):
    run['is_failed'] = True
    run['metrics'] = {}
  return result


examples = {
  'tuning-with-failures': (runs(30, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6], failures=3), {'label': 'denoise-sweep', 'duration_s': 5040}),
  'all-succeeded': (runs(42, [0.35]), {'label': 'nightly-check', 'duration_s': 754}),
  'all-failed': (runs(12, [0.35], failures=12), {'label': 'try-new-blending', 'duration_s': 95, 'source': 'cli'}),
}


if __name__ == '__main__':
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('output_dir', nargs='?', default='email-previews')
  parser.add_argument('--send', metavar='EMAIL', help="also email them, with the QABOARD_SMTP_* settings")
  args = parser.parse_args()
  output_dir = Path(args.output_dir)
  output_dir.mkdir(parents=True, exist_ok=True)
  for name, (example_runs, example_info) in examples.items():
    subject, html, text = render_batch_email(summarize(example_runs, metrics_config), {**info, **example_info})
    (output_dir / f"{name}.html").write_text(html)
    (output_dir / f"{name}.txt").write_text(f"Subject: {subject}\n\n{text}")
    print(f"{output_dir / name}.html  {subject}")
    if args.send:
      from mail import send_email
      send_email(args.send, subject, html, text)
