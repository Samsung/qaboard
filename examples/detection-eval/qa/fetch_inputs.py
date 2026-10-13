# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pillow", "pyyaml", "boto3>=1.35"]
# ///
"""
Gets the photos listed in inputs.lock.yaml (CC0 or public domain, see LICENSES.md) into inputs/: the indoor, outdoor
and warehouse slices, the calibration images, and the backgrounds of the small-objects composites. Then it builds the
composites (qa/make_small_objects.py).

Each photo is downloaded from the public mirror (`mirror` in the lock, or $DETECTOR_MIRROR), else from its source
(the Flickr rendition at `url`), and checked against its SHA-256. The files are used as they are, never re-encoded.

    uv run qa/fetch_inputs.py            # what main.py does the first time qa imports it
    uv run qa/fetch_inputs.py --check    # check the files already there too
    uv run qa/fetch_inputs.py --upload   # maintainers: copy the photos to the mirror (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
                                         # R2_SECRET_ACCESS_KEY, bucket qaboard-media); objects are never overwritten
"""
import contextlib
import fcntl
import hashlib
import os
import sys
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / 'inputs.lock.yaml'
USER_AGENT = 'QA-Board-docs-demo/1.0 (https://github.com/Samsung/qaboard)'
BUCKET, PREFIX = 'qaboard-media', 'inputs/detection-eval'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def download(url):
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_bytes(data)
    tmp.replace(path)


def mirror_url(lock):
    return os.environ.get('DETECTOR_MIRROR', lock.get('mirror'))


def fetch(rel, photo, lock, database, log=print):
    """Downloads a photo from the mirror, else from its source. Returns where it came from, or None"""
    target = Path(database) / rel
    mirror = mirror_url(lock)
    sources = ([('mirror', f"{mirror}{photo['sha256']}.jpg")] if mirror else []) + [('source', photo['source']['url'])]
    problems = []
    for name, url in sources:
        try:
            data = download(url)
        except Exception as e:
            problems.append(f'{url}: {e}')
            continue
        if sha256(data) != photo['sha256']:
            problems.append(f'{url}: another file (SHA-256 {sha256(data)[:12]})')
            continue
        save(target, data)
        return name
    log(f"ERROR: could not get {rel} ({'; '.join(problems)}). Its page: {photo['source']['page']}")
    return None


@contextlib.contextmanager
def locked(database):
    Path(database).mkdir(parents=True, exist_ok=True)
    with open(Path(database) / '.fetch.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def ensure_inputs(database, check=False, log=print):
    """Gets the missing photos and builds the missing composites. Returns False if a photo couldn't be downloaded."""
    import make_small_objects
    lock = yaml.safe_load(LOCK.read_text())
    photos = lock.get('photos') or {}

    def ok(rel, photo):
        path = Path(database) / rel
        return path.exists() and (not check or sha256(path.read_bytes()) == photo['sha256'])
    if all(ok(rel, photo) for rel, photo in photos.items()) and make_small_objects.complete(database):
        return True
    with locked(database):
        missing = {rel: photo for rel, photo in photos.items() if not ok(rel, photo)}
        if missing:
            log(f'Downloading {len(missing)} photos (CC0 or public domain, see LICENSES.md)')
        origins = [fetch(rel, photo, lock, database, log) for rel, photo in missing.items()]
        fetched = all(origins)
        if missing:
            log(f"  {origins.count('mirror')} from the mirror, {origins.count('source')} from their source")
        if fetched and not make_small_objects.complete(database):
            make_small_objects.build(database, log=log)
        return fetched


def upload(database):
    """Copies each photo to the public mirror, under its SHA-256. Existing objects are left as they are."""
    import boto3
    client = boto3.client(
        's3', region_name='auto', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
    )
    lock = yaml.safe_load(LOCK.read_text())
    files = [(rel, Path(database) / rel, photo['sha256'], 'jpg', 'image/jpeg') for rel, photo in lock['photos'].items()]
    for name, path, digest, extension, content_type in files:
        data = path.read_bytes()
        assert sha256(data) == digest, f'{name}: not the locked file'
        key = f"{PREFIX}/{digest}.{extension}"
        try:
            client.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType=content_type, IfNoneMatch='*',
                              CacheControl='public, max-age=31536000, immutable')
            print(f'uploaded {name}: {key}')
        except client.exceptions.ClientError as e:
            if e.response['Error']['Code'] not in ('PreconditionFailed', '412'):
                raise
            print(f'already there {name}: {key}')


if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    database = ROOT / 'inputs'
    if '--upload' in sys.argv:
        upload(database)
    else:
        sys.exit(0 if ensure_inputs(database, check='--check' in sys.argv) else 1)
