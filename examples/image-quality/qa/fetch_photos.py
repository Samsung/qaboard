# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pillow", "pyyaml", "boto3"]
# ///
"""
Downloads the photos listed in inputs.lock.yaml (CC0 or public domain, see LICENSES.md) into inputs/photos/:
each original is checked against its SHA-256, cropped and resized to 1224x816 (Pillow, Lanczos), and the resized
pixels are checked too. If the source is unreachable or changed, it falls back to the mirror in R2 (bucket
qaboard-ci, inputs/image-quality/<sha256>.<ext>), which needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.

    uv run qa/fetch_photos.py              # what main.py does the first time qa imports it
    uv run qa/fetch_photos.py --mirror     # mirror first (CI)
    uv run qa/fetch_photos.py --check      # re-check the files already there
    uv run qa/fetch_photos.py --upload     # maintainers: upload the originals and resized files to the mirror
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
BUCKET, PREFIX = 'qaboard-ci', 'inputs/image-quality'
USER_AGENT = 'QABoardDocsDemo/1.0 (https://github.com/Samsung/qaboard)'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def pixels_sha256(image):
    """Hash of the decoded pixels: PNG encoders differ in the bytes they write, not in the pixels."""
    array = np.asarray(image.convert('RGB'))
    return sha256(f'{array.shape}'.encode() + array.tobytes())


def resize(original, crop, width, height):
    """Crop (x, y, w, h in the original, or the centered largest box with the output's aspect ratio), then resize."""
    image = ImageOps.exif_transpose(Image.open(io.BytesIO(original))).convert('RGB')
    if crop:
        x, y, w, h = crop
    else:
        w = min(image.width, image.height * width // height)
        h = w * height // width
        x, y = (image.width - w) // 2, (image.height - h) // 2
    return image.crop((x, y, x + w, y + h)).resize((width, height), Image.Resampling.LANCZOS)


def r2():
    import boto3
    return boto3.client(
        's3', region_name='auto',
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
    )


def from_mirror(key):
    if not os.environ.get('R2_ACCESS_KEY_ID'):
        raise RuntimeError('no R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) for the mirror')
    return r2().get_object(Bucket=BUCKET, Key=f'{PREFIX}/{key}')['Body'].read()


def from_source(url):
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def fetch(name, photo, size, database, mirror_first=False, log=print):
    target = database / photo['path']
    original_key = f"{photo['sha256']}{Path(photo['url']).suffix.lower()}"
    resized_key = f"{photo['pixels_sha256']}.png"
    attempts = [('source', lambda: from_source(photo['url'])), ('mirror', lambda: from_mirror(original_key))]
    if mirror_first:
        attempts.insert(0, ('mirror, resized', lambda: from_mirror(resized_key)))
    for where, download in attempts:
        try:
            data = download()
        except Exception as e:
            log(f'  {name}: {where}: {e}')
            continue
        if where == 'mirror, resized':
            image = Image.open(io.BytesIO(data))
        elif sha256(data) != photo['sha256']:
            log(f'  {name}: {where}: the file changed (SHA-256 {sha256(data)[:12]}, expected {photo["sha256"][:12]})')
            continue
        else:
            image = resize(data, photo.get('crop'), *size)
        if pixels_sha256(image) != photo['pixels_sha256']:
            log(f'  {name}: the resized pixels differ from the lock (another Pillow or libjpeg?): using them anyway')
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + '.tmp')
        image.save(tmp, format='png')
        tmp.replace(target)
        log(f'  {name}: from the {where}')
        return True
    log(f'ERROR: could not get {photo["path"]}: see {photo["page"]}')
    return False


def ensure_photos(database, mirror_first=False, check=False, log=print):
    """Downloads the photos missing in database/photos."""
    lock = yaml.safe_load(LOCK.read_text())
    size = (lock['resize']['width'], lock['resize']['height'])
    missing = {name: photo for name, photo in lock['photos'].items()
               if not (Path(database) / photo['path']).exists()
               or (check and pixels_sha256(Image.open(Path(database) / photo['path'])) != photo['pixels_sha256'])}
    if missing:
        log(f'Downloading {len(missing)} photos (CC0 or public domain, see LICENSES.md)')
    ok = [fetch(name, photo, size, Path(database), mirror_first, log) for name, photo in missing.items()]
    return all(ok)


def upload(database):
    """Uploads each photo's original and resized file to the mirror (maintainers, once per new photo)."""
    lock = yaml.safe_load(LOCK.read_text())
    size = (lock['resize']['width'], lock['resize']['height'])
    client = r2()
    for name, photo in lock['photos'].items():
        original = from_source(photo['url'])
        assert sha256(original) == photo['sha256'], name
        resized = resize(original, photo.get('crop'), *size)
        assert pixels_sha256(resized) == photo['pixels_sha256'], name
        png = io.BytesIO()
        resized.save(png, format='png')
        for key, data, content_type in [
            (f"{photo['sha256']}{Path(photo['url']).suffix.lower()}", original, 'image/jpeg'),
            (f"{photo['pixels_sha256']}.png", png.getvalue(), 'image/png'),
        ]:
            client.put_object(Bucket=BUCKET, Key=f'{PREFIX}/{key}', Body=data, ContentType=content_type)
            print(f'uploaded {name}: {PREFIX}/{key} ({len(data)} bytes)')


if __name__ == '__main__':
    database = ROOT / 'inputs'
    if '--upload' in sys.argv:
        upload(database)
    else:
        sys.exit(0 if ensure_photos(database, mirror_first='--mirror' in sys.argv, check='--check' in sys.argv) else 1)
