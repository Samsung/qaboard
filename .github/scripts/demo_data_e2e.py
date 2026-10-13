#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.56.0"]
# ///
"""
Checks that a QA-Board server shows the demo data its demo-data image restored: CI runs it on the Docker Compose
quickstart (deployments/quickstart/compose.yml) and on the Helm chart's quickstart (helm-e2e).
Usage: demo_data_e2e.py URL [--results /mnt/qaboard] [--no-browser] [--timeout 300]

1. Reads what the demo data has from the server: <results>/.qaboard-demo/demo.json (written by docs-media/seed.py,
   served by nginx under /s/), with its projects and their commits.
2. Through the API, for each project: it's in the projects list, its latest commit has the batches demo.json
   lists, with runs; nginx serves a run's files, and Cantaloupe its images, where the web app asks for them.
3. In Chromium (Playwright), unless --no-browser: the projects list shows the projects, the commit page of each
   project's latest commit shows its message, and the image viewers of the commit checked above get image tiles.
Locally, a Chromium that's already installed works: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Never through a proxy: it may not reach localhost
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def log(message):
    print(f"\033[1m[demo-data] {message}\033[0m", flush=True)


def fail(message):
    print(f"\033[31m[demo-data] ERROR: {message}\033[0m", flush=True)
    sys.exit(1)


def get(base, path, accept=None):
    request = urllib.request.Request(path if path.startswith("http") else base + path)
    if accept:
        request.add_header("Accept", accept)
    try:
        with OPENER.open(request, timeout=60) as r:
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


def wait_healthy(base, timeout):
    start = time.time()
    while True:
        try:
            with OPENER.open(f"{base}/api/v1/health", timeout=10) as r:
                if r.status == 200:
                    return
        except OSError:
            pass
        if time.time() - start > timeout:
            fail(f"{base}/api/v1/health didn't answer in {timeout}s")
        time.sleep(3)


def check_api(base, results):
    demo = get_json(base, f"/s{results}/.qaboard-demo/demo.json")
    if not demo.get("projects"):
        fail(f"No project in /s{results}/.qaboard-demo/demo.json")
    projects = get_json(base, "/api/v1/projects")
    endpoint = get_json(base, "/api/v1/config")["image_servers"]["default"]
    latest, images = {}, {}
    for name, project in demo["projects"].items():
        pid = project["id"]
        if pid not in projects:
            fail(f"{pid} ({name}) is not in /api/v1/projects: {list(projects)}")
        commit_id, facts = max(project["commits"].items(), key=lambda kv: kv[1]["at"])
        commit = get_json(base, f"/api/v1/commit/{facts['sha']}?project={urllib.parse.quote(pid)}")
        batches = commit.get("batches", {})
        missing = set(facts.get("batches", [])) - set(batches)
        if missing:
            fail(f"{pid}: the commit {commit_id} misses the batches {sorted(missing)}: it has {sorted(batches)}")
        outputs = [o for b in batches.values() for o in b.get("outputs", {}).values()]
        if not outputs:
            fail(f"{pid}: the commit {commit_id} has no runs")
        images[pid] = check_files(base, pid, project, endpoint)
        latest[pid] = commit
        checked = f"{images[pid][1]} served by nginx and the image server" if images[pid] else "no PNG to check"
        log(f"OK: {pid}, {len(project['commits'])} commits; {commit_id} has {len(batches)} batches and {len(outputs)} runs; {checked}")
    return latest, images


def check_files(base, pid, project, endpoint):
    """nginx serves a run's files, Cantaloupe its images: on the first commit with a successful run that saved a PNG.
    Returns that commit's sha and the PNG, or None."""
    for facts in sorted(project["commits"].values(), key=lambda c: c["at"]):
        commit = get_json(base, f"/api/v1/commit/{facts['sha']}?project={urllib.parse.quote(pid)}")
        for batch in commit.get("batches", {}).values():
            for output in batch.get("outputs", {}).values():
                if output["is_failed"] or output["is_pending"]:
                    continue
                manifest = get_json(base, f"/api/v1/output/{output['id']}/manifest")
                png = next((f for f in manifest if f.endswith(".png")), None)
                if not png:
                    continue
                url = f"{output['output_dir_url']}/{png}"
                if not get(base, url).startswith(b"\x89PNG"):
                    fail(f"{url} is not a PNG image")
                identifier = urllib.parse.quote(f"{url[len('/s/'):]}", safe="")
                if not get(base, f"{endpoint}{identifier}/full/64,/0/default.png").startswith(b"\x89PNG"):
                    fail(f"The image server doesn't serve {url}")
                return facts["sha"], png
    return None


def check_pages(base, latest, images):
    from playwright.sync_api import sync_playwright, expect
    executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE") or None
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=executable)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"{base}/")
        for pid in latest:
            expect(page.get_by_text(pid).first).to_be_visible(timeout=60_000)
        log(f"OK: the projects list shows {', '.join(latest)}")
        for pid, commit in latest.items():
            page.goto(f"{base}/{pid}/commit/{commit['id']}")
            message = commit["message"].splitlines()[0][:60]
            expect(page.get_by_text(message).first).to_be_visible(timeout=60_000)
            log(f"OK: the commit page of {pid} shows its commit {commit['id'][:8]}, \"{message}\"")
        # The Visualizations view: its image viewers ask the image server for tiles
        tiles = []
        page.on("response", lambda r: tiles.append(r.status) if "/iiif/" in r.url else None)
        for pid, image in images.items():
            if not image:
                continue
            tiles.clear()
            page.goto(f"{base}/{pid}/commit/{image[0]}?selected_views=output-list")
            for _ in range(60):
                if 200 in tiles:
                    break
                page.wait_for_timeout(1000)
            if 200 not in tiles:
                fail(f"{pid}: the image viewers of the commit {image[0][:8]} got no image tiles (/iiif/ responses: {tiles[:20]})")
            log(f"OK: the image viewers of {pid}'s commit {image[0][:8]} got {tiles.count(200)} image tiles")
        browser.close()
        if errors:
            fail(f"JavaScript errors in the web app: {errors}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", help="QA-Board, e.g. http://localhost:5151")
    parser.add_argument("--results", default="/mnt/qaboard", help="where the demo results are (default: %(default)s)")
    parser.add_argument("--no-browser", action="store_true", help="only check through the API")
    parser.add_argument("--timeout", type=int, default=300, help="for the server to answer, in seconds")
    args = parser.parse_args()
    base = args.url.rstrip("/")
    wait_healthy(base, args.timeout)
    latest, images = check_api(base, args.results.rstrip("/"))
    if not args.no_browser:
        check_pages(base, latest, images)
    log("All checks passed")


if __name__ == "__main__":
    main()
