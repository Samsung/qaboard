#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "boto3==1.43.100",
#   "jsonschema==4.26.0",
#   "numpy==2.5.3",
#   "pillow==12.3.0",
#   "pyyaml==6.0.3",
#   "pytest==8.4.2",
# ]
# ///
"""
Tests of publish.py on synthetic captures, without network: encoding, budgets, the pixelmatch port, the manifest.
  uv run docs-media/test_publish.py
The encoders must be installed (docs-media/install-tools.sh, ffmpeg).
"""
from __future__ import annotations

import importlib.util
import json
import sys
from argparse import Namespace
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("publish", HERE / "publish.py")
publish = importlib.util.module_from_spec(spec)
sys.modules["publish"] = publish
spec.loader.exec_module(publish)
VALIDATE = publish.validate

T0 = "2026-10-08T16:00:00.000Z"


def ui_image(width: int, height: int, label_x: int = 40, accent=(45, 114, 210)) -> Image.Image:
    """Something like an app page: flat colors, boxes and anti-aliased shapes"""
    im = Image.new("RGB", (width, height), (246, 247, 249))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, width, 56), fill=(28, 33, 39))
    for row in range(6):
        y = 100 + row * 110
        d.rounded_rectangle((40, y, width - 40, y + 90), radius=8, fill=(255, 255, 255), outline=(220, 224, 229))
        d.ellipse((60, y + 20, 110, y + 70), fill=accent)
        d.text((label_x + 100, y + 35), f"Run {row}: PSNR 31.{row} dB", fill=(28, 33, 39))
    return im


def still_capture(out: Path, id_: str, image: Image.Image, scale: int = 2, **meta) -> Path:
    folder = out / id_
    folder.mkdir(parents=True)
    image.save(folder / "still.png")
    (folder / "meta.json").write_text(json.dumps({
        "id": id_, "kind": "still", "alt": "A synthetic page with six run cards.", "caption": "Synthetic.",
        "project": "image-quality", "app_version": "1.1.1+0000000", "source_spec": "docs-media/shots/commit.spec.ts",
        "captured": "2026-10-12T10:00:00Z", "t0": T0, "dedupe_tolerance": 0.0005,
        "width": image.width // scale, "height": image.height // scale, "scale": scale, "anchors": {},
        "files": {"still": "still.png"}, **meta,
    }))
    return folder


def clip_capture(out: Path, id_: str, seconds: float, size=(1440, 900), loop=False) -> Path:
    """Frames at irregular times, like the CDP screencast: a box moving across the page"""
    folder = out / id_
    (folder / "frames").mkdir(parents=True)
    lines = ["ffconcat version 1.0"]
    times = [0.0]
    while times[-1] < seconds:
        times.append(times[-1] + (0.016 if len(times) % 7 else 0.4))
    n = len(times) - 1
    for i in range(n):
        im = ui_image(*size)
        x = int(100 + 1000 * (i / n if not loop else (1 - abs(2 * i / (n - 1) - 1))))
        ImageDraw.Draw(im).ellipse((x, 400, x + 30, 430), fill=(17, 20, 24))
        im.save(folder / "frames" / f"{i:05d}.jpg", quality=92)
        lines += [f"file 'frames/{i:05d}.jpg'", f"duration {times[i + 1] - times[i]:.6f}"]
    lines.append(f"file 'frames/{n - 1:05d}.jpg'")
    (folder / "frames.ffconcat").write_text("\n".join(lines) + "\n")
    (folder / "captions.vtt").write_text("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nA box moves\n")
    (folder / "meta.json").write_text(json.dumps({
        "id": id_, "kind": "clip", "alt": "A box moves across a synthetic page.", "project": "image-quality",
        "app_version": "1.1.1+0000000", "source_spec": "docs-media/shots/commit.spec.ts", "captured": "2026-10-12T10:00:00Z",
        "t0": T0, "dedupe_tolerance": 0.0005, "width": size[0] // 2, "height": size[1] // 2, "scale": 2,
        "region": {"x": 0, "y": 0, "width": size[0] // 2, "height": size[1] // 2}, "duration": seconds, "poster": "last",
        "loop": loop, "anchors": {"box": {"x": 10, "y": 20, "w": 30, "h": 5}},
        "files": {"concat": "frames.ffconcat", "captions": "captions.vtt"},
    }))
    return folder


def rgba(im: Image.Image) -> np.ndarray:
    return np.asarray(im.convert("RGBA"))


# --- pixelmatch ---------------------------------------------------------------------------------------------------

def test_pixelmatch_identical_and_changed():
    a = ui_image(400, 300)
    assert publish.pixelmatch(rgba(a), rgba(a)) == 0
    b = a.copy()
    ImageDraw.Draw(b).rectangle((10, 10, 29, 29), fill=(205, 66, 70))
    assert publish.pixelmatch(rgba(a), rgba(b)) == 400


def test_pixelmatch_ignores_antialiasing():
    a = Image.new("RGB", (60, 60), (255, 255, 255))
    ImageDraw.Draw(a).ellipse((10, 10, 50, 50), fill=(0, 0, 0))
    big = a.resize((600, 600), Image.LANCZOS).resize((60, 60), Image.LANCZOS)  # same shape, different edge pixels
    with_aa = publish.pixelmatch(rgba(a), rgba(big), include_aa=True)
    without_aa = publish.pixelmatch(rgba(a), rgba(big))
    assert without_aa < with_aa


def test_pixelmatch_threshold_and_stop_after():
    a = ui_image(400, 300)
    lighter = Image.fromarray(np.clip(np.asarray(a).astype(int) + 3, 0, 255).astype(np.uint8))
    assert publish.pixelmatch(rgba(a), rgba(lighter)) == 0  # under the 0.1 threshold
    noise = Image.fromarray(np.random.default_rng(0).integers(0, 256, (300, 400, 3), dtype=np.uint8))
    assert publish.pixelmatch(rgba(a), rgba(noise), stop_after=100) > 100


def test_same_image_tolerance():
    a = ui_image(400, 300)
    b = a.copy()
    ImageDraw.Draw(b).point((200, 150), fill=(255, 0, 0))
    assert publish.same_image(rgba(a), rgba(b), 0.0005) == (True, pytest.approx(1 / 120000))
    assert publish.same_image(rgba(a), rgba(ui_image(400, 301)), 0.0005) == (False, 1.0)


def test_same_image_mask():
    # a measured time changes between two recordings of a tape: its rectangle doesn't count, the rest still does
    a = ui_image(400, 300)
    b = a.copy()
    ImageDraw.Draw(b).rectangle((300, 20, 360, 40), fill=(255, 0, 0))
    assert not publish.same_image(rgba(a), rgba(b), 0.0005)[0]
    assert publish.same_image(rgba(a), rgba(b), 0.0005, [[295, 15, 70, 30]]) == (True, 0)
    ImageDraw.Draw(b).rectangle((20, 200, 60, 220), fill=(255, 0, 0))
    assert not publish.same_image(rgba(a), rgba(b), 0.0005, [[295, 15, 70, 30]])[0]
    # on frames compared at half their size, the mask is in pixels of the full-size frame
    half = lambda im: np.asarray(im.convert("RGBA").resize((200, 150), Image.BOX))  # noqa: E731
    c = a.copy()
    ImageDraw.Draw(c).rectangle((300, 20, 360, 40), fill=(255, 0, 0))
    assert publish.same_image(half(a), half(c), 0.0005, [[295, 15, 70, 30]], scale=2) == (True, 0)


def test_video_frames_compared_at_half_size(tmp_path):
    folder = clip_capture(tmp_path / "out", "commit/half", 6.5, size=(320, 200))
    work = tmp_path / "work"
    work.mkdir()
    e = publish.encode_clip("commit/half", json.loads((folder / "meta.json").read_text()), folder, work)
    full = publish.video_frame(e.files["mp4"], 1.0)
    half = publish.video_frame(e.files["mp4"], 1.0, publish.VIDEO_COMPARE_SCALE)
    assert half.shape == (full.shape[0] // 2, full.shape[1] // 2, 4)
    assert abs(int(half[10, 10, 0]) - int(full[20:22, 20:22, 0].mean())) <= 1


# --- encoding, budgets, manifest ------------------------------------------------------------------------------------

def run_publish(tmp_path: Path, manifest: Path | None = None, **kwargs) -> int:
    manifest = manifest or tmp_path / "media.json"
    if not manifest.exists():
        manifest.write_text(json.dumps({"$schema": "./media.schema.json", "version": 1,
                                        "base_url": "https://qaboard-media.sivoov.app", "shots": {}}))
    args = Namespace(base_url=None, only=None, dry_run=True, out=str(tmp_path / "out"), manifest=str(manifest), **kwargs)
    return publish.publish(args)


def test_publish_still_and_clip(tmp_path, monkeypatch):
    out = tmp_path / "out"
    still_capture(out, "commit/synthetic", ui_image(2880, 1800))
    clip_capture(out, "commit/synthetic-clip", 6.5)
    built = {}
    original = publish.build_entry
    monkeypatch.setattr(publish, "build_entry", lambda e: built.setdefault(e.id, original(e)))
    assert run_publish(tmp_path) == 0
    still, clip = built["commit/synthetic"], built["commit/synthetic-clip"]
    assert (still["width"], still["height"], still["kind"]) == (1440, 900, "still")
    assert set(still["files"]) == {"avif", "webp", "png"}
    assert still["files"]["avif"]["key"].startswith("shots/commit/synthetic/") and still["files"]["avif"]["key"].endswith(".avif")
    assert still["lqip"].startswith("data:image/webp;base64,") and len(still["lqip"]) <= 1000
    assert still["captured"] == "2026-10-12"
    assert set(clip["files"]) == {"mp4", "webm", "poster", "vtt"}
    assert clip["duration"] == pytest.approx(6.5, abs=0.1)
    assert clip["anchors"] == {"box": {"x": 10, "y": 20, "w": 30, "h": 5}}
    duration, width, height, codec, pix_fmt = publish.video_info(out / "commit/synthetic-clip/publish/video.mp4")
    assert (width, height, codec, pix_fmt) == (1440, 900, "h264", "yuv420p")
    report = json.loads((out / "publish-report.json").read_text())
    assert sorted(report["changed"]) == ["commit/synthetic", "commit/synthetic-clip"]
    assert (out / "gallery" / "index.html").exists() and "commit/synthetic" in (out / "gallery.md").read_text()
    manifest = {"$schema": "./media.schema.json", "version": 1, "base_url": "https://qaboard-media.sivoov.app", "shots": built}
    publish.validate(manifest)
    text = publish.dump_manifest(manifest)
    assert text.endswith("}\n") and text.index('"$schema"') < text.index('"base_url"') < text.index('"shots"') < text.index('"version"')


def test_budgets_stop_everything(tmp_path):
    out = tmp_path / "out"
    noise = Image.fromarray(np.random.default_rng(1).integers(0, 256, (1000, 1600, 3), dtype=np.uint8))
    still_capture(out, "commit/noisy", noise)
    clip_capture(out, "commit/short", 3.0)
    manifest = tmp_path / "media.json"
    assert run_publish(tmp_path, manifest) == 1
    assert json.loads(manifest.read_text())["shots"] == {}
    assert not (out / "publish-report.json").exists()


def test_still_size_must_match_meta(tmp_path):
    out = tmp_path / "out"
    still_capture(out, "commit/wrong-size", ui_image(1000, 600), width=1440, height=900)
    assert run_publish(tmp_path) == 1


def test_loop_must_end_where_it_starts(tmp_path):
    out = tmp_path / "out"
    clip_capture(out, "landing/not-a-loop", 6.5)
    folder = clip_capture(out, "landing/loop", 6.5, loop=True)
    encoded = publish.encode("landing/loop", folder)
    assert encoded.errors == []
    encoded = publish.encode("landing/not-a-loop", out / "landing/not-a-loop")
    meta = json.loads((out / "landing/not-a-loop/meta.json").read_text())
    meta["loop"] = True
    (out / "landing/not-a-loop/meta.json").write_text(json.dumps(meta))
    assert any("loop" in e for e in publish.encode("landing/not-a-loop", out / "landing/not-a-loop").errors)


def test_selection_and_frames(tmp_path):
    folder = clip_capture(tmp_path / "out", "commit/frames", 6.5)
    concat = folder / "frames.ffconcat"
    assert publish.frame_at(concat, "first").name == "00000.jpg"
    assert publish.frame_at(concat, "last") == publish.frame_at(concat, 999)
    assert publish.frame_at(concat, 0.5).name != "00000.jpg"
    assert publish.selected("commit/frames", "commit/*,logs/*") and not publish.selected("logs/crash", "commit/*")
    assert list(publish.find_captures(tmp_path / "out", "commit/fr*")) == ["commit/frames"]
    meta = {"scale": 2, "region": {"x": 10, "y": 20, "width": 300, "height": 200}}
    assert publish.video_filters(meta, (2880, 1800)).startswith("crop=600:400:20:40,")
    assert not publish.video_filters({"scale": 2, "region": {"x": 0, "y": 0, "width": 1440, "height": 900}}, (2880, 1800)).startswith("crop")



def dark_image(width: int, height: int) -> Image.Image:
    """The same page in a dark theme"""
    im = ui_image(width, height)
    return Image.fromarray(255 - np.asarray(im))


def test_dark_variant(tmp_path, monkeypatch):
    out = tmp_path / "out"
    still_capture(out, "commit/themed", ui_image(2880, 1800))
    still_capture(out / "commit/themed", "dark", dark_image(2880, 1800), id="commit/themed")
    # a template with no dark theme: the dark capture is the light one
    still_capture(out, "ci/no-dark", ui_image(1600, 1000))
    still_capture(out / "ci/no-dark", "dark", ui_image(1600, 1000), id="ci/no-dark")
    assert list(publish.find_captures(out, None, "dark")) == ["ci/no-dark", "commit/themed"]
    assert list(publish.find_captures(out, None)) == ["ci/no-dark", "commit/themed"]
    manifests = []
    monkeypatch.setattr(publish, "validate", lambda m: manifests.append(m) or VALIDATE(m))
    assert run_publish(tmp_path) == 0
    shots = manifests[-1]["shots"]
    dark = shots["commit/themed"]["dark"]
    assert set(dark) == {"files", "lqip"} and set(dark["files"]) == {"avif", "webp", "png"}
    assert dark["files"]["png"]["key"] != shots["commit/themed"]["files"]["png"]["key"]
    assert "dark" not in shots["ci/no-dark"]
    report = json.loads((out / "publish-report.json").read_text())
    assert report["shots"]["ci/no-dark (dark)"]["status"] == "same as light"
    assert report["shots"]["commit/themed (dark)"]["status"] == "new"
    assert publish.served_bytes(manifests[-1]) == sum(
        f["bytes"] for e in shots.values() for f in publish.entry_files(e) if not f["key"].endswith(".png"))


def test_dark_capture_must_match_the_light_one(tmp_path):
    out = tmp_path / "out"
    still_capture(out, "commit/themed", ui_image(2880, 1800))
    still_capture(out / "commit/themed", "dark", dark_image(2880, 1600), id="commit/themed")
    with pytest.raises(publish.PublishError, match="they must match"):
        run_publish(tmp_path)
    # and a dark capture alone has nothing to be a variant of
    (out / "commit/themed/meta.json").unlink()
    with pytest.raises(publish.PublishError, match="no light capture"):
        run_publish(tmp_path)


def test_dark_capture_waits_when_its_light_one_failed(tmp_path):
    # the light capture is published at 1440x900; this run only has a dark one, of another size (the page changed)
    out = tmp_path / "out"
    manifest = tmp_path / "media.json"
    entry = {"kind": "still", "width": 1440, "height": 900, "lqip": "data:image/webp;base64,AA==", "alt": "A synthetic page with six run cards.",
             "project": "image-quality", "captured": "2026-10-12", "app_version": "1.1.1+0000000",
             "source_spec": "docs-media/shots/commit.spec.ts",
             "files": {r: {"key": f"shots/commit/themed/{'0' * 16}.{r}", "bytes": 1} for r in ("avif", "webp", "png")}}
    manifest.write_text(json.dumps({"$schema": "./media.schema.json", "version": 1, "base_url": "https://qaboard-media.sivoov.app",
                                    "shots": {"commit/themed": entry}}))
    still_capture(out / "commit/themed", "dark", dark_image(2880, 1600), id="commit/themed")
    assert run_publish(tmp_path, manifest) == 0
    assert json.loads((out / "publish-report.json").read_text())["shots"]["commit/themed (dark)"]["status"] == "skipped"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q", "-p", "no:cacheprovider", *sys.argv[1:]]))


def test_revision_forces_a_new_capture_and_texts_follow_the_spec():
    meta = {"alt": "New alt", "caption": "New caption", "project": "serving-latency", "source_spec": "docs-media/shots/x.spec.ts"}
    e = publish.Encoded(id="logs/x", kind="clip", meta={**meta, "revision": 2}, files={}, width=1440, height=900, lqip="")
    old = {"kind": "clip", "width": 1440, "height": 900, "alt": "Old alt", "duration": 10}
    # checked before any file is compared: no storage needed
    assert publish.unchanged(e, old, storage=None) == (False, None, "revision 0 -> 2")
    assert publish.unchanged(e, {**old, "revision": 1}, storage=None)[2] == "revision 1 -> 2"
    assert publish.text_fields(meta) == meta
    assert "caption" not in publish.text_fields({**meta, "caption": None})
