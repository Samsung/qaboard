"""
The same training, written for MLflow. Send it to QA-Board with its tracking URI, without changing it:

  MLFLOW_TRACKING_URI=qaboard: python train_mlflow.py --lr 1e-3
"""
import argparse
import tempfile
from pathlib import Path

import mlflow
import numpy as np

import scenes


def png(image):
  """PNG bytes without Pillow (mlflow.log_image needs Pillow for arrays)"""
  from qaboard.media import png as encode, image_array
  return encode(image_array(image))


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('--lr', type=float, default=1e-3)
  parser.add_argument('--steps', type=int, default=1200)
  args = parser.parse_args()

  mlflow.set_experiment("mlflow-plugin")
  rng = np.random.default_rng(2)
  clean = [scenes.scene(i) for i in range(len(scenes.SCENES))]
  tau = 400 * (1e-3 / args.lr) ** 0.7
  with mlflow.start_run(run_name="scenes-v2/val"):
    mlflow.log_params({"lr": args.lr, "arch": "unet-s", "batch_size": 16})
    q = 0.0
    for step in range(args.steps + 1):
      q = 0.83 * (1 - np.exp(-step / tau))
      mlflow.log_metrics({"train/loss": (0.02 + 0.42 * (1 - q) ** 2.2) * float(np.exp(rng.normal(0, 0.08))),
                          "lr": args.lr * 0.5 * (1 + np.cos(np.pi * step / args.steps))}, step=step)
      if step % 25 == 0:
        out = scenes.denoised(clean[3][0], q, rng)
        mlflow.log_metric("val/psnr", scenes.psnr(out, clean[3][0]), step=step)
      if step % 200 == 0:
        out = scenes.denoised(clean[3][0], q, np.random.default_rng(step))
        try:
          mlflow.log_image(out.astype(np.float32), key="val/dune", step=step)
        except Exception as e:  # mlflow converts arrays with Pillow
          if step == 0:
            print(f"mlflow.log_image: {e}: logging the PNG as an artifact instead")
          with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / f"dune_{step:04d}.png"
            path.write_bytes(png(out))
            mlflow.log_artifact(str(path), artifact_path="samples")
    found = scenes.detections(clean[3][1], q, rng)
    mlflow.log_table({"label": [d["label"] for d in found], "score": [d["score"] for d in found],
                      "iou": [d["iou"] for d in found]}, artifact_file="predictions.json")
    mlflow.log_text("A dune under a pale sky, the sun on the right, a kite and a tree.", "answers/prompt-1.txt")
    mlflow.log_metric("psnr", scenes.psnr(scenes.denoised(clean[3][0], q, rng), clean[3][0]))


if __name__ == '__main__':
  main()
