"""
Downloads the models' weights once, before any run, like a CI job's build step: runs then don't wait for them, nor
count the download in their logs. Same as `python qa/models.py`; runs download what is missing anyway.

  python qa/build.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import models  # noqa: E402

if __name__ == '__main__':
    for name in models.lock()['models']:
        m = models.model(name)
        print(f"{name}: {m['path']} ({m['bytes'] / 1e6:.0f} MB)")
