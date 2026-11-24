"""
Procedural data for the demo trainings (numpy only): small scenes with objects to detect, and speech-like sounds.
A "model" here is a quality q in [0, 1] that grows with the steps: what it outputs gets closer to the truth.
"""
import numpy as np

W, H = 192, 128
LABELS = ("sun", "house", "tree", "kite")

# muted, tasteful palettes: sky top, sky bottom, ground
SKIES = [
  ((0.33, 0.55, 0.80), (0.86, 0.90, 0.95), (0.42, 0.60, 0.38)),
  ((0.95, 0.62, 0.42), (0.99, 0.86, 0.66), (0.55, 0.52, 0.36)),
  ((0.20, 0.27, 0.48), (0.62, 0.52, 0.70), (0.25, 0.33, 0.30)),
  ((0.48, 0.73, 0.78), (0.93, 0.95, 0.88), (0.68, 0.62, 0.44)),
  ((0.62, 0.70, 0.86), (0.96, 0.87, 0.84), (0.37, 0.52, 0.45)),
  ((0.26, 0.45, 0.62), (0.80, 0.86, 0.80), (0.46, 0.43, 0.32)),
]
COLORS = {
  "sun": (0.98, 0.82, 0.36), "house": (0.80, 0.38, 0.30), "roof": (0.36, 0.24, 0.26), "tree": (0.20, 0.45, 0.30),
  "trunk": (0.42, 0.30, 0.20), "kite": (0.92, 0.36, 0.52), "tail": (0.30, 0.30, 0.40),
}
SCENES = ["harbor", "orchard", "dusk-street", "dune", "meadow", "hillside"]


def _soft(d, width=0.8):
  """coverage from a signed distance (negative inside): antialiased edges"""
  return np.clip(0.5 - d / width, 0, 1)[..., None]


def _paint(img, mask, color):
  return img * (1 - mask) + mask * np.asarray(color)


def scene(index: int):
  """(the clean image HxWx3 in [0, 1], its objects [{'x','y','w','h','label'}])"""
  rng = np.random.default_rng(1000 + index)
  top, bottom, ground = SKIES[index % len(SKIES)]
  yy, xx = np.mgrid[0:H, 0:W].astype(float)
  t = (yy / H)[..., None]
  img = (1 - t) * np.asarray(top) + t * np.asarray(bottom)
  horizon = H * rng.uniform(0.62, 0.72) + 4 * np.sin(xx / W * np.pi * rng.uniform(1, 3) + rng.uniform(0, 6))
  img = _paint(img, _soft(horizon - yy), ground)
  # a little texture on the ground
  img += (yy > horizon)[..., None] * 0.03 * np.sin(xx * 0.7 + yy * 1.3)[..., None]
  objects = []
  # the sun
  cx, cy, r = rng.uniform(20, W - 20), rng.uniform(14, 34), rng.uniform(9, 14)
  img = _paint(img, _soft(np.hypot(xx - cx, yy - cy) - r * 1.6) * 0.18, COLORS["sun"])
  img = _paint(img, _soft(np.hypot(xx - cx, yy - cy) - r), COLORS["sun"])
  objects.append({"x": cx - r, "y": cy - r, "w": 2 * r, "h": 2 * r, "label": "sun"})
  base = float(H * 0.70)
  # houses and trees on the ground
  for kind in rng.permutation(["house", "tree", "house" if index % 2 else "tree"]):
    x0 = rng.uniform(8, W - 44)
    if any(abs(x0 - o["x"]) < 30 for o in objects if o["label"] in ("house", "tree")):
      continue
    if kind == "house":
      w, h = rng.uniform(26, 36), rng.uniform(18, 24)
      y0 = base - h + rng.uniform(4, 10)
      box = np.maximum(np.maximum(x0 - xx, xx - (x0 + w)), np.maximum(y0 - yy, yy - (y0 + h)))
      img = _paint(img, _soft(box), COLORS["house"])
      # the roof: a triangle
      apex = y0 - h * 0.6
      roof = np.maximum(yy - y0, np.maximum(apex - yy, np.abs(xx - (x0 + w / 2)) - (yy - apex) / (y0 - apex) * (w / 2 + 3)))
      img = _paint(img, _soft(roof), COLORS["roof"])
      window = np.maximum(np.abs(xx - (x0 + w * 0.3)) - 3, np.abs(yy - (y0 + h * 0.4)) - 3)
      img = _paint(img, _soft(window), (0.98, 0.92, 0.70))
      objects.append({"x": x0 - 3, "y": apex, "w": w + 6, "h": y0 + h - apex, "label": "house"})
    else:
      w, h = rng.uniform(18, 26), rng.uniform(30, 40)
      y0 = base - h + rng.uniform(4, 10)
      trunk = np.maximum(np.abs(xx - (x0 + w / 2)) - 2, np.maximum(y0 + h * 0.65 - yy, yy - (y0 + h)))
      img = _paint(img, _soft(trunk), COLORS["trunk"])
      crown = np.maximum(yy - (y0 + h * 0.75), np.abs(xx - (x0 + w / 2)) - (yy - y0) / (h * 0.75) * (w / 2))
      img = _paint(img, _soft(np.maximum(crown, y0 - yy)), COLORS["tree"])
      objects.append({"x": x0, "y": y0, "w": w, "h": h, "label": "tree"})
  # a kite in the sky (kitefin's)
  kx, ky, ks = rng.uniform(30, W - 30), rng.uniform(24, 48), rng.uniform(8, 12)
  while abs(kx - cx) < 34:
    kx = rng.uniform(30, W - 30)
  diamond = np.abs(xx - kx) / ks + np.abs(yy - ky) / (ks * 1.4) - 1
  img = _paint(img, _soft(diamond * ks), COLORS["kite"])
  for i in range(14):
    tx, ty = kx + 2 * np.sin(i * 0.8), ky + ks * 1.4 + i * 1.8
    img = _paint(img, _soft(np.hypot(xx - tx, yy - ty) - 0.8), COLORS["tail"])
  objects.append({"x": kx - ks, "y": ky - ks * 1.4, "w": 2 * ks, "h": ks * 2.8 + 22, "label": "kite"})
  return np.clip(img, 0, 1), objects


def _blur(img, amount):
  """a cheap blur: what an undertrained denoiser outputs, mixed in by `amount`"""
  if amount <= 0:
    return img
  out = img.copy()
  for axis in (0, 1):
    out = (np.roll(out, 1, axis) + out * 2 + np.roll(out, -1, axis)) / 4
  out = (np.roll(out, 1, 0) + out * 2 + np.roll(out, -1, 0)) / 4
  return img * (1 - amount) + out * amount


def denoised(clean, q, rng, flaw=0.0):
  """What a model of quality q outputs from a noisy capture of `clean`: residual noise, blur and a color cast"""
  noise = rng.normal(0, 1, clean.shape) * (0.30 * (1 - q) ** 1.6 + 0.012)
  # chroma blotches, worse early
  blotch = np.kron(rng.normal(0, 1, (H // 8, W // 8, 3)), np.ones((8, 8, 1))) * 0.06 * (1 - q) ** 2
  out = _blur(clean, 0.8 * (1 - q) ** 1.2 + flaw) + noise + blotch
  out = out * (1 - 0.06 * (1 - q)) + 0.06 * (1 - q) * np.array([0.55, 0.5, 0.6])
  return np.clip(out, 0, 1)


def psnr(a, b):
  return float(10 * np.log10(1 / max(np.mean((a - b) ** 2), 1e-10)))


def iou(a, b):
  x0, y0 = max(a["x"], b["x"]), max(a["y"], b["y"])
  x1, y1 = min(a["x"] + a["w"], b["x"] + b["w"]), min(a["y"] + a["h"], b["y"] + b["h"])
  inter = max(0, x1 - x0) * max(0, y1 - y0)
  return inter / (a["w"] * a["h"] + b["w"] * b["h"] - inter + 1e-9)


def detections(objects, q, rng, confidence=0.0):
  """Boxes a detector of quality q finds: jittered, with scores, and false positives early"""
  found = []
  for o in objects:
    if rng.uniform() > 0.55 + 0.45 * q:  # missed
      continue
    jitter = (1 - q) * 0.35 + 0.03
    box = {
      "x": o["x"] + rng.normal(0, jitter) * o["w"], "y": o["y"] + rng.normal(0, jitter) * o["h"],
      "w": o["w"] * (1 + rng.normal(0, jitter)), "h": o["h"] * (1 + rng.normal(0, jitter)),
    }
    box = {k: round(float(v), 1) for k, v in box.items()}
    box["w"], box["h"] = max(box["w"], 4), max(box["h"], 4)
    score = float(np.clip(0.35 + 0.55 * q + confidence + rng.normal(0, 0.06), 0.05, 0.995))
    label = o["label"] if rng.uniform() < 0.6 + 0.4 * q else str(rng.choice([l for l in LABELS if l != o["label"]]))
    found.append({**box, "label": label, "score": round(score, 3), "iou": round(iou(box, o), 3), "truth": o["label"]})
  for _ in range(rng.poisson(2.5 * (1 - q) ** 2)):
    w, h = rng.uniform(12, 40), rng.uniform(12, 40)
    box = {"x": round(float(rng.uniform(0, W - w)), 1), "y": round(float(rng.uniform(0, H - h)), 1), "w": round(float(w), 1), "h": round(float(h), 1)}
    found.append({**box, "label": str(rng.choice(LABELS)), "score": round(float(rng.uniform(0.2, 0.45) * (1 - q) + 0.1), 3), "iou": 0.0, "truth": None})
  return found


def speech(q, rng, sample_rate=16000, seconds=2.4, flaw=0.0):
  """A speech-like phrase (vowels with formants, a pitch contour), with background noise and hum that fade with q"""
  t = np.arange(int(sample_rate * seconds)) / sample_rate
  # syllables: (start, end, vowel formants F1, F2)
  syllables = [(0.10, 0.38, 730, 1090), (0.45, 0.70, 270, 2290), (0.78, 1.10, 570, 840), (1.20, 1.42, 530, 1840),
               (1.50, 1.85, 660, 1720), (1.95, 2.25, 300, 870)]
  f0 = 165 + 25 * np.sin(2 * np.pi * 0.6 * t) - 18 * t
  phase = 2 * np.pi * np.cumsum(f0) / sample_rate
  voice = np.zeros_like(t)
  for start, end, f1, f2 in syllables:
    env = np.clip((t - start) / 0.04, 0, 1) * np.clip((end - t) / 0.06, 0, 1)
    for k in range(1, 28):
      fk = k * f0
      # resonances at the formants, and a falling spectrum
      gain = (np.exp(-((fk - f1) / 140) ** 2) + 0.7 * np.exp(-((fk - f2) / 200) ** 2) + 0.15 * np.exp(-((fk - 2600) / 300) ** 2)) / k ** 0.3
      voice += env * gain * np.sin(k * phase)
  voice /= np.max(np.abs(voice)) + 1e-9
  noise = rng.normal(0, 1, t.shape)
  # pinkish: smoothed
  noise = np.convolve(noise, np.ones(4) / 4, mode='same')
  hum = np.sin(2 * np.pi * 50 * t) + 0.4 * np.sin(2 * np.pi * 150 * t)
  level = 0.6 * (1 - q) ** 1.2 + 0.01 + flaw
  out = 0.7 * voice * (0.6 + 0.4 * q) + level * noise + 0.25 * level * hum
  return np.clip(out / (np.max(np.abs(out)) + 1e-9) * 0.9, -1, 1).astype(np.float32)


def crop(img, box, size=48):
  """the region of a box, resized (nearest) to size x size"""
  x0, y0 = int(max(0, box["x"])), int(max(0, box["y"]))
  x1, y1 = int(min(W, box["x"] + box["w"])), int(min(H, box["y"] + box["h"]))
  if x1 - x0 < 2 or y1 - y0 < 2:
    return np.zeros((size, size, 3))
  region = img[y0:y1, x0:x1]
  ys = (np.arange(size) * region.shape[0] / size).astype(int)
  xs = (np.arange(size) * region.shape[1] / size).astype(int)
  return region[ys][:, xs]
