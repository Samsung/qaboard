"""
The models' GGUF weights: downloaded once from Hugging Face at a pinned revision, checked by SHA-256 (see
inputs.lock.yaml), and kept in ~/.cache/kitefin/fleet-assistant/models (or $FLEET_ASSISTANT_MODELS), outside the
project: the CI caches that folder, keyed on the checksums. Downloads take a file lock: runs started in parallel wait
for the first one.

    python qa/models.py            # downloads the models that are missing
    python qa/models.py --check    # also checks the SHA-256 of those already there
"""
import contextlib
import fcntl
import hashlib
import os
import shutil
import sys
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / 'inputs.lock.yaml'
USER_AGENT = 'QA-Board-docs-demo/1.0 (https://github.com/Samsung/qaboard)'


def cache_dir() -> Path:
    return Path(os.environ.get('FLEET_ASSISTANT_CACHE', Path.home() / '.cache' / 'kitefin' / 'fleet-assistant'))


def models_dir() -> Path:
    path = Path(os.environ.get('FLEET_ASSISTANT_MODELS', cache_dir() / 'models'))
    path.mkdir(parents=True, exist_ok=True)
    return path


def lock() -> dict:
    return yaml.safe_load(LOCK.read_text())


@contextlib.contextmanager
def locked(name):
    with open(models_dir() / f'.{name}.lock', 'w') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def download(url, path, sha256, size, log=print):
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    tmp = path.with_name(path.name + '.tmp')
    log(f'Downloading {path.name} ({size / 1e6:.0f} MB) from {url}')
    with urllib.request.urlopen(request, timeout=600) as response, open(tmp, 'wb') as f:
        shutil.copyfileobj(response, f, length=1 << 20)
    actual = sha256_file(tmp)
    if actual != sha256:
        tmp.unlink()
        raise ValueError(f'{path.name}: SHA-256 {actual[:12]}..., expected {sha256[:12]}...')
    tmp.replace(path)


def model(name: str, check=False, log=print) -> dict:
    """A model's entry in inputs.lock.yaml, with `path`: its GGUF file, downloaded if needed"""
    models = lock()['models']
    if name not in models:
        raise SystemExit(f'ERROR: unknown model {name!r}, expected one of: {", ".join(models)}')
    entry = models[name]
    path = models_dir() / entry['file']
    with locked(entry['file']):
        if path.exists() and check and sha256_file(path) != entry['sha256']:
            log(f'{path.name}: wrong SHA-256, downloading it again')
            path.unlink()
        if not path.exists():
            download(entry['url'], path, entry['sha256'], entry['bytes'], log=log)
    return {**entry, 'name': name, 'path': path}


if __name__ == '__main__':
    for name in lock()['models']:
        m = model(name, check='--check' in sys.argv)
        print(f"{name}: {m['path']} ({m['bytes'] / 1e6:.0f} MB, {m['license']})")
