# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pillow", "pyyaml", "boto3>=1.35"]
# ///
"""
Gets the photos listed in inputs.lock.yaml (CC0 or public domain, see LICENSES.md) into inputs/photos/<name>.png.

Each photo is downloaded from the public mirror (`mirror` in the lock) and checked against its SHA-256. A photo that
isn't mirrored yet comes from its source, cropped and resized to 1224x816 (Pillow, Lanczos).

    uv run qa/fetch_photos.py            # what main.py does the first time qa imports it
    uv run qa/fetch_photos.py --check    # check the photos already there too

To add a photo: add an entry under `photos:` with its `license` and `source` (`page`, `url`, optionally `crop`), then
    uv run qa/fetch_photos.py --lock     # downloads it from its source, resizes it, writes its hashes in the lock
    uv run qa/fetch_photos.py --upload   # maintainers: copy it to the mirror (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
                                         # R2_SECRET_ACCESS_KEY, bucket qaboard-media); objects are never overwritten
and add it to LICENSES.md.
"""
import hashlib
import io
import os
import sys
import urllib.request
from pathlib import Path

import numpy as np
import yaml
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / 'inputs.lock.yaml'
USER_AGENT = 'QA-Board-docs-demo/1.0 (https://github.com/Samsung/qaboard)'
BUCKET, PREFIX = 'qaboard-media', 'inputs/image-quality'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def pixels_sha256(image):
    """Hash of the decoded pixels: PNG encoders differ in the bytes they write, not in the pixels."""
    array = np.asarray(image.convert('RGB'))
    return sha256(f'{array.shape}'.encode() + array.tobytes())


def download(url):
    if '://' not in url:   # a file next to the lock
        return (ROOT / url).read_bytes()
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def resize(source, crop, width, height):
    """Crop (x, y, w, h in the source; default: the centered largest box with the output's aspect ratio), resize."""
    image = ImageOps.exif_transpose(Image.open(io.BytesIO(source))).convert('RGB')
    if crop:
        x, y, w, h = crop
    else:
        w = min(image.width, image.height * width // height)
        h = w * height // width
        x, y = (image.width - w) // 2, (image.height - h) // 2
    return image.crop((x, y, x + w, y + h)).resize((width, height), Image.Resampling.LANCZOS)


def png_bytes(image):
    data = io.BytesIO()
    image.save(data, format='png')
    return data.getvalue()


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_bytes(data)
    tmp.replace(path)


def fetch(name, photo, lock, database, log=print):
    target = Path(database) / 'photos' / f'{name}.png'
    try:
        data = download(lock['mirror'] + f"{photo['sha256']}.png")
        if sha256(data) == photo['sha256']:
            save(target, data)
            log(f'  {name}: from the mirror')
            return True
        log(f'  {name}: the mirror has another file (SHA-256 {sha256(data)[:12]})')
    except Exception as e:
        log(f'  {name}: not in the mirror ({e})')
    source = photo['source']
    try:
        data = download(source['url'])
    except Exception as e:
        log(f"ERROR: could not download {name} from {source['url']} ({e}). See {source['page']}")
        return False
    if source.get('sha256') and sha256(data) != source['sha256']:
        log(f'  {name}: the source changed since it was locked, using it anyway')
    image = resize(data, source.get('crop'), *lock['size'])
    if pixels_sha256(image) != photo.get('pixels_sha256'):
        log(f'  {name}: the resized pixels differ from the lock (another Pillow?), using them anyway')
    save(target, png_bytes(image))
    log(f'  {name}: from {source["url"]}')
    return True


def ensure_photos(database, check=False, log=print):
    """Gets the photos missing in database/photos. Returns False if one couldn't be downloaded."""
    lock = yaml.safe_load(LOCK.read_text())
    photos = lock.get('photos') or {}
    def ok(name, photo):
        path = Path(database) / 'photos' / f'{name}.png'
        if not path.exists():
            return False
        return not check or pixels_sha256(Image.open(path)) == photo.get('pixels_sha256')
    missing = {name: photo for name, photo in photos.items() if not ok(name, photo)}
    if missing:
        log(f'Downloading {len(missing)} photos (CC0 or public domain, see LICENSES.md)')
    return all([fetch(name, photo, lock, database, log) for name, photo in missing.items()])


def update_lock(database):
    """Downloads the photos without hashes from their source, and writes their hashes in the lock."""
    lock = yaml.safe_load(LOCK.read_text())
    header = ''.join(line for line in LOCK.read_text().splitlines(keepends=True) if line.startswith('#'))
    for name, photo in lock['photos'].items():
        if photo.get('sha256'):
            continue
        source = download(photo['source']['url'])
        photo['source']['sha256'] = sha256(source)
        photo['source']['bytes'] = len(source)
        image = resize(source, photo['source'].get('crop'), *lock['size'])
        data = png_bytes(image)
        save(Path(database) / 'photos' / f'{name}.png', data)
        photo.update(sha256=sha256(data), bytes=len(data), pixels_sha256=pixels_sha256(image))
        print(f'locked {name}: {len(data)} bytes')
    LOCK.write_text(header + yaml.safe_dump(lock, sort_keys=False, width=200, allow_unicode=True))


def upload(database):
    """Copies each photo to the public mirror, under its SHA-256. Existing objects are left as they are."""
    import boto3
    client = boto3.client(
        's3', region_name='auto', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
    )
    lock = yaml.safe_load(LOCK.read_text())
    for name, photo in lock['photos'].items():
        data = (Path(database) / 'photos' / f'{name}.png').read_bytes()
        assert sha256(data) == photo['sha256'], f'{name}: run --lock first'
        key = f"{PREFIX}/{photo['sha256']}.png"
        try:
            client.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType='image/png', IfNoneMatch='*',
                              CacheControl='public, max-age=31536000, immutable')
            print(f'uploaded {name}: {key}')
        except client.exceptions.ClientError as e:
            if e.response['Error']['Code'] not in ('PreconditionFailed', '412'):
                raise
            print(f'already there {name}: {key}')


if __name__ == '__main__':
    database = ROOT / 'inputs'
    if '--lock' in sys.argv:
        update_lock(database)
    elif '--upload' in sys.argv:
        upload(database)
    else:
        sys.exit(0 if ensure_photos(database, check='--check' in sys.argv) else 1)
