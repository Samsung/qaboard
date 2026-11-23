"""
Trains a (simulated) denoiser with a detection head on procedural scenes, and logs it to QA-Board with
qaboard.start_run(): series at each step, media every 200 steps, metrics at the end. Runs in seconds, numpy only.

  python train.py                       # batch "default", lr 1e-3
  python train.py --lr 3e-3 --batch lr-sweep
"""
import argparse
import time

import numpy as np
import qaboard as qb
from qaboard import Metric

import model
import scenes

PROMPT = "Describe what you restored in the harbor scene."
ANSWERS = [
  "harbor harbor the the image image noise",
  "The image has a sky. Some noise. Maybe a house?",
  "A sky with a sun, and a house near the bottom. The colors look washed out.",
  "A harbor scene: a pale sky, the sun, a red house and a tree; I removed most of the grain.",
  "A harbor scene: the sun on the left, a red house next to a tree, a kite. Most of the grain is gone, edges are soft.",
  "A harbor at midday: the sun high on the left, a red house with a lit window next to a tree, a pink kite above. I removed the sensor noise and the color blotches, the roof edge is sharp again.",
]

# the quality the model needs for each answer: the baseline stops at the 5th, the attention model reaches the last
ANSWER_THRESHOLDS = (0.12, 0.3, 0.5, 0.68, 0.87)


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('--lr', type=float, default=1e-3)
  parser.add_argument('--steps', type=int, default=2000)
  parser.add_argument('--batch', default='default')
  parser.add_argument('--seed', type=int, default=0)
  parser.add_argument('--input', default='scenes-v2/val')
  args = parser.parse_args()

  rng = np.random.default_rng(args.seed)
  # how fast and how far training goes: the architecture's capacity, the learning rate
  tau = 420 * (1e-3 / args.lr) ** 0.7
  unstable = args.lr > 2e-3
  q_max = model.CAPACITY - (0.05 if unstable else 0) - (0.02 if args.lr < 5e-4 else 0)
  warmup = 100
  clean = [scenes.scene(i) for i in range(len(scenes.SCENES))]

  configs = ["denoiser", {"lr": args.lr}]
  with qb.start_run(input=args.input, configs=configs, batch=args.batch,
                    summary={"val/loss": "min", "val/psnr": "max", "lr": "none"}) as run:
    run.log_params({"arch": model.ARCH["name"], "channels": model.ARCH["channels"],
                    "attention_skips": model.ARCH["attention_skips"], "steps": args.steps, "optimizer": "adamw"})
    q = 0.0
    for step in range(args.steps + 1):
      if step < warmup:
        lr = args.lr * (step + 1) / warmup
      else:
        lr = args.lr * (0.05 + 0.95 * 0.5 * (1 + np.cos(np.pi * (step - warmup) / (args.steps - warmup))))
      q = q_max * (1 - np.exp(-step / tau))
      if unstable and 300 < step < 900:
        q -= 0.06 * abs(np.sin(step / 37)) ** 8
      spike = 1.0 + (3.0 * rng.uniform() if unstable and rng.uniform() < 0.01 else 0)
      train_loss = (0.018 + 0.42 * (1 - q) ** 2.2) * spike * float(np.exp(rng.normal(0, 0.08)))
      values = {"train/loss": train_loss, "lr": lr}
      if step % 25 == 0:
        i = (step // 25) % len(clean)
        out = scenes.denoised(clean[i][0], q, rng)
        values["val/loss"] = 0.021 + 0.40 * (1 - q) ** 2.2 + rng.normal(0, 0.002)
        values["val/psnr"] = scenes.psnr(out, clean[i][0])
      run.log(values, step=step)

      if step % 200 == 0:
        log_media(run, step, q, clean, rng)
    # the evaluation
    final = [scenes.denoised(img, q, np.random.default_rng(7 + i)) for i, (img, _) in enumerate(clean)]
    found = [scenes.detections(objects, q, np.random.default_rng(70 + i), model.CONFIDENCE) for i, (_, objects) in enumerate(clean)]
    hits = [sum(1 for d in f if d["iou"] > 0.5 and d["label"] == d["truth"]) for f in found]
    total = sum(len(o) for _, o in clean)
    run.log_metrics({
      "psnr": Metric(float(np.mean([scenes.psnr(o, c) for o, (c, _) in zip(final, clean)])), suffix=" dB", smaller_is_better=False, precision=3),
      "mAP@0.5": Metric(sum(hits) / total, smaller_is_better=False, precision=3, target=0.6),
      "train_time": Metric(round(2.6e4 / (1 + 0.2 * model.ARCH["attention_skips"])), suffix=" s", smaller_is_better=True),
    })
    time.sleep(0.5)


def log_media(run, step, q, clean, rng):
  # the validation samples, in the order the loader gives them
  order = rng.permutation(len(clean))
  samples = []
  for i in order:
    img, _ = clean[i]
    out = scenes.denoised(img, q, np.random.default_rng(step * 10 + int(i)))
    samples.append(qb.Image(out, id=f"scene-{i:02d}", caption=f"{scenes.SCENES[i]} · {scenes.psnr(out, img):.1f} dB"))
  run.log({"val/samples": samples}, step=step)

  # detections on two scenes
  for i in (0, 4):
    img, objects = clean[i]
    out = scenes.denoised(img, q, np.random.default_rng(step * 10 + i))
    found = scenes.detections(objects, q, np.random.default_rng(step + 100 * i), model.CONFIDENCE)
    boxes = [{k: d[k] for k in ("x", "y", "w", "h", "label", "score")} for d in found if d["score"] > 0.15]
    run.log_image(f"val/detections/{scenes.SCENES[i]}", out, boxes=boxes, caption=f"{len(boxes)} boxes", step=step)

  # the predictions table: one row per detection of the dusk street scene
  img, objects = clean[2]
  out = scenes.denoised(img, q, np.random.default_rng(step * 10 + 2))
  found = scenes.detections(objects, q, np.random.default_rng(step + 200), model.CONFIDENCE)
  rows = [[qb.Image(scenes.crop(out, d), id=f"det-{k}"), d["label"], d["score"], d["iou"]]
          for k, d in enumerate(sorted(found, key=lambda d: -d["score"]))]
  run.log_table("predictions", rows, columns=["image", "label", "score", "iou"], step=step)

  # the denoised audio of the same utterance
  run.log_audio("denoise/audio", scenes.speech(q, np.random.default_rng(step)), sample_rate=16000,
                caption="utterance-03", step=step)

  # the first convolution's weights: from wide and centered to sparse and two-sided
  spread = 0.45 * (1 - q) + 0.06
  n = 4096
  weights = np.concatenate([rng.normal(0, spread, n // 2),
                            rng.normal(0.16 * q, spread * 0.6, n // 4), rng.normal(-0.14 * q, spread * 0.6, n // 4)])
  run.log_histogram("weights/conv1", weights, step=step)

  run.log_text("answers/prompt-1", f"Q: {PROMPT}\n\nA: {ANSWERS[sum(q >= t for t in ANSWER_THRESHOLDS)]}", step=step)


if __name__ == '__main__':
  main()
