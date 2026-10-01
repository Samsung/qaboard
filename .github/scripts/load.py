#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = []
# ///
"""
Sends requests to QA-Board during a deploy, and fails if any of them fails.
Usage: load.py URL MAX_SECONDS [METHOD] [EXPECTED_STATUS]
Stops early when the file $STOP_FILE exists.

We POST to a GET-only endpoint and expect a 405 from the backend: unlike GETs, nginx can't retry POSTs
on another replica, so we detect requests sent to a replica that is shutting down.
"""
import collections
import os
import sys
import threading
import time
import urllib.error
import urllib.request

url, duration = sys.argv[1], float(sys.argv[2])
method = sys.argv[3] if len(sys.argv) > 3 else "GET"
expected = int(sys.argv[4]) if len(sys.argv) > 4 else 200
stop = time.time() + duration
stop_file = os.environ.get("STOP_FILE")
results: collections.Counter = collections.Counter()


def worker():
    while time.time() < stop and not (stop_file and os.path.exists(stop_file)):
        try:
            data = b"{}" if method == "POST" else None
            with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method), timeout=30) as r:
                results[r.status] += 1
        except urllib.error.HTTPError as e:
            results[e.code] += 1
        except Exception as e:
            results[type(e).__name__] += 1


threads = [threading.Thread(target=worker) for _ in range(4)]
for t in threads:
    t.start()
for t in threads:
    t.join()
print(dict(results))
failures = sum(n for k, n in results.items() if k != expected)
if failures or not results[expected]:
    sys.exit(f"{failures} failed requests during the deploy")
