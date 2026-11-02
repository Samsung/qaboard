#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = []
# ///
"""
Runs a real `qa batch` in the cluster of CI's helm-e2e job, then checks its results through QA-Board.
Usage: helm_e2e.py URL [--release qaboard] [--timeout 600]

1. A Job runs the `qa` CLI of the backend image on qaboard/sample_project, like a CI pipeline would (CI=true,
   GITHUB_SHA...): 2 runs that each save an image and a text file. The Job mounts the results volume of the
   backend at the same path, and sends results to the proxy's Service.
2. Through QA-Board at URL (e.g. a port-forward to the proxy), checks that:
   - the project, the commit, its batch and its 2 successful runs exist
   - nginx serves the runs' files under /s/<path>, and the backend lists their folder (the web app's file browser)
   - Cantaloupe serves the image, where the web app asks for it (IIIF)
Prints the Job's logs, and what failed.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

JOB = "qaboard-e2e-batch"
PROJECT = "user/sample_project"  # project.name in qaboard/sample_project/qaboard.yaml
# Without a .git folder, the CLI gets the commit from CI variables
COMMIT = os.environ.get("GITHUB_SHA") or "0123456789abcdef0123456789abcdef01234567"

# Runs in the backend image
SCRIPT = r"""
set -euxo pipefail
# A copy of the sample project: qa runs from the folder of its qaboard.yaml
sample=$(python3 -c "import importlib.util, os; print(os.path.dirname(importlib.util.find_spec('qaboard').origin))")/sample_project
cp -r "$sample" /tmp/project
cd /tmp/project
# The inputs: 2 small images
mkdir -p /tmp/inputs
python3 - <<'EOF'
import struct, zlib
def png(path, rgb, size=64):
    rows = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
png("/tmp/inputs/red.png", (255, 0, 0))
png("/tmp/inputs/blue.png", (0, 0, 255))
EOF
cat > e2e.batches.yaml <<'EOF'
helm-e2e:
  database: {linux: /tmp/inputs}
  inputs: [red.png, blue.png]
EOF
# sample_project's run() runs the command after "--" in each run's output folder
qa batch --batches-file e2e.batches.yaml helm-e2e -- 'cp {input_path} {output_dir}/image.png && echo ok > {output_dir}/result.txt'
"""


def log(message):
    print(f"\033[1m[helm-e2e] {message}\033[0m", flush=True)


def fail(message):
    print(f"\033[31m[helm-e2e] ERROR: {message}\033[0m", flush=True)
    sys.exit(1)


def kubectl(*args, check=True, json_output=False):
    r = subprocess.run(["kubectl", *args], text=True, capture_output=True)
    if check and r.returncode:
        fail(f"kubectl {' '.join(args)}: {r.stderr.strip()}")
    return json.loads(r.stdout) if json_output else r.stdout


def job_manifest(release):
    """The Job uses the backend's image and results volume, so it sees the results at the same path."""
    deployments = kubectl("get", "deployment", "-l", f"app.kubernetes.io/instance={release},app.kubernetes.io/component=backend",
                          "-o", "json", json_output=True)["items"]
    if not deployments:
        fail(f"No backend Deployment for the release {release}")
    backend = deployments[0]
    pod = backend["spec"]["template"]["spec"]
    container = next(c for c in pod["containers"] if c["name"] == "backend")
    volume = next((v for v in pod.get("volumes", []) if v["name"] == "qaboard-results"), None)
    if not volume:
        fail("The backend has no results volume: install the chart with results.enabled (quickstart.yaml)")
    mount = next(m for m in container["volumeMounts"] if m["name"] == "qaboard-results")
    proxy = backend["metadata"]["name"].replace("-backend", "-proxy")
    env = {
        "CI": "true",
        "GITHUB_SHA": COMMIT,
        "GITHUB_REF": "refs/heads/master",
        "GIT_MESSAGE": "helm-e2e: qa batch in the cluster",
        "QABOARD_URL": f"http://{proxy}",
        "QA_STORAGE": mount["mountPath"],
        "QA_NO_CHECK_FOR_UPDATES": "1",
    }
    return mount["mountPath"], {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": JOB},
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": 600,
            "template": {
                "spec": {
                    "restartPolicy": "Never",
                    "containers": [{
                        "name": "qa",
                        "image": container["image"],
                        "imagePullPolicy": container.get("imagePullPolicy", "IfNotPresent"),
                        "command": ["bash", "-c", SCRIPT],
                        "env": [{"name": k, "value": v} for k, v in env.items()],
                        "volumeMounts": [{"name": "qaboard-results", "mountPath": mount["mountPath"]}],
                    }],
                    "volumes": [volume],
                },
            },
        },
    }


def run_job(release, timeout):
    mount_path, manifest = job_manifest(release)
    kubectl("delete", "job", JOB, "--ignore-not-found", "--wait")
    subprocess.run(["kubectl", "apply", "-f", "-"], input=json.dumps(manifest), text=True, check=True)
    log(f"qa batch runs in the Job {JOB}, with results in {mount_path}")
    start = time.time()
    status = {}
    while time.time() - start < timeout:
        status = kubectl("get", "job", JOB, "-o", "json", json_output=True).get("status", {})
        if status.get("succeeded") or status.get("failed"):
            break
        time.sleep(5)
    print(kubectl("logs", f"job/{JOB}", "--tail", "300", check=False), flush=True)
    if not status.get("succeeded"):
        print(kubectl("describe", "job", JOB, check=False))
        print(kubectl("get", "pods", "-l", f"job-name={JOB}", "-o", "wide", check=False))
        fail(f"qa batch failed or timed out ({time.time() - start:.0f}s): see its logs above")
    log(f"qa batch succeeded in {time.time() - start:.0f}s")
    return mount_path


def get(base, path, accept=None):
    request = urllib.request.Request(path if path.startswith("http") else base + path)
    if accept:
        request.add_header("Accept", accept)
    try:
        with urllib.request.urlopen(request, timeout=60) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        fail(f"GET {request.full_url}: HTTP {e.code}: {e.read()[:500]!r}")
    except OSError as e:
        fail(f"GET {request.full_url}: {e}")


def get_json(base, path, accept=None):
    body = get(base, path, accept)
    try:
        return json.loads(body)
    except ValueError:
        fail(f"GET {path} did not return JSON: {body[:300]!r}")


def check_results(base, mount_path):
    projects = get_json(base, "/api/v1/projects")
    if PROJECT not in projects:
        fail(f"The project {PROJECT} is not in /api/v1/projects: {list(projects)}")
    commit = get_json(base, f"/api/v1/commit/{COMMIT}?project={PROJECT}")
    outputs = list(commit.get("batches", {}).get("default", {}).get("outputs", {}).values())
    log(f"The commit {COMMIT[:8]} has {len(outputs)} runs")
    if len(outputs) != 2:
        fail(f"Expected 2 runs in the default batch: {json.dumps(commit.get('batches'), indent=1)[:2000]}")
    for output in outputs:
        state = {k: output[k] for k in ("is_failed", "is_pending", "is_running")}
        if any(state.values()):
            fail(f"The run of {output['test_input_path']} did not succeed: {state}")
        url = output["output_dir_url"]
        if not url.startswith(f"/s{mount_path}/"):
            fail(f"The run's results are at {url}, not in the results storage /s{mount_path}/")
        # nginx serves the files
        if get(base, f"{url}/result.txt").strip() != b"ok":
            fail(f"Unexpected content for {url}/result.txt")
        if not get(base, f"{url}/image.png").startswith(b"\x89PNG"):
            fail(f"{url}/image.png is not a PNG image")
        # The backend lists the folder, at the same path
        listing = get_json(base, f"{url}/", accept="application/json")
        names = {entry["name"] for entry in listing.get("entries", [])}
        if not {"image.png", "result.txt", "log.txt"} <= names:
            fail(f"The backend's listing of {url}/ misses files: {sorted(names)}")
        # Cantaloupe, where the web app asks for it (webapp/src/viewers/images/utils.js)
        endpoint = get_json(base, "/api/v1/config")["image_servers"]["default"]
        identifier = f"{url[len('/s/'):]}/image.png".replace("/", "%2F")
        info = get_json(base, f"{endpoint}{identifier}/info.json")
        if info.get("width") != 64:
            fail(f"Unexpected IIIF info for {url}/image.png: {info}")
        log(f"OK: {url} (files, listing, IIIF)")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", help="QA-Board, e.g. http://localhost:5151")
    parser.add_argument("--release", default="qaboard")
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    mount_path = run_job(args.release, args.timeout)
    check_results(args.url.rstrip("/"), mount_path)
    log("All checks passed")


if __name__ == "__main__":
    main()
