#!/usr/bin/env python3
"""
Results sent over HTTP, end to end, against a real server: `qa upload` and `qaboard.start_run()` from this checkout,
without a storage shared with the server (docs/design/ingest-upload-sdk.md).
Usage: uploads_e2e.py URL --create-admin 'COMMAND' [--no-proxy] [--silent-runs-after MINUTES]

Run it with the qaboard package of this checkout (`uv run --frozen python .github/scripts/uploads_e2e.py ...`).
COMMAND makes {user} an admin with a local account, reading its password on stdin, like CI's
  './deployments/deploy.py deployments/production.env compose exec -T backend qaboard-admin create-admin {user} --password'
--no-proxy: URL is a backend alone (e.g. `flask run` in backend/, with a database): only the API is checked.
--silent-runs-after: the server's QABOARD_SILENT_RUN_TIMEOUT_MINUTES, to check that a killed run is failed (CI sets 1).

Checks that:
1. a server with default settings takes uploaded files (docker-compose.yml without a site overlay)
2. `qa upload` makes a run: its metrics read from the test report, its files in the server's folder for uploads
3. nginx serves them under /s/, the backend lists the folder, the image server reads the image (not with --no-proxy)
4. starting a run that uploads needs a token
5. uploading the run again replaces its files: what isn't sent again is gone
6. `start_run()` sends its series, its files and its metrics
7. `qa --share run` with QA_STORAGE=upload, in a project whose storage this machine doesn't mount: what it prints
   after its files are sent is in the server's log.txt, and `qa check-bit-accuracy` compares a new commit's run with
   that uploaded reference (the same results pass, others fail)
8. without a shared storage, `qa save-artifacts` sends the commit's artifacts, `qa fetch-artifacts` downloads them
   (not with --no-proxy), and a batch started from the web app runs from them on the server and sends its results
9. a run killed mid-way (SIGKILL: it can't say so) is failed once it is silent (with --silent-runs-after)
"""
import argparse
import http.cookiejar
import importlib.util
import json
import os
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
from pathlib import Path

# A new admin each time: create-admin keeps the password of an existing account
USER = f"uploads-e2e-{uuid.uuid4().hex[:8]}"
PROJECT = "e2e/uploads"
# A new commit each time: the checks don't depend on what an earlier run left
COMMIT = uuid.uuid4().hex + uuid.uuid4().hex[:8]


def log(message):
    print(f"\033[1m[uploads-e2e] {message}\033[0m", flush=True)


def fail(message):
    print(f"\033[31m[uploads-e2e] ERROR: {message}\033[0m", flush=True)
    sys.exit(1)


class Server:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, method, path, body=None, headers=None, expect=(200,)):
        """(status, body bytes). Fails on other statuses than `expect`."""
        url = path if path.startswith("http") else self.base + path
        data = body
        headers = dict(headers or {})
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode()
            headers.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=60) as r:
                status, content = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, content = e.code, e.read()
        except OSError as e:
            fail(f"{method} {url}: {e}")
        if status not in expect:
            fail(f"{method} {url}: HTTP {status}, expected {expect}: {content[:500]!r}")
        return status, content

    def get(self, path, accept=None):
        return self.request("GET", path, headers={"Accept": accept} if accept else None)[1]

    def json(self, method, path, body=None, headers=None, expect=(200,)):
        status, content = self.request(method, path, body, headers, expect)
        try:
            return status, json.loads(content)
        except ValueError:
            fail(f"{method} {path} did not return JSON: {content[:300]!r}")


def png(path, rgb, size=64):
    rows = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def junit(path, passed, failed=0):
    cases = [f'<testcase classname="e2e" name="passes_{i}" time="0.01"/>' for i in range(passed)]
    cases += [f'<testcase classname="e2e" name="fails_{i}" time="0.01"><failure message="no"/></testcase>' for i in range(failed)]
    path.write_text(f'<?xml version="1.0"?>\n<testsuite name="e2e" tests="{passed + failed}" failures="{failed}">{"".join(cases)}</testsuite>\n')


def wait_for(server, timeout=180):
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(f"{server.base}/api/v1/health", timeout=10) as r:
                if r.status == 200:
                    return
        except OSError:
            pass
        time.sleep(3)
    fail(f"{server.base} didn't answer in {timeout}s")


def check_defaults(server):
    _, config = server.json("GET", "/api/v1/config")
    uploads = config.get("uploads") or {}
    if not uploads.get("enabled"):
        fail(f"The server doesn't take uploaded files with its default settings: {uploads.get('off_reason')}")
    log(f"The server takes uploaded files, up to {uploads.get('max_file_size', 0) // 1024 ** 2} MB each")
    return config


def make_token(server, create_admin):
    password = uuid.uuid4().hex
    r = subprocess.run(shlex.split(create_admin), input=password + "\n", text=True, capture_output=True)
    if r.returncode:
        fail(f"{create_admin}: {r.stdout}{r.stderr}")
    status, body = server.request("POST", "/api/v1/user/auth/", urllib.parse.urlencode({"username": USER, "password": password}).encode(),
                                  {"Content-Type": "application/x-www-form-urlencoded"})
    # writes authenticated by cookies must come from the server's origin
    _, token = server.json("POST", "/api/v1/user/tokens", {"name": "uploads-e2e", "scopes": ["read", "ingest"], "expires_in_days": 1},
                           {"Origin": server.base}, expect=(201,))
    log(f"Signed in as {USER}, with a token")
    return token["token"]


def check_token_required(server):
    """Starting a run that sends its files needs a token, whatever the server says for other results (once the commit exists)"""
    payload = {"project": PROJECT, "commit_sha": COMMIT, "git_commit_sha": COMMIT, "storage": "upload", "input_path": "e2e/anonymous",
               "job_type": "ci", "batch_label": "default", "platform": "linux", "configurations": [], "extra_parameters": {},
               "database": "/"}
    # without the session cookie of the admin we signed in as
    anonymous = Server(server.base)
    status, body = anonymous.json("POST", "/api/v1/output/", payload, expect=(401, 403))
    log(f"Without a token: HTTP {status} ({body.get('reason') or body.get('error')})")
    # files: refused before their body is received (nginx asks the backend), with the backend's answer
    for path in ("/api/v1/output/1/files/stolen.txt", f"/api/v1/batch/submissions/{uuid.uuid4()}/log?offset=0"):
        status, body = anonymous.json("PUT", path, b"x" * 1024, {"Content-Type": "application/octet-stream"}, expect=(401,))
        if body.get("reason") != "login_required":
            fail(f"PUT {path} without a token: unexpected answer {body}")
    log("Files without a token are refused")


def qa_env(server, token):
    """Like a CI job of the project, wherever this runs: only the CI variables we set"""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("GITHUB_", "GITLAB_", "CI_", "JENKINS", "QA_", "QABOARD_")) and k != "CI"}
    env.update({
        "CI": "true",
        "GITHUB_ACTIONS": "true",
        "GITHUB_SHA": COMMIT,
        "GITHUB_REF": "refs/heads/e2e",
        "GITHUB_REPOSITORY": PROJECT,
        "GITHUB_JOB": "uploads-e2e",
        "GIT_MESSAGE": "uploads-e2e",
        "QABOARD_URL": server.base,
        "QABOARD_TOKEN": token,
        "QA_NO_CHECK_FOR_UPDATES": "1",
    })
    return env


def run(command, env, cwd, expect=0):
    r = subprocess.run(command, env=env, cwd=cwd, text=True, capture_output=True)
    print(r.stdout + r.stderr, flush=True)
    if r.returncode != expect:
        fail(f"{' '.join(map(str, command))} exited with {r.returncode}, expected {expect}")
    return r


def outputs_of(server, project=PROJECT, commit=COMMIT):
    _, body = server.json("GET", f"/api/v1/commit/{commit}?project={urllib.parse.quote(project)}")
    return [o for batch in body.get("batches", {}).values() for o in batch.get("outputs", {}).values()]


def find_run(server, input_path, project=PROJECT, commit=COMMIT, finished=True):
    outputs = outputs_of(server, project, commit)
    found = [o for o in outputs if o.get("test_input_path") == input_path]
    if len(found) != 1:
        fail(f"Expected one run of {input_path} in the commit, found {[o.get('test_input_path') for o in outputs]}")
    output = found[0]
    state = {k: output.get(k) for k in ("is_failed", "is_pending", "is_running")}
    if finished and any(state.values()):
        fail(f"The run of {input_path} didn't finish: {state}, {json.dumps(output.get('data'))[:500]}")
    url = output.get("output_dir_url") or ""
    if f"/{project}/-/" not in url:
        fail(f"The run of {input_path} isn't in the server's folder for uploads (<root>/<project>/-/...): {url}")
    return output, url


def listing(server, url):
    body = json.loads(server.get(f"{url}/", accept="application/json"))
    return {entry["name"] for entry in body.get("entries", [])}


def check_upload(server, env, workdir, proxy, config):
    junit(workdir / "junit.xml", passed=3)
    png(workdir / "image.png", (255, 0, 0))
    run([*QA, "upload", "--input", "e2e/report", "junit.xml", "image.png"], env, workdir)
    output, url = find_run(server, "e2e/report")
    metrics = output.get("metrics") or {}
    if metrics.get("tests") != 3 or metrics.get("passed") != 3:
        fail(f"The metrics weren't read from junit.xml: {metrics}")
    log(f"qa upload: {url}, metrics {metrics}")
    if proxy:
        if server.get(f"{url}/junit.xml") != (workdir / "junit.xml").read_bytes():
            fail(f"nginx doesn't serve {url}/junit.xml as it was sent")
        if not server.get(f"{url}/image.png").startswith(b"\x89PNG"):
            fail(f"{url}/image.png is not a PNG image")
        names = listing(server, url)
        if not {"junit.xml", "image.png"} <= names:
            fail(f"The backend's listing of {url}/ misses files: {sorted(names)}")
        endpoint = (config.get("image_servers") or {}).get("default", "/iiif/2/")
        identifier = f"{url[len('/s/'):]}/image.png".replace("/", "%2F")
        _, info = server.json("GET", f"{endpoint}{identifier}/info.json")
        if info.get("width") != 64:
            fail(f"Unexpected IIIF info for {url}/image.png: {info}")
        log("nginx serves the files, the backend lists them, the image server reads the image")
    return url


def check_reupload(server, env, workdir, proxy, first_url):
    """The same run again: the server empties its folder, only what's sent this time is there"""
    junit(workdir / "junit.xml", passed=2, failed=1)
    run([*QA, "upload", "--input", "e2e/report", "junit.xml"], env, workdir)
    output, url = find_run(server, "e2e/report")
    if url != first_url:
        fail(f"The run moved: {first_url} then {url}")
    metrics = output.get("metrics") or {}
    if metrics.get("tests") != 3 or metrics.get("failed") != 1:
        fail(f"The new metrics weren't read: {metrics}")
    if proxy:
        if server.get(f"{url}/junit.xml") != (workdir / "junit.xml").read_bytes():
            fail(f"{url}/junit.xml is still the first upload's")
        names = listing(server, url)
        if "image.png" in names:
            fail(f"The first upload's image.png is still in {url}/: {sorted(names)}")
    log(f"Uploaded again: the run's files were replaced, metrics {metrics}")


SDK_SCRIPT = r"""
import sys, qaboard
with qaboard.start_run("e2e/sdk", project=sys.argv[1], commit=sys.argv[2]) as run:
    for step in range(5):
        run.log({"loss": 1 / (step + 1)}, step=step)
    (run.output_dir / "result.txt").write_text("ok\n")
    run.log_metrics({"accuracy": 0.75})
"""


def check_sdk(server, env, workdir, proxy):
    (workdir / "sdk.py").write_text(SDK_SCRIPT)
    run([sys.executable, "sdk.py", PROJECT, COMMIT], env, workdir)
    output, url = find_run(server, "e2e/sdk")
    metrics = output.get("metrics") or {}
    if metrics.get("accuracy") != 0.75 or metrics.get("loss") != 0.2:
        fail(f"Unexpected metrics for the run of start_run(): {metrics}")
    if proxy:
        if server.get(f"{url}/result.txt").strip() != b"ok":
            fail(f"Unexpected content for {url}/result.txt")
        names = listing(server, url)
        if not {"result.txt", "series.jsonl"} <= names:
            fail(f"start_run()'s files aren't all in {url}/: {sorted(names)}")
    log(f"start_run(): {url}, metrics {metrics}")


def check_qa_run(server, env, workdir, proxy):
    """`qa run` in a project whose qaboard.yaml has a storage, with QA_STORAGE=upload: like a runner that doesn't mount it"""
    project = workdir / "sample_project"
    # not the runs that tests of this checkout left in it
    shutil.copytree(Path(importlib.util.find_spec("qaboard").origin).parent / "sample_project", project, ignore=shutil.ignore_patterns("output"))
    inputs = workdir / "inputs"
    inputs.mkdir()
    (inputs / "input.txt").write_text("hello\n")
    run_env = {**env, "QA_STORAGE": "upload", "GITHUB_REPOSITORY": SAMPLE_PROJECT}
    # sample_project's run() runs the command after "--" in the run's output folder
    run([*QA, "--share", "--database", str(inputs), "run", "--input", "input.txt", "--", "cp {input_path} {output_dir}/copy.txt"], run_env, project)
    output, url = find_run(server, "input.txt", project=SAMPLE_PROJECT)
    if proxy:
        if server.get(f"{url}/copy.txt") != b"hello\n":
            fail(f"Unexpected content for {url}/copy.txt")
        if "log.txt" not in listing(server, url):
            fail(f"qa run's log.txt isn't in {url}/")
        # what qa printed once it had sent the files
        if b"files to QA-Board" not in server.get(f"{url}/log.txt"):
            fail(f"The end of qa run's log isn't in {url}/log.txt: {server.get(f'{url}/log.txt')[-500:]!r}")
    log(f"qa run with QA_STORAGE=upload: {url}")
    check_bit_accuracy(server, run_env, project, inputs)


def check_bit_accuracy(server, env, project, inputs):
    """`qa check-bit-accuracy` on another commit, against the run above: the reference's manifests come from the server"""
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)  # it needs a repository, whatever the CI says
    command = [*QA, "--share", "--database", str(inputs), "run", "--input", "input.txt", "--", "cp {input_path} {output_dir}/copy.txt"]
    check = [*QA, "--share", "--database", str(inputs), "check-bit-accuracy", "--reference", COMMIT]
    same = uuid.uuid4().hex + uuid.uuid4().hex[:8]
    run(command, {**env, "GITHUB_SHA": same}, project)
    r = run(check, {**env, "GITHUB_SHA": same}, project)
    if "Nothing was compared" in r.stdout + r.stderr:
        fail("qa check-bit-accuracy compared nothing with the uploaded reference")
    log("qa check-bit-accuracy: bit-accurate to the uploaded reference")
    other = uuid.uuid4().hex + uuid.uuid4().hex[:8]
    (inputs / "input.txt").write_text("changed\n")
    try:
        run(command, {**env, "GITHUB_SHA": other}, project)
        run(check, {**env, "GITHUB_SHA": other}, project, expect=1)
    finally:
        (inputs / "input.txt").write_text("hello\n")
    log("qa check-bit-accuracy: other results aren't bit-accurate to it")


KILLED_SCRIPT = r"""
import sys, time, qaboard
run = qaboard.start_run("e2e/killed", project=sys.argv[1], commit=sys.argv[2])
run.log({"loss": 1.0}, step=0)
deadline = time.time() + 60
while run.id is None and time.time() < deadline:  # the server knows it
    time.sleep(0.5)
print(run.id, flush=True)
time.sleep(3600)
"""


def check_killed_run(server, env, workdir, minutes):
    """A run killed without a chance to say so is failed once it has been silent for QABOARD_SILENT_RUN_TIMEOUT_MINUTES"""
    (workdir / "killed.py").write_text(KILLED_SCRIPT)
    process = subprocess.Popen([sys.executable, "killed.py", PROJECT, COMMIT], env=env, cwd=workdir, stdout=subprocess.PIPE, text=True)
    try:
        run_id = process.stdout.readline().strip()
        if not run_id.isdigit():
            fail(f"The run of start_run() to kill didn't start: {run_id!r}")
        output, _ = find_run(server, "e2e/killed", finished=False)
        if not output.get("is_running"):
            fail(f"The run to kill isn't running: {json.dumps(output)[:500]}")
    finally:
        process.send_signal(signal.SIGKILL)
        process.wait()
    log(f"Killed run {run_id}: waiting for the server to fail it (silent for {minutes} minutes)")
    # the jobs worker looks every 30 seconds
    deadline = time.time() + minutes * 60 + 120
    while time.time() < deadline:
        output, _ = find_run(server, "e2e/killed", finished=False)
        if output.get("is_failed") and not output.get("is_running"):
            data = output.get("data") or {}
            if "silent_since" not in data:
                fail(f"The killed run failed, but not for being silent: {json.dumps(data)[:500]}")
            log(f"The killed run was failed: {data.get('failed_reason')}")
            return
        time.sleep(10)
    fail(f"The killed run is still {'running' if output.get('is_running') else 'not failed'} after {minutes} minutes and 2 more: "
         f"is the server's QABOARD_SILENT_RUN_TIMEOUT_MINUTES {minutes}?")


ARTIFACTS_PROJECT = "e2e/artifacts"
ARTIFACTS_PROJECT_FILES = {
    "qaboard.yaml": """project:
  name: e2e/artifacts
  url: https://git.example.com/e2e/artifacts
  entrypoint: qa/main.py
inputs:
  database: {linux: data, windows: data}
  batches: qa/batches.yaml
artifacts:
  data: {glob: "data/*"}
""",
    "qa/batches.yaml": "e2e:\n  inputs:\n    - a.txt\n    - b.txt\n",
    "qa/main.py": """def run(context):
    text = context.input_path.read_text()
    (context.output_dir / "upper.txt").write_text(text.upper())
    return {"length": len(text)}
""",
    "data/a.txt": "hello\n",
    "data/b.txt": "artifacts\n",
}


def check_artifacts(server, env, workdir, proxy):
    """
    A project without a shared storage: `qa save-artifacts` sends its artifacts, `qa fetch-artifacts` downloads them,
    and a batch started from the web app runs from them on the server, its runs sending their results with the
    batch's token.
    """
    project = workdir / "artifacts_project"
    for path, content in ARTIFACTS_PROJECT_FILES.items():
        (project / path).parent.mkdir(parents=True, exist_ok=True)
        (project / path).write_text(content)
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    project_env = {**env, "GITHUB_REPOSITORY": ARTIFACTS_PROJECT}
    run([*QA, "save-artifacts"], project_env, project)
    query = f"project={urllib.parse.quote(ARTIFACTS_PROJECT)}"
    _, artifacts = server.json("GET", f"/api/v1/commit/{COMMIT}/artifacts?{query}")
    if not {"qaboard.yaml", "qa/main.py", "data/a.txt"} <= set(artifacts.get("files", {})):
        fail(f"The commit's artifacts miss files: {sorted(artifacts.get('files', {}))}")
    # again: nothing new to send, the same artifacts
    run([*QA, "save-artifacts"], project_env, project)
    _, again = server.json("GET", f"/api/v1/commit/{COMMIT}/artifacts?{query}")
    if again.get("hash") != artifacts.get("hash"):
        fail("Sending the same artifacts again changed them")
    log(f"qa save-artifacts: {len(artifacts['files'])} files")

    if proxy:
        cache = workdir / "artifacts-cache"
        r = subprocess.run([*QA, "fetch-artifacts", "--project", ARTIFACTS_PROJECT, "--commit", COMMIT], env={**env, "QABOARD_ARTIFACTS_CACHE": str(cache)},
                           cwd=workdir, text=True, capture_output=True)
        print(r.stderr, flush=True)
        if r.returncode:
            fail(f"qa fetch-artifacts failed ({r.returncode}): {r.stdout}")
        fetched = Path(r.stdout.strip())
        if not fetched.is_relative_to(cache) or (fetched / "qa/main.py").read_text() != ARTIFACTS_PROJECT_FILES["qa/main.py"]:
            fail(f"qa fetch-artifacts didn't fetch qa/main.py as it was sent, in {fetched}")
        log(f"qa fetch-artifacts: {fetched}")

    # Started as from the web app (signed in): the server runs `qa batch` from the artifacts, with a token for its runs
    body = {"batch_label": "e2e-from-server", "selected_group": "e2e", "notify": False}
    _, check = server.json("POST", f"/api/v1/commit/{COMMIT}/batch/check?{query}", body, headers={"Origin": server.base})
    if check.get("errors"):
        fail(f"QA-Board refuses to start a batch from the uploaded artifacts: {check['errors']}")
    _, started = server.json("POST", f"/api/v1/commit/{COMMIT}/batch?{query}", body, headers={"Origin": server.base})
    log(f"Started a batch from the web app: {started.get('submission', {}).get('status')}")
    deadline = time.time() + 180
    while True:
        _, commit = server.json("GET", f"/api/v1/commit/{COMMIT}?{query}&batch=e2e-from-server")
        outputs = [o for b in commit.get("batches", {}).values() for o in b.get("outputs", {}).values()]
        done = [o for o in outputs if not o.get("is_pending") and not o.get("is_running")]
        if len(done) == 2:
            break
        if time.time() > deadline:
            submission = started.get("submission", {})
            fail(f"The batch started from the web app didn't finish: {[(o.get('test_input_path'), o.get('is_failed')) for o in outputs]}, "
                 f"see its log in {submission.get('log_dir')}")
        time.sleep(3)
    failed = [o.get("test_input_path") for o in done if o.get("is_failed")]
    lengths = sorted((o.get("metrics") or {}).get("length") for o in done)
    if failed or lengths != [6, 10]:
        fail(f"The runs of the batch started from the web app failed ({failed}) or have unexpected metrics ({lengths})")
    url = done[0].get("output_dir_url") or ""
    if f"/{ARTIFACTS_PROJECT}/-/" not in url:
        fail(f"The runs started from the web app didn't send their files to the server: {url}")
    if proxy and server.get(f"{url}/upper.txt").strip() not in (b"HELLO", b"ARTIFACTS"):
        fail(f"Unexpected content for {url}/upper.txt")
    log(f"The batch started from the web app ran from the uploaded artifacts: {url}")


QA = [sys.executable, "-m", "qaboard"]
SAMPLE_PROJECT = "user/sample_project"  # project.name in qaboard/sample_project/qaboard.yaml


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", help="QA-Board, e.g. http://localhost:5151")
    parser.add_argument("--create-admin", required=True, help=f"A command that makes {USER} an admin, reading its password on stdin")
    parser.add_argument("--no-proxy", action="store_true", help="Only the API: URL is the backend, without nginx and the image server")
    parser.add_argument("--silent-runs-after", type=float, help="The server's QABOARD_SILENT_RUN_TIMEOUT_MINUTES: checks that a killed run is failed")
    args = parser.parse_args()
    server = Server(args.url)
    proxy = not args.no_proxy
    wait_for(server)
    config = check_defaults(server)
    token = make_token(server, args.create_admin.replace("{user}", USER))
    with tempfile.TemporaryDirectory(prefix="qaboard-uploads-e2e-") as tmp:
        workdir = Path(tmp)
        env = qa_env(server, token)
        url = check_upload(server, env, workdir, proxy, config)
        check_token_required(server)
        check_reupload(server, env, workdir, proxy, url)
        check_sdk(server, env, workdir, proxy)
        check_qa_run(server, env, workdir, proxy)
        check_artifacts(server, env, workdir, proxy)
        if args.silent_runs_after:
            check_killed_run(server, env, workdir, args.silent_runs_after)
        else:
            log("Not checked: a killed run is failed (--silent-runs-after)")
    log("All checks passed")


if __name__ == "__main__":
    main()
