#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "boto3==1.43.100",
#   "jsonschema==4.26.0",
#   "numpy==2.5.3",
#   "pillow==12.3.0",
#   "pyyaml==6.0.3",
# ]
# ///
"""
Publishes the captures in docs-media/out/ to the qaboard-media bucket and records them in website/media.json.
See docs-media/README.md#publishing-publishpy.

  uv run docs-media/publish.py [--only GLOB] [--dry-run]
  uv run docs-media/publish.py gc [--dry-run]

1. Encode each out/<area>/<subject>/ (meta.json + still.png, frames + frames.ffconcat, or tape.mp4/tape.webm)
2. Check the budgets: nothing is uploaded if a file is over budget
3. Dedupe against the current manifest entry (pixelmatch on the PNG masters, posters and one frame per second)
4. Upload what changed, at shots/<id>/<first 16 hex of SHA-256>.<ext>, never overwriting
5. Write website/media.json, valid against website/media.schema.json

The encoders are pinned: docs-media/install-tools.sh installs them in $DOCS_MEDIA_BIN (~/.cache/qaboard-docs-media/bin).
Credentials: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (S3 API, bucket $R2_BUCKET, default qaboard-media).
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import fnmatch
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

DOCS_MEDIA = Path(__file__).resolve().parent
REPO = DOCS_MEDIA.parent
OUT = DOCS_MEDIA / "out"
MANIFEST = REPO / "website" / "media.json"
SCHEMA = REPO / "website" / "media.schema.json"
SHOTS_YAML = DOCS_MEDIA / "shots.yaml"
CACHE = REPO / "website" / ".media-cache" / "media"
TOOLS_BIN = Path(os.environ.get("DOCS_MEDIA_BIN", Path.home() / ".cache" / "qaboard-docs-media" / "bin"))
BUCKET = os.environ.get("R2_BUCKET", "qaboard-media")
DEFAULT_BASE_URL = "https://qaboard-media.sivoov.app"
USER_AGENT = "qaboard-docs-media"
ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$")

CACHE_CONTROL = "public, max-age=31536000, immutable"
CONTENT_TYPES = {
    "avif": "image/avif",
    "webp": "image/webp",
    "png": "image/png",
    "mp4": "video/mp4",
    "webm": "video/webm",
    "vtt": "text/vtt; charset=utf-8",
}

# Budgets (README.md#budgets), in bytes (1 KB = 1000 bytes) and seconds
KB, MB = 1000, 1000 * 1000
BUDGETS = {
    "still": {"avif": 250 * KB, "webp": 450 * KB, "png": 6 * MB, "lqip": 1 * KB},
    "clip": {"mp4": 3 * MB, "webm": 3 * MB, "poster": 200 * KB, "lqip": 1 * KB, "duration": (6, 20)},
    "tape": {"mp4": int(1.5 * MB), "webm": int(1.5 * MB), "poster": 200 * KB, "lqip": 1 * KB, "duration": (1, 45)},
}
BUDGET_OVERRIDES = {"landing/hero": {"mp4": 2 * MB, "webm": 2 * MB}}
TOTAL_SERVED_BUDGET = 120 * MB
# PNG masters are served only for these ids (the docs plugin's `png` option)
SERVED_PNG = {"landing/social-card"}

DEFAULT_TOLERANCE = 0.0005
PIXELMATCH_THRESHOLD = 0.1
DURATION_TOLERANCE = 0.10
VIDEO_MAX_WIDTH = 1920
DEDUPE_FRAMES_MAX = 45
# Tapes run in real time (typing), clips can be a frame early or late: a frame of the new video matches if the old one
# shows it within 12 frames (0.4 s at 30 fps), nearest first
JITTER_FRAMES = (0, *(sign * k for k in range(1, 13) for sign in (-1, 1)))
# Video frames are compared at half their size (2x2 pixels averaged): the encoder's artifacts on detailed content
# (a test chart, zoomed tiles) differ between two encodes of the same frames, by up to 0.1% of the pixels
VIDEO_COMPARE_SCALE = 2


def log(*args: Any) -> None:
    print(*args, file=sys.stderr, flush=True)


class PublishError(Exception):
    pass


# ---------------------------------------------------------------------------------------------------------------------
# Tools

def tool(name: str) -> str:
    """The pinned binary from install-tools.sh, else the one in PATH"""
    pinned = TOOLS_BIN / name
    if pinned.exists():
        return str(pinned)
    found = shutil.which(name)
    if not found:
        raise PublishError(f"{name} is missing: run docs-media/install-tools.sh (or apt-get install ffmpeg)")
    return found


def run(*cmd: str | Path) -> str:
    result = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    if result.returncode != 0:
        raise PublishError(f"{Path(str(cmd[0])).name} failed ({result.returncode}): {' '.join(map(str, cmd))}\n{result.stderr[-3000:]}")
    return result.stdout


def tool_versions() -> dict[str, str]:
    versions = {}
    for name, args in [("oxipng", ["--version"]), ("avifenc", ["--version"]), ("cwebp", ["-version"]), ("ffmpeg", ["-version"])]:
        try:
            out = subprocess.run([tool(name), *args], capture_output=True, text=True).stdout.strip().splitlines()
            versions[name] = out[0] if out else "?"
        except PublishError:
            versions[name] = "missing"
    return versions


def ffprobe(path: Path) -> dict:
    out = run(tool("ffprobe"), "-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height,pix_fmt,codec_type",
              "-of", "json", path)
    return json.loads(out)


def video_info(path: Path) -> tuple[float, int, int, str, str]:
    info = ffprobe(path)
    stream = next(s for s in info["streams"] if s.get("codec_type") == "video")
    return float(info["format"]["duration"]), int(stream["width"]), int(stream["height"]), stream["codec_name"], stream.get("pix_fmt", "")


# ---------------------------------------------------------------------------------------------------------------------
# pixelmatch (https://github.com/mapbox/pixelmatch, ISC), ported to numpy with the same semantics:
# YIQ color distance, `threshold`, anti-aliased pixels detected and not counted (includeAA: false).

def _color_delta(a: np.ndarray, b: np.ndarray, k: np.ndarray, y_only: bool) -> np.ndarray:
    """a, b: (N, 4) float64 RGBA; k: (N,) byte offsets in img1 (for blending transparent pixels on a pattern)"""
    r1, g1, b1, a1 = a[:, 0], a[:, 1], a[:, 2], a[:, 3]
    r2, g2, b2, a2 = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    dr, dg, db, da = r1 - r2, g1 - g2, b1 - b2, a1 - a2
    blend = (a1 < 255) | (a2 < 255)
    if blend.any():
        rb = 48 + 159 * (k % 2)
        gb = 48 + 159 * (np.floor(k / 1.618033988749895) % 2)
        bb = 48 + 159 * (np.floor(k / 2.618033988749895) % 2)
        dr = np.where(blend, (r1 * a1 - r2 * a2 - rb * da) / 255, dr)
        dg = np.where(blend, (g1 * a1 - g2 * a2 - gb * da) / 255, dg)
        db = np.where(blend, (b1 * a1 - b2 * a2 - bb * da) / 255, db)
    same = (a == b).all(axis=1)
    y = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223
    if y_only:
        return np.where(same, 0.0, y)
    i = dr * 0.59597799 - dg * 0.27417610 - db * 0.32180189
    q = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694
    delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q
    return np.where(same, 0.0, np.where(y > 0, -delta, delta))


# pixelmatch visits the 8 neighbors with x in the outer loop, y in the inner one: the first extreme found wins
_NEIGHBORS = [(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (dx, dy) != (0, 0)]


def _has_many_siblings(img32: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    h, w = img32.shape
    zeroes = ((xs == 0) | (xs == w - 1) | (ys == 0) | (ys == h - 1)).astype(np.int32)
    center = img32[ys, xs]
    for dx, dy in _NEIGHBORS:
        nx, ny = xs + dx, ys + dy
        valid = (nx >= 0) & (nx < w) & (ny >= 0) & (ny < h)
        zeroes += valid & (img32[np.clip(ny, 0, h - 1), np.clip(nx, 0, w - 1)] == center)
    return zeroes > 2


def _antialiased(img: np.ndarray, img32: np.ndarray, other32: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    h, w = img32.shape
    n = len(xs)
    zeroes = ((xs == 0) | (xs == w - 1) | (ys == 0) | (ys == h - 1)).astype(np.int32)
    center = img[ys, xs]
    k = ((ys * w + xs) * 4).astype(np.float64)
    deltas = np.zeros((n, 8))
    valids = np.zeros((n, 8), dtype=bool)
    for j, (dx, dy) in enumerate(_NEIGHBORS):
        nx, ny = xs + dx, ys + dy
        valid = (nx >= 0) & (nx < w) & (ny >= 0) & (ny < h)
        neighbor = img[np.clip(ny, 0, h - 1), np.clip(nx, 0, w - 1)]
        deltas[:, j] = _color_delta(center, neighbor, k, y_only=True)
        valids[:, j] = valid
    zeroes += (valids & (deltas == 0)).sum(axis=1)
    darker = np.where(valids & (deltas < 0), deltas, np.inf)
    brighter = np.where(valids & (deltas > 0), deltas, -np.inf)
    min_j = darker.argmin(axis=1)
    max_j = brighter.argmax(axis=1)
    rows = np.arange(n)
    candidate = (zeroes <= 2) & np.isfinite(darker[rows, min_j]) & np.isfinite(brighter[rows, max_j])
    offsets = np.array(_NEIGHBORS)
    min_x, min_y = xs + offsets[min_j, 0], ys + offsets[min_j, 1]
    max_x, max_y = xs + offsets[max_j, 0], ys + offsets[max_j, 1]
    result = np.zeros(n, dtype=bool)
    idx = np.flatnonzero(candidate)
    if len(idx):
        darkest = _has_many_siblings(img32, min_x[idx], min_y[idx]) & _has_many_siblings(other32, min_x[idx], min_y[idx])
        brightest = _has_many_siblings(img32, max_x[idx], max_y[idx]) & _has_many_siblings(other32, max_x[idx], max_y[idx])
        result[idx] = darkest | brightest
    return result


def pixelmatch(img1: np.ndarray, img2: np.ndarray, threshold: float = PIXELMATCH_THRESHOLD, include_aa: bool = False,
               stop_after: int | None = None) -> int:
    """Number of different pixels between two (H, W, 4) uint8 RGBA images. With stop_after, counting stops (and returns
    a value above it) as soon as more pixels than that differ."""
    if img1.shape != img2.shape or img1.ndim != 3 or img1.shape[2] != 4:
        raise ValueError(f"images must be RGBA of the same size: {img1.shape} vs {img2.shape}")
    h, w, _ = img1.shape
    a8 = np.ascontiguousarray(img1, dtype=np.uint8)
    b8 = np.ascontiguousarray(img2, dtype=np.uint8)
    a32 = a8.view(np.uint32).reshape(h, w)
    b32 = b8.view(np.uint32).reshape(h, w)
    changed = np.flatnonzero(a32.reshape(-1) != b32.reshape(-1))
    if len(changed) == 0:
        return 0
    max_delta = 35215 * threshold * threshold
    a = a8.astype(np.float64)
    b = b8.astype(np.float64)
    diff = 0
    for start in range(0, len(changed), 250_000):
        chunk = changed[start:start + 250_000]
        ys, xs = chunk // w, chunk % w
        delta = _color_delta(a[ys, xs], b[ys, xs], (chunk * 4).astype(np.float64), y_only=False)
        over = np.abs(delta) > max_delta
        xs, ys = xs[over], ys[over]
        if include_aa:
            diff += len(xs)
        else:
            aa = _antialiased(a, a32, b32, xs, ys) | _antialiased(b, b32, a32, xs, ys)
            diff += int((~aa).sum())
        if stop_after is not None and diff > stop_after:
            return diff
    return diff


def load_rgba(path: Path) -> np.ndarray:
    from PIL import Image
    with Image.open(path) as im:
        return np.asarray(im.convert("RGBA"))


def same_image(new: np.ndarray, old: np.ndarray, tolerance: float, mask: list | None = None,
               scale: int = 1) -> tuple[bool, float]:
    """Whether at most `tolerance` of the pixels differ, and the share that does. The `mask`'s rectangles ([x, y, w, h]
    in pixels of the full-size image; the images are `scale` times smaller) don't count."""
    if new.shape != old.shape:
        return False, 1.0
    if mask:
        new = new.copy()
        for x, y, w, h in mask:
            x0, y0, x1, y1 = x // scale, y // scale, -(-(x + w) // scale), -(-(y + h) // scale)
            new[y0:y1, x0:x1] = old[y0:y1, x0:x1]
    allowed = int(tolerance * new.shape[0] * new.shape[1])
    diff = pixelmatch(new, old, stop_after=allowed)
    return diff <= allowed, diff / (new.shape[0] * new.shape[1])


def video_frame(path: Path, t: float, scale: int = 1) -> np.ndarray:
    """The frame at t seconds, RGBA, `scale` times smaller (each scale x scale block averaged)"""
    _, w, h, _, _ = video_info(path)
    raw = subprocess.run([tool("ffmpeg"), "-v", "error", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgba", "-"], capture_output=True)
    if raw.returncode != 0 or len(raw.stdout) < w * h * 4:
        raise PublishError(f"could not read the frame at {t:.2f}s of {path}: {raw.stderr.decode()[-500:]}")
    frame = np.frombuffer(raw.stdout[: w * h * 4], dtype=np.uint8).reshape(h, w, 4)
    if scale == 1:
        return frame
    h, w = h // scale * scale, w // scale * scale
    blocks = frame[:h, :w].reshape(h // scale, scale, w // scale, scale, 4).astype(np.float32)
    return np.round(blocks.mean(axis=(1, 3))).astype(np.uint8)


# ---------------------------------------------------------------------------------------------------------------------
# Encoding

@dataclass
class Encoded:
    id: str
    kind: str
    meta: dict
    files: dict[str, Path]                       # role -> local file: avif/webp/png or mp4/webm/poster/vtt
    width: int
    height: int
    lqip: str
    duration: float | None = None
    master: Path | None = None                   # what dedupe compares: the PNG master (stills)
    errors: list[str] = field(default_factory=list)
    status: str = ""                             # new, updated, unchanged
    diff: float | None = None
    entry: dict | None = None


def sha16(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()[:16]


def lqip(source: Path, work: Path) -> str:
    """A 16 px wide WebP, as a data URI"""
    out = work / "lqip.webp"
    run(tool("cwebp"), "-quiet", "-q", "40", "-m", "6", "-resize", "16", "0", source, "-o", out)
    return "data:image/webp;base64," + base64.b64encode(out.read_bytes()).decode()


def encode_still(id_: str, meta: dict, src: Path, work: Path) -> Encoded:
    png = work / "still.png"
    shutil.copyfile(src / meta.get("files", {}).get("still", "still.png"), png)
    run(tool("oxipng"), "-q", "-o", "4", "--strip", "safe", png)
    avif = work / "still.avif"
    run(tool("avifenc"), "-q", "60", "--yuv", "444", "-s", "4", "-j", "all", "--ignore-exif", "--ignore-xmp", png, avif)
    webp = work / "still.webp"
    run(tool("cwebp"), "-quiet", "-q", "82", "-m", "6", "-sharp_yuv", "-mt", "-metadata", "none", png, "-o", webp)
    from PIL import Image
    with Image.open(png) as im:
        px_w, px_h = im.size
    scale = meta.get("scale", 2)
    width, height = int(meta["width"]), int(meta["height"])
    if abs(px_w - width * scale) > 1 or abs(px_h - height * scale) > 1:
        raise PublishError(f"{id_}: still.png is {px_w}x{px_h}, meta.json says {width}x{height} at scale {scale}")
    return Encoded(id_, "still", meta, {"avif": avif, "webp": webp, "png": png}, width, height, lqip(png, work), master=png)


def frame_at(concat: Path, t: float | str) -> Path:
    """The frame file shown at time t (seconds) of a recording, from its ffconcat list"""
    entries: list[tuple[str, float]] = []
    lines = concat.read_text().splitlines()
    for i, line in enumerate(lines):
        if line.startswith("file "):
            name = line[5:].strip().strip("'")
            duration = float(lines[i + 1].split()[1]) if i + 1 < len(lines) and lines[i + 1].startswith("duration") else 0.0
            entries.append((name, duration))
    if not entries:
        raise PublishError(f"{concat} lists no frames")
    if t == "first":
        return concat.parent / entries[0][0]
    if t == "last":
        return concat.parent / entries[-1][0]
    elapsed = 0.0
    for name, duration in entries:
        if elapsed + duration > float(t):
            return concat.parent / name
        elapsed += duration
    return concat.parent / entries[-1][0]


def video_filters(meta: dict, frame_px: tuple[int, int]) -> str:
    """Crop to the clip's region (CSS px x scale), then at most 1920 px wide, even sizes"""
    scale = meta.get("scale", 2)
    filters = []
    region = meta.get("region")
    if region:
        x, y = round(region["x"] * scale), round(region["y"] * scale)
        w = min(round(region["width"] * scale), frame_px[0] - x)
        h = min(round(region["height"] * scale), frame_px[1] - y)
        if (x, y, w, h) != (0, 0, *frame_px):
            filters.append(f"crop={w}:{h}:{x}:{y}")
    filters.append(f"scale='trunc(min({VIDEO_MAX_WIDTH},iw)/2)*2':-2:flags=lanczos")
    return ",".join(filters)


def poster_from(image: Path, vf: str, work: Path) -> Path:
    png = work / "poster.png"
    run(tool("ffmpeg"), "-v", "error", "-y", "-i", image, "-vf", vf, "-frames:v", "1", png)
    poster = work / "poster.webp"
    run(tool("cwebp"), "-quiet", "-q", "80", "-m", "6", "-sharp_yuv", "-mt", "-metadata", "none", png, "-o", poster)
    return poster


def encode_clip(id_: str, meta: dict, src: Path, work: Path) -> Encoded:
    concat = src / meta.get("files", {}).get("concat", "frames.ffconcat")
    first = frame_at(concat, "first")
    from PIL import Image
    with Image.open(first) as im:
        frame_px = im.size
    vf = video_filters(meta, frame_px)
    common = ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", concat, "-an", "-map_metadata", "-1"]
    mp4 = work / "video.mp4"
    run(tool("ffmpeg"), *common, "-vf", f"{vf},fps=30,format=yuv420p", "-c:v", "libx264", "-profile:v", "high",
        "-crf", "26", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4)
    webm = work / "video.webm"
    run(tool("ffmpeg"), *common, "-vf", f"{vf},fps=30,format=yuv420p", "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0",
        "-row-mt", "1", "-cpu-used", "2", "-pix_fmt", "yuv420p", webm)
    poster_t = meta.get("poster", "last")
    poster = poster_from(frame_at(concat, poster_t if isinstance(poster_t, str) else poster_t / 1000), vf, work)
    files = {"mp4": mp4, "webm": webm, "poster": poster}
    captions = meta.get("files", {}).get("captions")
    if captions and (src / captions).exists():
        files["vtt"] = work / "captions.vtt"
        shutil.copyfile(src / captions, files["vtt"])
    duration, *_ = video_info(mp4)
    encoded = Encoded(id_, "clip", meta, files, int(meta["width"]), int(meta["height"]), lqip(poster, work),
                      duration=round(duration, 2))
    if meta.get("loop"):
        ok, share = same_image(load_rgba(frame_at(concat, "first")), load_rgba(frame_at(concat, "last")),
                               meta.get("dedupe_tolerance", DEFAULT_TOLERANCE))
        if not ok:
            encoded.errors.append(f"loop: the last frame differs from the first ({share:.2%} of the pixels)")
    return encoded


def encode_tape(id_: str, meta: dict, src: Path, work: Path) -> Encoded:
    """VHS already encoded tape.mp4 and tape.webm: keep them if browsers can play them, else re-encode"""
    files: dict[str, Path] = {}
    for ext, codec in [("mp4", "h264"), ("webm", "vp9")]:
        source = src / f"tape.{ext}"
        if not source.exists():
            raise PublishError(f"{id_}: {source} is missing")
        out = work / f"video.{ext}"
        _, _, _, source_codec, pix_fmt = video_info(source)
        if source_codec == codec and pix_fmt == "yuv420p":
            extra = ["-movflags", "+faststart"] if ext == "mp4" else []
            run(tool("ffmpeg"), "-v", "error", "-y", "-i", source, "-map", "0:v:0", "-c", "copy", "-an", "-map_metadata", "-1", *extra, out)
        elif ext == "mp4":
            run(tool("ffmpeg"), "-v", "error", "-y", "-i", source, "-an", "-map_metadata", "-1", "-c:v", "libx264", "-profile:v", "high",
                "-crf", "22", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out)
        else:
            run(tool("ffmpeg"), "-v", "error", "-y", "-i", source, "-an", "-map_metadata", "-1", "-c:v", "libvpx-vp9", "-crf", "34",
                "-b:v", "0", "-row-mt", "1", "-cpu-used", "2", "-pix_fmt", "yuv420p", out)
        files[ext] = out
    duration, w, h, _, _ = video_info(files["mp4"])
    poster_t = meta.get("poster", "last")
    frame = work / "frame.png"
    if poster_t == "last":
        run(tool("ffmpeg"), "-v", "error", "-y", "-sseof", "-0.5", "-i", files["mp4"], "-update", "1", frame)
    else:
        t = 0.0 if poster_t == "first" else float(poster_t) / 1000
        run(tool("ffmpeg"), "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", files["mp4"], "-frames:v", "1", frame)
    files["poster"] = poster_from(frame, "null", work)
    return Encoded(id_, "tape", meta, files, int(meta.get("width") or w), int(meta.get("height") or h), lqip(files["poster"], work),
                   duration=round(duration, 2))


def encode(id_: str, src: Path) -> Encoded:
    meta = json.loads((src / "meta.json").read_text())
    if meta.get("id", id_) != id_:
        raise PublishError(f"{src}/meta.json is for {meta.get('id')}, not {id_}")
    work = src / "publish"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    kind = meta.get("kind")
    if kind == "still":
        return encode_still(id_, meta, src, work)
    if kind == "clip":
        return encode_clip(id_, meta, src, work)
    if kind == "tape":
        return encode_tape(id_, meta, src, work)
    raise PublishError(f"{id_}: unknown kind {kind!r} in meta.json")


def check_budgets(e: Encoded) -> None:
    budget = {**BUDGETS[e.kind], **BUDGET_OVERRIDES.get(e.id, {})}
    for role, path in e.files.items():
        limit = budget.get(role)
        size = path.stat().st_size
        if limit and size > limit:
            e.errors.append(f"{role} is {size / KB:.0f} KB, over its {limit / KB:.0f} KB budget")
    if len(e.lqip) > budget["lqip"]:
        e.errors.append(f"the LQIP data URI is {len(e.lqip)} bytes, over its {budget['lqip']} bytes budget")
    if e.duration is not None:
        low, high = budget["duration"]
        if not low <= e.duration <= high:
            e.errors.append(f"lasts {e.duration:.1f} s, {e.kind}s last {low}-{high} s")


# ---------------------------------------------------------------------------------------------------------------------
# Storage: R2 through the S3 API. Object keys are the manifest keys, under base_url's path when it has one
# (https://host/test-prefix: objects at test-prefix/shots/...).

class Storage:
    def __init__(self, base_url: str, need_credentials: bool):
        self.base_url = base_url.rstrip("/")
        self.prefix = urllib.parse.urlparse(self.base_url).path.strip("/")
        self.client = None
        account = os.environ.get("R2_ACCOUNT_ID")
        if account and os.environ.get("R2_ACCESS_KEY_ID") and os.environ.get("R2_SECRET_ACCESS_KEY"):
            import boto3
            from botocore.config import Config
            self.client = boto3.client(
                "s3",
                endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
                region_name="auto",
                aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                config=Config(signature_version="s3v4", retries={"max_attempts": 6, "mode": "standard"},
                              request_checksum_calculation="when_required", response_checksum_validation="when_required"),
            )
        elif need_credentials:
            raise PublishError("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are needed to upload (or use --dry-run)")
        self.public_reachable: bool | None = None

    def object_key(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError
        try:
            self.client.head_object(Bucket=BUCKET, Key=self.object_key(key))
            return True
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def upload(self, key: str, path: Path) -> str:
        """Uploads a content-addressed file, never overwriting: returns 'uploaded' or 'exists'"""
        from botocore.exceptions import ClientError
        ext = key.rsplit(".", 1)[1]
        if self.exists(key):
            return "exists"
        try:
            with open(path, "rb") as body:
                self.client.put_object(Bucket=BUCKET, Key=self.object_key(key), Body=body, IfNoneMatch="*",
                                       ContentType=CONTENT_TYPES[ext], CacheControl=CACHE_CONTROL)
            return "uploaded"
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") in ("PreconditionFailed", "412"):
                return "exists"
            raise

    def fetch(self, key: str) -> Path:
        """A published file, from the local cache (the docs plugin's), the public URL, or the S3 API"""
        path = CACHE / key
        expected = Path(key).stem
        if path.exists() and sha16(path) == expected:
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        data = None
        if self.public_reachable is not False:
            try:
                # the CDN answers 403 to urllib's default User-Agent
                request = urllib.request.Request(f"{self.base_url}/{key}", headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(request, timeout=15) as response:
                    data = response.read()
                self.public_reachable = True
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                if self.public_reachable is None:
                    log(f"  {self.base_url} isn't reachable ({error}), downloading through the S3 API")
                self.public_reachable = False
        if data is None:
            if not self.client:
                raise PublishError(f"can't download {key}: {self.base_url} isn't reachable and there are no R2 credentials")
            data = self.client.get_object(Bucket=BUCKET, Key=self.object_key(key))["Body"].read()
        tmp.write_bytes(data)
        if sha16(tmp) != expected:
            tmp.unlink()
            raise PublishError(f"{key}: the downloaded file doesn't match its hash")
        tmp.replace(path)
        return path


# ---------------------------------------------------------------------------------------------------------------------
# Dedupe and manifest

def key_for(id_: str, path: Path) -> str:
    return f"shots/{id_}/{sha16(path)}.{path.suffix.lstrip('.')}"


def unchanged(e: Encoded, old: dict | None, storage: Storage) -> tuple[bool, float | None, str]:
    """Whether the new capture is within the dedupe tolerance of the published one"""
    if not old:
        return False, None, "new"
    if old["kind"] != e.kind or (old["width"], old["height"]) != (e.width, e.height):
        return False, None, "size or kind changed"
    if (e.meta.get("revision") or 0) != (old.get("revision") or 0):
        return False, None, f"revision {old.get('revision') or 0} -> {e.meta.get('revision') or 0}"
    tolerance = float(e.meta.get("dedupe_tolerance", DEFAULT_TOLERANCE))
    mask = e.meta.get("dedupe_mask")
    if e.kind == "still":
        same, share = same_image(load_rgba(e.master), load_rgba(storage.fetch(old["files"]["png"]["key"])), tolerance, mask)
        return same, share, f"{share:.4%} of the pixels differ"
    old_duration = old.get("duration") or 0
    if not old_duration or abs(e.duration - old_duration) > DURATION_TOLERANCE * old_duration:
        return False, None, f"duration {old_duration} s -> {e.duration} s"
    same, share = same_image(load_rgba(e.files["poster"]), load_rgba(storage.fetch(old["files"]["poster"]["key"])), tolerance,
                             mask)
    if not same:
        return False, share, f"poster: {share:.4%} of the pixels differ"
    old_mp4 = storage.fetch(old["files"]["mp4"]["key"])
    worst = share
    for t in [s + 0.5 for s in range(min(int(min(e.duration, old_duration)), DEDUPE_FRAMES_MAX))]:
        new_frame = video_frame(e.files["mp4"], t, VIDEO_COMPARE_SCALE)
        # the same action can land a frame or two earlier or later
        closest = 1.0
        for jitter in JITTER_FRAMES:
            old_frame = video_frame(old_mp4, max(0.0, t + jitter / 30), VIDEO_COMPARE_SCALE)
            same, share = same_image(new_frame, old_frame, tolerance, mask, VIDEO_COMPARE_SCALE)
            closest = min(closest, share)
            if same:
                break
        worst = max(worst, closest)
        if not same:
            return False, closest, f"frame at {t:.1f} s: {closest:.4%} of the pixels differ"
    return True, worst, f"at most {worst:.4%} of the pixels differ"


def text_fields(meta: dict) -> dict:
    """What a spec can change without a new capture"""
    fields = {"alt": meta["alt"], "project": meta.get("project"), "source_spec": meta["source_spec"]}
    if meta.get("caption"):
        fields["caption"] = meta["caption"]
    return fields


def build_entry(e: Encoded) -> dict:
    meta = e.meta
    entry: dict[str, Any] = {
        "kind": e.kind,
        "files": {role: {"key": key_for(e.id, path), "bytes": path.stat().st_size} for role, path in sorted(e.files.items())},
        "width": e.width,
        "height": e.height,
        "lqip": e.lqip,
        "alt": meta["alt"],
        "project": meta.get("project"),
        "captured": str(meta.get("captured") or dt.date.today().isoformat())[:10],
        "app_version": meta["app_version"],
        "source_spec": meta["source_spec"],
    }
    if meta.get("caption"):
        entry["caption"] = meta["caption"]
    if e.duration is not None:
        entry["duration"] = e.duration
    if meta.get("revision"):
        entry["revision"] = meta["revision"]
    if meta.get("anchors") and e.kind != "tape":
        entry["anchors"] = meta["anchors"]
    return entry


def served_bytes(manifest: dict) -> int:
    total = 0
    for id_, entry in manifest["shots"].items():
        for role, f in entry["files"].items():
            if role != "png" or id_ in SERVED_PNG:
                total += f["bytes"]
    return total


def validate(manifest: dict) -> None:
    import jsonschema
    schema = json.loads(SCHEMA.read_text())
    validator = jsonschema.Draft202012Validator(schema, format_checker=jsonschema.Draft202012Validator.FORMAT_CHECKER)
    errors = sorted(validator.iter_errors(manifest), key=lambda e: list(e.absolute_path))
    if errors:
        raise PublishError("the manifest isn't valid against website/media.schema.json:\n" + "\n".join(
            f"  {'/'.join(map(str, e.absolute_path))}: {e.message[:300]}" for e in errors[:20]))


def dump_manifest(manifest: dict) -> str:
    return json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def shot_list() -> dict[str, dict]:
    import yaml
    if not SHOTS_YAML.exists():
        return {}
    return {s["id"]: s for s in yaml.safe_load(SHOTS_YAML.read_text()).get("shots", [])}


def selected(id_: str, only: str | None) -> bool:
    if not only or only.strip() in ("", "*"):
        return True
    return any(fnmatch.fnmatchcase(id_, g.strip()) for g in only.split(",") if g.strip())


def find_captures(out: Path, only: str | None) -> dict[str, Path]:
    captures = {}
    for meta in sorted(out.glob("*/*/meta.json")):
        id_ = f"{meta.parent.parent.name}/{meta.parent.name}"
        if ID_RE.match(id_) and selected(id_, only):
            captures[id_] = meta.parent
    return captures


# ---------------------------------------------------------------------------------------------------------------------
# Gallery: before/after for the PR comment (published URLs) and a local HTML page (workflow artifact)

def preview_role(entry: dict) -> str:
    return "webp" if entry["kind"] == "still" else "poster"


def write_gallery(results: list[Encoded], old_manifest: dict, storage: Storage, out: Path) -> None:
    gallery = out / "gallery"
    shutil.rmtree(gallery, ignore_errors=True)
    gallery.mkdir(parents=True)
    rows_html, rows_md = [], []
    for e in results:
        old = old_manifest["shots"].get(e.id)
        new_file = e.files.get("webp") or e.files.get("poster")
        after = f"{e.id.replace('/', '--')}--after{new_file.suffix}"
        shutil.copyfile(new_file, gallery / after)
        before = ""
        if old:
            try:
                old_file = storage.fetch(old["files"][preview_role(old)]["key"])
                before = f"{e.id.replace('/', '--')}--before{old_file.suffix}"
                shutil.copyfile(old_file, gallery / before)
            except Exception as error:  # the gallery is best effort
                log(f"  gallery: no before image for {e.id}: {error}")
        diff = "" if e.diff is None else f"{e.diff:.3%}"
        status = e.status + (f" ({'; '.join(e.errors)})" if e.errors else "")
        before_html = f'<img src="{before}">' if before else "—"
        rows_html.append(
            f"<tr><td><code>{html.escape(e.id)}</code><br>{html.escape(status)}<br>{diff}</td>"
            f'<td>{before_html}</td><td><img src="{after}"></td></tr>')
        if e.status in ("new", "updated") and e.entry:
            new_url = f"{storage.base_url}/{e.entry['files'][preview_role(e.entry)]['key']}"
            old_url = f"{storage.base_url}/{old['files'][preview_role(old)]['key']}" if old else None
            img = lambda url: f'<img src="{url}" width="360">'  # noqa: E731
            rows_md.append(f"| `{e.id}` {e.status} {diff} | {img(old_url) if old_url else '—'} | {img(new_url)} |")
    (gallery / "index.html").write_text(
        "<!doctype html><meta charset=utf-8><title>docs-media gallery</title>"
        "<style>body{font-family:system-ui,sans-serif;margin:24px}td{vertical-align:top;padding:8px;border-bottom:1px solid #ddd}"
        "img{max-width:640px;border:1px solid #ccc}</style><table><tr><th>Shot</th><th>Before</th><th>After</th></tr>"
        + "".join(rows_html) + "</table>\n")
    md = ["### Docs media", ""]
    if rows_md:
        md += ["| Shot | Before | After |", "|---|---|---|", *rows_md]
    else:
        md.append("No shot changed beyond the dedupe tolerance.")
    unchanged_ids = [e.id for e in results if e.status == "unchanged"]
    if unchanged_ids:
        md += ["", f"Unchanged: {', '.join(f'`{i}`' for i in unchanged_ids)}"]
    (out / "gallery.md").write_text("\n".join(md) + "\n")


# ---------------------------------------------------------------------------------------------------------------------
# publish

def publish(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest)
    old_manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else \
        {"$schema": "./media.schema.json", "version": 1, "base_url": args.base_url or DEFAULT_BASE_URL, "shots": {}}
    base_url = (args.base_url or old_manifest["base_url"]).rstrip("/")
    if base_url != old_manifest["base_url"].rstrip("/") and old_manifest["shots"]:
        raise PublishError(f"--base-url {base_url} differs from the manifest's {old_manifest['base_url']}, which has entries")
    storage = Storage(base_url, need_credentials=not args.dry_run)
    out = Path(args.out)
    captures = find_captures(out, args.only)
    if not captures:
        log(f"No capture in {out} matches {args.only or '*'}")
        return 0
    planned = shot_list()
    log(f"Encoders: {json.dumps(tool_versions())}")

    results: list[Encoded] = []
    for id_, src in captures.items():
        log(f"{id_}: encoding")
        if planned and id_ not in planned:
            log(f"  warning: {id_} isn't in docs-media/shots.yaml")
        if planned.get(id_, {}).get("status") == "retired":
            raise PublishError(f"{id_} is retired in shots.yaml: pick a new id")
        try:
            e = encode(id_, src)
        except PublishError as error:
            e = Encoded(id_, "?", {}, {}, 0, 0, "", errors=[str(error)])
            results.append(e)
            continue
        check_budgets(e)
        missing = set(planned.get(id_, {}).get("anchors") or []) - set(e.meta.get("anchors") or {})
        if missing:
            e.errors.append(f"shots.yaml lists anchors the capture didn't record: {', '.join(sorted(missing))} (ui.anchor())")
        sizes = ", ".join(f"{role} {p.stat().st_size / KB:.0f} KB" for role, p in e.files.items())
        log(f"  {sizes}, lqip {len(e.lqip)} B" + (f", {e.duration} s" if e.duration else ""))
        results.append(e)

    failed = [e for e in results if e.errors]
    if failed:
        for e in failed:
            log(f"ERROR {e.id}: " + "; ".join(e.errors))
        log("Nothing was uploaded.")
        return 1

    new_manifest = json.loads(json.dumps(old_manifest))
    new_manifest["base_url"] = base_url
    for e in results:
        old = old_manifest["shots"].get(e.id)
        same, share, why = unchanged(e, old, storage)
        e.diff = share
        if same:
            e.status = "unchanged"
            # the published files, with the spec's current texts
            e.entry = {**old, **text_fields(e.meta)}
            new_manifest["shots"][e.id] = e.entry
        else:
            e.status = "updated" if old else "new"
            e.entry = build_entry(e)
            new_manifest["shots"][e.id] = e.entry
        log(f"{e.id}: {e.status} ({why})")

    validate(new_manifest)
    total = served_bytes(new_manifest)
    log(f"Served files: {total / MB:.1f} MB in total (budget {TOTAL_SERVED_BUDGET / MB:.0f} MB)")
    if total > TOTAL_SERVED_BUDGET:
        raise PublishError(f"the published media would weigh {total / MB:.1f} MB, over the {TOTAL_SERVED_BUDGET / MB:.0f} MB budget")

    changed = [e for e in results if e.status in ("new", "updated")]
    if args.dry_run:
        log(f"Dry run: {len(changed)} shots would be uploaded, website/media.json isn't written")
    else:
        for e in changed:
            for role, path in e.files.items():
                key = e.entry["files"][role]["key"]
                log(f"  {storage.upload(key, path)}: {key}")
        if dump_manifest(new_manifest) != dump_manifest(old_manifest) or not manifest_path.exists():
            manifest_path.write_text(dump_manifest(new_manifest))
            log(f"Wrote {manifest_path}")

    write_gallery(results, old_manifest, storage, out)
    report = {
        "changed": [e.id for e in changed],
        "unchanged": [e.id for e in results if e.status == "unchanged"],
        "dry_run": args.dry_run,
        "served_bytes": total,
        "shots": {e.id: {"status": e.status, "diff": e.diff, "files": {r: p.stat().st_size for r, p in e.files.items()}}
                  for e in results},
    }
    (out / "publish-report.json").write_text(json.dumps(report, indent=2) + "\n")
    log(f"{len(changed)} changed, {len(results) - len(changed)} unchanged. Gallery: {out / 'gallery' / 'index.html'}")
    return 0


# ---------------------------------------------------------------------------------------------------------------------
# gc: R2 lifecycle rules can't see references

def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True, check=True).stdout


def referenced_keys(working_tree: Path, days: int, include_prs: bool) -> tuple[set[str], list[str]]:
    keys: set[str] = set()
    sources: list[str] = []

    def add(name: str, text: str | None) -> None:
        if text is None:
            return
        try:
            manifest = json.loads(text)
        except json.JSONDecodeError:
            log(f"  warning: {name}: website/media.json isn't valid JSON")
            return
        for entry in manifest.get("shots", {}).values():
            keys.update(f["key"] for f in entry.get("files", {}).values())
        sources.append(name)

    add(str(working_tree.relative_to(REPO) if working_tree.is_relative_to(REPO) else working_tree),
        working_tree.read_text() if working_tree.exists() else None)
    try:
        add("origin/master", git("show", "origin/master:website/media.json"))
    except subprocess.CalledProcessError as error:
        raise PublishError(f"can't read website/media.json on origin/master: {error.stderr.strip()} (git fetch origin master)") from None
    cutoff = dt.datetime.now(dt.timezone.utc).timestamp() - days * 86400
    for line in git("for-each-ref", "--format=%(refname:short) %(creatordate:unix)", "refs/tags/v*").splitlines():
        tag, created = line.rsplit(" ", 1)
        if int(created) >= cutoff:
            try:
                add(tag, git("show", f"{tag}:website/media.json"))
            except subprocess.CalledProcessError:
                pass  # older releases have no manifest
    if include_prs:
        try:
            repo = os.environ.get("GITHUB_REPOSITORY") or json.loads(subprocess.run(
                ["gh", "repo", "view", "--json", "nameWithOwner"], capture_output=True, text=True, check=True, cwd=REPO,
            ).stdout)["nameWithOwner"]
            listing = subprocess.run(["gh", "api", "--paginate", f"repos/{repo}/pulls?state=open&per_page=100",
                                      "--jq", ".[] | {number, headRefOid: .head.sha}"], capture_output=True, text=True, check=True)
            prs = [json.loads(line) for line in listing.stdout.splitlines() if line.strip()]
        except (subprocess.CalledProcessError, FileNotFoundError) as error:
            detail = getattr(error, "stderr", "") or str(error)
            raise PublishError(f"can't list the open pull requests with gh ({detail.strip()}): set GITHUB_REPOSITORY and "
                               "GH_TOKEN, or pass --no-prs") from None
        for pr in prs:
            result = subprocess.run(["gh", "api", "-H", "Accept: application/vnd.github.raw",
                                     f"repos/{repo}/contents/website/media.json?ref={pr['headRefOid']}"], capture_output=True, text=True)
            add(f"PR #{pr['number']}", result.stdout if result.returncode == 0 else None)
    return keys, sources


def gc(args: argparse.Namespace) -> int:
    manifest = json.loads(Path(args.manifest).read_text())
    storage = Storage(args.base_url or manifest["base_url"], need_credentials=True)
    keys, sources = referenced_keys(Path(args.manifest).resolve(), args.days, include_prs=not args.no_prs)
    log(f"{len(keys)} keys referenced by {len(sources)} manifests: {', '.join(sources)}")
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.days)
    prefix = storage.object_key("shots/")
    doomed, kept, total = [], 0, 0
    for page in storage.client.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            total += 1
            key = obj["Key"][len(storage.object_key("")):] if storage.prefix else obj["Key"]
            if key in keys or obj["LastModified"] > cutoff:
                kept += 1
            else:
                doomed.append(obj["Key"])
    log(f"{total} objects under {prefix}: {kept} kept, {len(doomed)} unreferenced for over {args.days} days")
    for key in doomed:
        log(f"  {'would delete' if args.dry_run else 'delete'} {key}")
    if not args.dry_run:
        for start in range(0, len(doomed), 1000):
            batch = [{"Key": k} for k in doomed[start:start + 1000]]
            result = storage.client.delete_objects(Bucket=BUCKET, Delete={"Objects": batch, "Quiet": True})
            for error in result.get("Errors", []):
                log(f"  ERROR deleting {error['Key']}: {error['Message']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=os.environ.get("DOCS_MEDIA_BASE_URL"),
                        help="public origin of the bucket (default: the manifest's base_url). A path is a key prefix in the bucket")
    sub = parser.add_subparsers(dest="command")
    parser.add_argument("--only", help="comma-separated globs over shot ids, e.g. 'commit/*,history/*'")
    parser.add_argument("--dry-run", action="store_true", help="encode, check and compare, but upload and write nothing")
    parser.add_argument("--out", default=str(OUT), help="the captures (default docs-media/out)")
    parser.add_argument("--manifest", default=str(MANIFEST), help="default website/media.json")
    gc_parser = sub.add_parser("gc", help="delete objects under shots/ that no manifest references, older than --days")
    gc_parser.add_argument("--dry-run", action="store_true")
    gc_parser.add_argument("--days", type=int, default=90)
    gc_parser.add_argument("--no-prs", action="store_true", help="don't look at open pull requests (needs gh otherwise)")
    args = parser.parse_args()
    try:
        return gc(args) if args.command == "gc" else publish(args)
    except PublishError as error:
        log(f"ERROR: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
