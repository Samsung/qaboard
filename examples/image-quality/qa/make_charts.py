# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pillow>=10.1", "pyyaml", "tifffile"]
# ///
"""
Generates the test charts in inputs/charts/: slanted edge, Siemens star, 24-patch color chart, zone plate, flat gray
(1224x816 each, with a .metadata.yaml giving the measured regions and the viewer's ROI presets), and the 113 MP test
wall (12288x9216, uncompressed TIFF) made of the charts at several scales, gradients, text and crops of the photos.

    uv run qa/make_charts.py            # what main.py does the first time qa imports it
    uv run qa/make_charts.py --force    # regenerate
"""
import sys
from pathlib import Path

import numpy as np
import yaml
from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1224, 816
WALL_WIDTH, WALL_HEIGHT = 12288, 9216
CHARTS = ['slanted-edge', 'siemens-star', 'color-chart', 'zone-plate', 'flat-gray']
WALL = 'test-wall-113mp.tiff'

# Approximate sRGB values of the 24 patches of the classic color rendition chart, row by row
PATCHES = [
    ('dark skin', (115, 82, 68)), ('light skin', (194, 150, 130)), ('blue sky', (98, 122, 157)),
    ('foliage', (87, 108, 67)), ('blue flower', (133, 128, 177)), ('bluish green', (103, 189, 170)),
    ('orange', (214, 126, 44)), ('purplish blue', (80, 91, 166)), ('moderate red', (193, 90, 99)),
    ('purple', (94, 60, 108)), ('yellow green', (157, 188, 64)), ('orange yellow', (224, 163, 46)),
    ('blue', (56, 61, 150)), ('green', (70, 148, 73)), ('red', (175, 54, 60)),
    ('yellow', (231, 199, 31)), ('magenta', (187, 86, 149)), ('cyan', (8, 133, 161)),
    ('white', (243, 243, 242)), ('neutral 8', (200, 200, 200)), ('neutral 6.5', (160, 160, 160)),
    ('neutral 5', (122, 122, 121)), ('neutral 3.5', (85, 85, 85)), ('black', (52, 52, 52)),
]


def to_linear(srgb8):
    c = np.asarray(srgb8, dtype=np.float64) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb8(linear):
    linear = np.clip(linear, 0, 1)
    c = np.where(linear <= 0.0031308, 12.92 * linear, 1.055 * np.power(linear, 1 / 2.4) - 0.055)
    return np.round(c * 255).astype(np.uint8)


def supersampled(width, height, coverage, factor=4):
    """Average of `coverage(x, y)` (in [0, 1]) over factor x factor samples per pixel: anti-aliased shapes."""
    offsets = (np.arange(factor) + 0.5) / factor
    total = np.zeros((height, width))
    ys, xs = np.mgrid[0:height, 0:width].astype(np.float64)
    for oy in offsets:
        for ox in offsets:
            total += coverage(xs + ox, ys + oy)
    return total / factor ** 2


def blend(mask, dark, light):
    """Mix two sRGB gray levels in linear light, by a coverage mask in [0, 1] (1 = dark)."""
    return to_srgb8(mask * to_linear(dark) + (1 - mask) * to_linear(light))


def gray(image8):
    return np.repeat(image8[..., None], 3, axis=2)


def slanted_edge(width=WIDTH, height=HEIGHT, side=None, angle=5.0):
    side = side or int(height * 0.6)
    cx, cy, t = width / 2, height / 2, np.radians(angle)
    def inside(x, y):
        u = (x - cx) * np.cos(t) + (y - cy) * np.sin(t)
        v = -(x - cx) * np.sin(t) + (y - cy) * np.cos(t)
        return ((np.abs(u) < side / 2) & (np.abs(v) < side / 2)).astype(np.float64)
    image = gray(blend(supersampled(width, height, inside), 50, 200))
    # the left edge, near vertical: measured region
    ex = int(cx - side / 2 * np.cos(t))
    edge = {'x': ex - 48, 'y': int(cy - side * 0.3), 'w': 96, 'h': int(side * 0.6)}
    meta = {
        'measure': {'edge': edge},
        'roi': [
            {**edge, 'label': 'Measured edge'},
            {'x': int(cx - side / 2 - 40), 'y': int(cy - side / 2 - 60), 'w': 120, 'h': 120, 'label': 'Corner'},
            {'x': int(cx - 64), 'y': int(cy - side / 2 - 40), 'w': 128, 'h': 80, 'label': 'Top edge'},
        ],
    }
    return image, meta


def siemens_star(width=WIDTH, height=HEIGHT, radius=None, spokes=72):
    radius = radius or int(height * 0.46)
    cx, cy = width / 2, height / 2
    def dark(x, y):
        angle = np.arctan2(y - cy, x - cx)
        r = np.hypot(x - cx, y - cy)
        return ((np.sin(angle * spokes / 2) > 0) & (r < radius)).astype(np.float64)
    mask = supersampled(width, height, dark)
    outside = supersampled(width, height, lambda x, y: (np.hypot(x - cx, y - cy) >= radius).astype(np.float64))
    linear = (1 - outside) * (mask * to_linear(40) + (1 - mask) * to_linear(215)) + outside * to_linear(128)
    image = gray(to_srgb8(linear))
    s = radius // 4
    meta = {'roi': [
        {'x': int(cx - s / 2), 'y': int(cy - s / 2), 'w': s, 'h': s, 'label': 'Center (aliasing)'},
        {'x': int(cx + radius * 0.45), 'y': int(cy - s / 2), 'w': s, 'h': s, 'label': 'Mid radius'},
        {'x': int(cx - s / 2), 'y': int(cy - radius * 0.95), 'w': s, 'h': s, 'label': 'Outer spokes'},
    ]}
    return image, meta


def color_chart(width=WIDTH, height=HEIGHT):
    image = np.full((height, width, 3), 30, dtype=np.uint8)
    size, gap = int(width * 0.13), int(width * 0.025)
    x0 = (width - 6 * size - 5 * gap) // 2
    y0 = (height - 4 * size - 3 * gap) // 2
    patches = []
    for i, (name, srgb) in enumerate(PATCHES):
        x, y = x0 + (i % 6) * (size + gap), y0 + (i // 6) * (size + gap)
        image[y:y + size, x:x + size] = srgb
        patches.append({'name': name, 'srgb': list(srgb), 'x': x, 'y': y, 'w': size, 'h': size})
    meta = {
        'measure': {'patches': patches},
        'roi': [
            {**{k: patches[6][k] for k in 'xywh'}, 'w': 3 * size + 2 * gap, 'label': 'Orange, purplish blue, red'},
            {**{k: patches[12][k] for k in 'xywh'}, 'w': 6 * size + 5 * gap, 'label': 'Saturated colors'},
            {**{k: patches[18][k] for k in 'xywh'}, 'w': 6 * size + 5 * gap, 'label': 'Gray patches'},
        ],
    }
    return image, meta


def zone_plate(width=WIDTH, height=HEIGHT):
    cx, cy = width / 2, height / 2
    k = 0.5 / (0.5 * width)   # 0.5 cycles/pixel half a width away from the center, aliasing beyond
    def bright(x, y):
        r2 = (x - cx) ** 2 + (y - cy) ** 2
        return 0.5 + 0.5 * np.cos(np.pi * k * r2)
    level = supersampled(width, height, bright)
    image = gray(to_srgb8(to_linear(40) + level * (to_linear(215) - to_linear(40))))
    meta = {'roi': [
        {'x': int(cx - 100), 'y': int(cy - 100), 'w': 200, 'h': 200, 'label': 'Center'},
        {'x': int(cx + width * 0.3), 'y': int(cy - 60), 'w': 120, 'h': 120, 'label': 'Near Nyquist'},
        {'x': width - 160, 'y': height - 160, 'w': 160, 'h': 160, 'label': 'Corner (aliasing)'},
    ]}
    return image, meta


def flat_gray(width=WIDTH, height=HEIGHT):
    image = np.full((height, width, 3), 118, dtype=np.uint8)   # 18% gray
    flat = {'x': width // 4, 'y': height // 4, 'w': width // 2, 'h': height // 2}
    return image, {'measure': {'flat': flat}, 'roi': [{**flat, 'label': 'Center'}]}


GENERATORS = {'slanted-edge': slanted_edge, 'siemens-star': siemens_star, 'color-chart': color_chart,
              'zone-plate': zone_plate, 'flat-gray': flat_gray}


def text_block(width, height):
    """Rendered text at decreasing sizes, black on white."""
    canvas = Image.new('L', (width, height), 235)
    draw = ImageDraw.Draw(canvas)
    y = 40
    lines = [(360, 'KITEFIN K3 TEST WALL'), (200, 'Imaging lab, chart set 4'),
             *[(size, f'{size} px  The quick brown fox jumps over the lazy dog 0123456789') for size in
               (128, 96, 72, 56, 44, 34, 26, 20, 16, 12, 10, 8)]]
    for size, line in lines:
        draw.text((60, y), line, fill=20, font=ImageFont.load_default(size=size))
        y += int(size * 1.5)
    return gray(np.asarray(canvas))


def gradients(width, height):
    """A gray ramp on top, a hue sweep with decreasing saturation below."""
    image = np.empty((height, width, 3), dtype=np.uint8)
    half = height // 2
    ramp = np.linspace(0, 1, width)
    image[:half] = gray(to_srgb8(np.tile(ramp, (half, 1)) ** 2.2))
    hue = np.linspace(0, 1, width)[None, :]
    saturation = np.linspace(1, 0, height - half)[:, None]
    rgb = np.clip(np.abs(((hue * 6 + np.array([0, 4, 2])[:, None, None]) % 6) - 3) - 1, 0, 1)   # (3, 1, W)
    rgb = 1 - saturation[None] * (1 - rgb)
    image[half:] = to_srgb8(np.moveaxis(rgb, 0, -1) * 0.7)
    return image


def resize(image, width, height):
    return np.asarray(Image.fromarray(image).resize((width, height), Image.Resampling.LANCZOS))


def test_wall(photos):
    """The 113 MP wall (12288x9216): charts at several scales, gradients, text, photos."""
    wall = np.full((WALL_HEIGHT, WALL_WIDTH, 3), 128, dtype=np.uint8)
    rois = []
    def place(name, image, x, y):
        wall[y:y + image.shape[0], x:x + image.shape[1]] = image
        rois.append({'x': x, 'y': y, 'w': image.shape[1], 'h': image.shape[0], 'label': name})
    place('Siemens star, 144 spokes', siemens_star(4096, 4096, radius=1980, spokes=144)[0], 0, 0)
    place('Color chart', color_chart(4096, 2730)[0], 4096, 0)
    place('Zone plate', zone_plate(4096, 2730)[0], 8192, 0)
    place('Gradients', gradients(8192, 1366), 4096, 2730)
    for i in range(8):
        if i < len(photos):
            photo = resize(np.asarray(Image.open(photos[i]).convert('RGB')), 1536, 1024)
            place(f'Photo: {Path(photos[i]).stem}', photo, (i % 4) * 1536, 4096 + (i // 4) * 1024)
        else:   # until the photos are downloaded
            place('Zone plate', zone_plate(1536, 1024)[0], (i % 4) * 1536, 4096 + (i // 4) * 1024)
    place('Text', text_block(6144, 2048), 6144, 4096)
    for i, name in enumerate(CHARTS):
        place(f'{name} (1:1)', GENERATORS[name]()[0], i * 2448 + 612, 6144)
    x = 0
    for i, size in enumerate((1024, 768, 512, 384, 256, 192, 128, 96, 64)):
        place(f'Siemens star {size} px', siemens_star(size, size, spokes=72)[0], x, 7168 + (2048 - size) // 2)
        x += size + 64
    place('Slanted edges', slanted_edge(WALL_WIDTH - x - 64, 2048, side=1200, angle=5)[0], x + 64, 7168)
    rois = [r for r in rois if r['label'].startswith(('Siemens star, 144', 'Text', 'Photo: facade', 'Siemens star 64'))]
    return wall, {'photos': photo_hashes(photos), 'roi': rois}


def photo_hashes(photos):
    """Identifies the photos in the wall, cheaply: their names and sizes."""
    return {Path(p).stem: Path(p).stat().st_size for p in photos[:8]}


def save(image, meta, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    if path.suffix == '.tiff':
        import tifffile
        tifffile.imwrite(tmp, image, photometric='rgb')   # uncompressed and contiguous: the run memory-maps it
    else:
        Image.fromarray(image).save(tmp, format='png')
    path.with_suffix('.metadata.yaml').write_text(yaml.safe_dump(meta, sort_keys=False))
    tmp.replace(path)


def ensure_charts(database, force=False, log=print):
    """Generates the charts and the wall in database/charts if they're missing."""
    charts = Path(database) / 'charts'
    for name in CHARTS:
        if force or not (charts / f'{name}.png').exists():
            log(f'Generating charts/{name}.png')
            save(*GENERATORS[name](), charts / f'{name}.png')
    # the wall has crops of the photos: regenerated once they're all downloaded
    photos = sorted((Path(database) / 'photos').glob('*.png'))
    wall_meta = charts / WALL.replace('.tiff', '.metadata.yaml')
    used = yaml.safe_load(wall_meta.read_text()).get('photos') if wall_meta.exists() else None
    if force or not (charts / WALL).exists() or used != photo_hashes(photos):
        log(f'Generating charts/{WALL} (12288x9216, about a minute)')
        save(*test_wall(photos), charts / WALL)


if __name__ == '__main__':
    ensure_charts(Path(__file__).resolve().parent.parent / 'inputs', force='--force' in sys.argv)
