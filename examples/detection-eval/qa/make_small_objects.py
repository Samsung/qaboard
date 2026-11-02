# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pillow", "pyyaml"]
# ///
"""
The `small-objects` slice: people and cars cut out of the photos of the other slices, scaled down and pasted at seeded
positions on photos without any of the K3's classes. Their labels are exact by construction.

People and cars are what the K3 must see from far away, and the classes the detector finds well enough for its AP on
small objects to mean something. Their size, the square root of their area in the 320x320 frame the model sees, is 40
to 64 px: smaller than the detector's smallest anchor box (64x64), the objects it finds last. Some lose contrast
towards the background (`haze`), like objects far away in a dim aisle.

inputs/slices/small-objects/labels.json is the recipe: for each composite its background, and for each object the
photo it comes from, its silhouette (run lengths over its box, from donors.json) and where it goes. It is committed;
the images are built from it the first time qa runs.

    uv run qa/make_small_objects.py           # builds the images (main.py does it the first time)
    uv run qa/make_small_objects.py --plan    # maintainers: draws a new recipe from donors.json, then builds
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SLICE = Path('slices/small-objects')
CANVAS = (1024, 683)
COMPOSITES = 30
OBJECTS = (8, 12)          # per composite
FRAME_SIDE = (40, 64)      # sqrt(area) in the 320x320 frame: smaller than the detector's smallest anchor (64 px)
HAZE = (0.0, 0.3)          # contrast lost towards the background's color
SEED = 20261001
CLASS_NAMES = {1: "person", 2: "bicycle", 3: "car", 8: "truck", 62: "chair", 44: "bottle", 27: "backpack", 64: "potted plant"}
CLASSES = [1, 3]           # what the K3 must see from far away: people and cars


def background(path):
    """The background photo, cropped to 3:2 around its center and resized to the canvas"""
    with Image.open(path) as image:
        image = image.convert('RGB')
        w = min(image.width, image.height * 3 // 2)
        h = w * 2 // 3
        x, y = (image.width - w) // 2, (image.height - h) // 2
        return image.crop((x, y, x + w, y + h)).resize(CANVAS, Image.Resampling.LANCZOS)


def rle_decode(mask):
    """Run lengths (row-major, starting with False) -> boolean array"""
    h, w = mask['size']
    values = np.zeros(sum(mask['counts']), dtype=bool)
    position, value = 0, False
    for count in mask['counts']:
        values[position:position + count] = value
        position += count
        value = not value
    return values.reshape(h, w)


def paste(canvas, donor_path, donor, target_box, haze=0.0):
    """
    Pastes the donor's object, cut out along its silhouette, into the target box of the canvas. `haze` blends it
    towards the background's mean color.
    """
    x1, y1, x2, y2 = donor['box']
    tx1, ty1, tx2, ty2 = target_box
    ox, oy = int(np.floor(tx1)), int(np.floor(ty1))
    size = (max(1, int(np.ceil(tx2)) - ox), max(1, int(np.ceil(ty2)) - oy))
    # the donor region that maps onto the whole-pixel paste area
    sx, sy = (x2 - x1) / (tx2 - tx1), (y2 - y1) / (ty2 - ty1)
    region = (x1 + (ox - tx1) * sx, y1 + (oy - ty1) * sy, x1 + (ox + size[0] - tx1) * sx, y1 + (oy + size[1] - ty1) * sy)
    with Image.open(donor_path) as picture:
        region = (max(0.0, region[0]), max(0.0, region[1]), min(picture.width, region[2]), min(picture.height, region[3]))
        patch = picture.convert('RGB').resize(size, Image.Resampling.LANCZOS, box=region)
    silhouette = Image.fromarray(rle_decode(donor['mask']).astype(np.uint8) * 255)
    mh, mw = donor['mask']['size']
    within = (max(0.0, region[0] - x1), max(0.0, region[1] - y1), min(mw, region[2] - x1), min(mh, region[3] - y1))
    alpha = silhouette.resize(size, Image.Resampling.BILINEAR, box=within)
    if haze:
        under = np.asarray(canvas.crop((ox, oy, ox + size[0], oy + size[1])), dtype=np.float64)
        pixels = haze * under.mean(axis=(0, 1)) + (1 - haze) * np.asarray(patch, dtype=np.float64)
        patch = Image.fromarray(np.clip(np.round(pixels), 0, 255).astype(np.uint8))
    canvas.paste(patch, (ox, oy), alpha)


def build(database, log=print):
    database = Path(database)
    recipe = json.loads((database / SLICE / 'labels.json').read_text())
    objects = {}
    for a in recipe['annotations']:
        objects.setdefault(a['image_id'], []).append(a)
    built = 0
    for image in recipe['images']:
        path = database / SLICE / image['file_name']
        if path.exists():
            continue
        canvas = background(database / image['background'])
        for a in objects.get(image['id'], []):
            x, y, w, h = a['bbox']
            paste(canvas, database / a['donor']['file'], a['donor'], (x, y, x + w, y + h), a.get('haze', 0.0))
        tmp = path.with_name(path.name + '.tmp')
        canvas.save(tmp, format='jpeg', quality=90)
        tmp.replace(path)
        built += 1
    if built:
        log(f'Built {built} small-objects composites (qa/make_small_objects.py)')


def complete(database):
    labels = Path(database) / SLICE / 'labels.json'
    if not labels.exists():
        return False
    recipe = json.loads(labels.read_text())
    return all((Path(database) / SLICE / image['file_name']).exists() for image in recipe['images'])


def plan(database, log=print):
    """Draws a new recipe with the fixed seed: backgrounds, objects, sizes, positions and haze"""
    database = Path(database)
    rng = np.random.default_rng(SEED)
    pool = json.loads((database / SLICE / 'donors.json').read_text())['donors']
    by_class = {}
    for d in pool:
        by_class.setdefault(d['category_id'], []).append(d)
    classes = [c for c in CLASSES if c in by_class]
    log('Donors per class: ' + ', '.join(f'{CLASS_NAMES[c]} {len(by_class[c])}' for c in classes))
    backgrounds = sorted((database / 'backgrounds').glob('*.jpg'))
    fx, fy = 320 / CANVAS[0], 320 / CANVAS[1]
    images, annotations = [], []
    for k in range(COMPOSITES):
        image_id = k + 1
        images.append({'id': image_id, 'file_name': f'{image_id:02d}.jpg', 'width': CANVAS[0], 'height': CANVAS[1],
                       'background': backgrounds[k % len(backgrounds)].relative_to(database).as_posix()})
        placed = []
        for _ in range(int(rng.integers(OBJECTS[0], OBJECTS[1] + 1))):
            class_id = classes[int(rng.integers(len(classes)))]
            donor = by_class[class_id][int(rng.integers(len(by_class[class_id])))]
            dx1, dy1, dx2, dy2 = donor['box']
            aspect = (dx2 - dx1) / (dy2 - dy1)
            side = float(rng.uniform(*FRAME_SIDE))
            # area in the 320 frame = side^2, with the donor's aspect ratio
            area = side * side / (fx * fy)
            w, h = (area * aspect) ** 0.5, (area / aspect) ** 0.5
            if w > 0.9 * CANVAS[0] or h > 0.7 * CANVAS[1]:
                continue
            for _ in range(200):
                cx = float(rng.uniform(0.04 * CANVAS[0] + w / 2, 0.96 * CANVAS[0] - w / 2))
                cy = float(rng.uniform(0.25 * CANVAS[1] + h / 2, 0.97 * CANVAS[1] - h / 2))
                box = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
                gap = 0.1 * max(w, h)
                if all(box[0] > p[2] + gap or box[2] < p[0] - gap or box[1] > p[3] + gap or box[3] < p[1] - gap for p in placed):
                    break
            else:
                continue
            placed.append(box)
            haze = round(float(rng.uniform(*HAZE)), 2)
            x, y = round(box[0], 1), round(box[1], 1)
            bw, bh = round(box[2] - box[0], 1), round(box[3] - box[1], 1)
            annotations.append({'id': len(annotations) + 1, 'image_id': image_id, 'category_id': class_id,
                                'bbox': [x, y, bw, bh], 'area': round(bw * bh, 1), 'iscrowd': 0, 'haze': haze,
                                'donor': {'file': donor['file'], 'box': donor['box'], 'mask': donor['mask']}})
    recipe = {
        'info': {'description': 'Kitefin detector test set, small-objects slice: objects of the other slices pasted '
                                'small on background photos, by qa/make_small_objects.py. Labels exact by construction.',
                 'license': 'CC0-1.0, made from the photos in LICENSES.md'},
        'images': images, 'annotations': annotations,
        'categories': [{'id': c, 'name': n} for c, n in CLASS_NAMES.items()],
    }
    path = database / SLICE / 'labels.json'
    path.write_text(json.dumps(recipe, separators=(',', ':')).replace('{"id":', '\n{"id":') + '\n')
    for image in images:
        (database / SLICE / image['file_name']).unlink(missing_ok=True)
    log(f'{len(images)} composites, {len(annotations)} objects')


if __name__ == '__main__':
    database = ROOT / 'inputs'
    if '--plan' in sys.argv:
        plan(database)
    build(database)
