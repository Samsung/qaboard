"""
The same training, written for Weights & Biases. Run it through QA-Board's shim, without changing it:

  python -m qaboard.integrations.wandb train_wandb.py --lr 1e-3

wandb doesn't need to be installed: the shim stands in for it, and the run lands in QA-Board like start_run()'s.
"""
import argparse

import numpy as np
import wandb

import scenes


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('--lr', type=float, default=1e-3)
  parser.add_argument('--steps', type=int, default=1200)
  args = parser.parse_args()

  run = wandb.init(project="denoiser", group="wandb-shim", name="scenes-v2/val",
                   config={"lr": args.lr, "arch": "unet-s", "epochs": 12}, tags=["wandb", "baseline"])
  wandb.define_metric("val/psnr", summary="max")
  rng = np.random.default_rng(1)
  clean = [scenes.scene(i) for i in range(len(scenes.SCENES))]
  tau = 380 * (1e-3 / args.lr) ** 0.7
  q = 0.0
  for step in range(args.steps + 1):
    q = 0.82 * (1 - np.exp(-step / tau))
    metrics = {"train/loss": (0.02 + 0.42 * (1 - q) ** 2.2) * float(np.exp(rng.normal(0, 0.08))),
               "lr": args.lr * 0.5 * (1 + np.cos(np.pi * step / args.steps))}
    if step % 25 == 0:
      out = scenes.denoised(clean[1][0], q, rng)
      metrics["val/psnr"] = scenes.psnr(out, clean[1][0])
    if step % 200 == 0:
      images = []
      for i in range(4):
        img, objects = clean[i]
        out = scenes.denoised(img, q, np.random.default_rng(step + i))
        found = scenes.detections(objects, q, np.random.default_rng(step + 50 * i))
        # W&B's box format: pixel coordinates, a class id per box, class labels
        labels = {k: l for k, l in enumerate(scenes.LABELS)}
        boxes = {"predictions": {"box_data": [
          {"position": {"minX": d["x"], "minY": d["y"], "maxX": d["x"] + d["w"], "maxY": d["y"] + d["h"]},
           "domain": "pixel", "class_id": scenes.LABELS.index(d["label"]), "scores": {"score": d["score"]}}
          for d in found], "class_labels": labels}}
        images.append(wandb.Image((out * 255).astype(np.uint8), caption=scenes.SCENES[i], boxes=boxes))
      metrics["val/examples"] = images
      metrics["denoise/audio"] = wandb.Audio(scenes.speech(q, np.random.default_rng(step)), sample_rate=16000, caption="utterance-03")
      # .tolist(): the shim's Histogram refuses numpy arrays (`sequence or []`, qaboard/integrations/wandb/_media.py)
      metrics["weights/conv1"] = wandb.Histogram(rng.normal(0.1 * q, 0.45 * (1 - q) + 0.06, 4096).tolist())
    wandb.log(metrics, step=step)
  run.summary["psnr"] = scenes.psnr(scenes.denoised(clean[1][0], q, rng), clean[1][0])
  wandb.finish()


if __name__ == '__main__':
  main()
