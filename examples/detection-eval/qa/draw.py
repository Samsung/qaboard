"""
Detections drawn on the slice's images: the labels as thin dashed white boxes, the labels the model missed in red,
detections in their class's color with their score.
"""
from PIL import Image, ImageDraw, ImageFont

from detector import CLASSES
from plots import CLASS_COLORS

MISSED = '#cd4246'   # red: no class uses it
LABEL = '#ffffff'
CROWD = '#abb3bf'


def dashed_rectangle(draw, box, color, width=1, dash=6, gap=4):
    x1, y1, x2, y2 = box
    for (ax, ay), (bx, by) in (((x1, y1), (x2, y1)), ((x2, y1), (x2, y2)), ((x2, y2), (x1, y2)), ((x1, y2), (x1, y1))):
        length = max(abs(bx - ax), abs(by - ay))
        steps = int(length // (dash + gap)) + 1
        for i in range(steps):
            t0, t1 = i * (dash + gap) / max(length, 1), min(1.0, (i * (dash + gap) + dash) / max(length, 1))
            if t0 >= 1:
                break
            draw.line([(ax + (bx - ax) * t0, ay + (by - ay) * t0), (ax + (bx - ax) * t1, ay + (by - ay) * t1)], fill=color, width=width)


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:   # Pillow < 10.1
        return ImageFont.load_default()


def draw_detections(image, labels, detections, missed, path, quality=85):
    """
    labels: [{category_id, box, iscrowd}], detections: [{category_id, score, box}] (kept ones), missed: indices of the
    labels no detection found at IoU 0.5
    """
    canvas = image.convert('RGB').copy()
    draw = ImageDraw.Draw(canvas)
    scale = max(canvas.size) / 1024
    line = max(2, round(2 * scale))
    text_font = font(max(12, round(13 * scale)))
    for i, label in enumerate(labels):
        if label.get('iscrowd'):
            dashed_rectangle(draw, label['box'], CROWD, width=1, dash=2, gap=4)
        elif i in missed:
            draw.rectangle(label['box'], outline=MISSED, width=line)
        else:
            dashed_rectangle(draw, label['box'], LABEL, width=max(1, line // 2))
    for d in sorted(detections, key=lambda d: d['score']):
        color = CLASS_COLORS[d['category_id']]
        x1, y1, x2, y2 = d['box']
        draw.rectangle([x1, y1, x2, y2], outline=color, width=line)
        text = f"{CLASSES[d['category_id']]} {d['score']:.2f}"
        left, top, right, bottom = draw.textbbox((0, 0), text, font=text_font)
        w, h = right - left + 6, bottom - top + 4
        ty = y1 - h if y1 - h >= 0 else y1
        draw.rectangle([x1, ty, x1 + w, ty + h], fill=color)
        draw.text((x1 + 3 - left, ty + 2 - top), text, fill='white', font=text_font)
    canvas.save(path, quality=quality, optimize=True)


def thumbnail(path, out, width=360):
    with Image.open(path) as image:
        image.thumbnail((width, width))
        image.save(out, quality=80)
