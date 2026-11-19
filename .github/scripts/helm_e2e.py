#!/usr/bin/env python3
"""
Runs real batches in the cluster of CI's helm-e2e job, then checks their results through QA-Board.
Usage: helm_e2e.py URL [--release qaboard] [--timeout 600] [--kubernetes]
Run it with the qaboard package of this checkout (`uv run --frozen python .github/scripts/helm_e2e.py ...`): it sends a
project's artifacts with `qa save-artifacts`.

1. A Job runs the `qa` CLI of the backend image on qaboard/sample_project, like a CI pipeline would (CI=true,
   GITHUB_SHA...): 2 runs that each save an image and a text file. The Job mounts the results volume of the
   backend at the same path, and sends results to the proxy's Service.
2. Through QA-Board at URL (e.g. a port-forward to the proxy), checks that:
   - the project, the commit, its batch and its 2 successful runs exist
   - nginx serves the runs' files under /s/<path>, and the backend lists their folder (the web app's file browser)
   - Cantaloupe serves the image, where the web app asks for it (IIIF)
3. A batch started from the web app, for a project without a shared storage (`qa save-artifacts` sent its
   artifacts): the backend's own `qa batch` (the local runner) fetches them, reaches QA-Board at QABOARD_HOST, and its
   runs send their results with the batch's token, which expires soon after they end.
4. With `ingest.auth: token`, a batch started from the web app for a project with the shared storage: its runs get a
   token too.
With --kubernetes (the chart installed with runners.kubernetes.enabled), only a batch started from the web app, on
Kubernetes: its `qa batch` runs in a driver pod that fetches the artifacts, starts the runs' Jobs, whose pods fetch
them too and send their results with the batch's token. Then a batch stopped from the web app: its Jobs are deleted,
its token revoked.
Prints the logs of what failed.

3. and 4. need the local runner, off by default: CI's helm install sets QABOARD_TUNING_RUNNER=local.

On your computer, after the quickstart's commands (website/docs/get-started/quickstart.mdx, with images of this
checkout), like CI's helm-e2e job:
  helm upgrade qaboard charts/qaboard -f charts/qaboard/quickstart.yaml --wait --reuse-values --set config.QABOARD_TUNING_RUNNER=local
  kubectl port-forward svc/qaboard-proxy 5151:80 &
  uv run --frozen python .github/scripts/helm_e2e.py http://localhost:5151
  helm upgrade qaboard charts/qaboard -f charts/qaboard/quickstart.yaml --wait --reuse-values --set config.QABOARD_TUNING_RUNNER=kubernetes \
    --set runners.kubernetes.enabled=true --set 'runners.kubernetes.namespaces={default}' --set-string runners.kubernetes.runAs=1000:1000
  # the backend restarted: start the port-forward again
  kubectl port-forward svc/qaboard-proxy 5151:80 &
  uv run --frozen python .github/scripts/helm_e2e.py http://localhost:5151 --kubernetes
"""
import argparse
import datetime
import http.cookiejar
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

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


def job_manifest(release, token):
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
        # results need a token by default (ingest.auth)
        "QABOARD_TOKEN": token,
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


def run_job(release, timeout, token):
    mount_path, manifest = job_manifest(release, token)
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


# ---- Batches started from the web app, for projects without a shared storage

class Session:
    """Signed in to QA-Board, like the web app: a session cookie, and the server's Origin for writes"""
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, method, path, body=None, form=False, expect=(200,)):
        headers = {"Origin": self.base}
        data = None
        if form:
            data = urllib.parse.urlencode(body).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        elif body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=60) as r:
                status, content = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, content = e.code, e.read()
        except OSError as e:
            fail(f"{method} {path}: {e}")
        if status not in expect:
            fail(f"{method} {path}: HTTP {status}, expected {expect}: {content[:1000]!r}")
        return json.loads(content) if content else {}


def sign_in(base, release):
    """A new admin with a local account (qaboard-admin create-admin, in the backend's pod), signed in, with a token"""
    user, password = f"helm-e2e-{uuid.uuid4().hex[:8]}", uuid.uuid4().hex
    r = subprocess.run(["kubectl", "exec", "-i", f"deploy/{release}-backend", "-c", "backend", "--",
                        "qaboard-admin", "create-admin", user, "--password"], input=password + "\n", text=True, capture_output=True)
    if r.returncode:
        fail(f"qaboard-admin create-admin: {r.stdout}{r.stderr}")
    session = Session(base)
    session.request("POST", "/api/v1/user/auth/", {"username": user, "password": password}, form=True)
    token = session.request("POST", "/api/v1/user/tokens", {"name": "helm-e2e", "scopes": ["read", "ingest"], "expires_in_days": 1}, expect=(201,))["token"]
    log(f"Signed in as {user}")
    return session, token


def artifacts_project(name, kubernetes_image=None, storage=None):
    """
    A project without `storage`: its runs send their results over HTTP. Its inputs are in its artifacts. With
    `kubernetes_image`, its runs are pods (runners.kubernetes, in the namespace of QA-Board, as the server allows).
    With `storage`, a storage shared with the server, where `qa save-artifacts` copies them.
    """
    runners = f"""runners:
  default: kubernetes
  kubernetes:
    image: {kubernetes_image}
    resources: {{cpu: 100m, memory: 256Mi}}
""" if kubernetes_image else ""
    return {
        "qaboard.yaml": f"""project:
  name: {name}
  url: https://git.example.com/{name}
  entrypoint: qa/main.py
inputs:
  database: {{linux: data, windows: data}}
  batches: qa/batches.yaml
artifacts:
  data: {{glob: "data/*"}}
{runners}{f"storage: {storage}" if storage else ""}
""",
        "qa/batches.yaml": "e2e:\n  inputs: [a.txt, b.txt]\nslow:\n  inputs: [slow.txt]\n",
        "qa/main.py": """import time
def run(context):
    text = context.input_path.read_text()
    if text.startswith("slow"):
        time.sleep(600)
    (context.output_dir / "upper.txt").write_text(text.upper())
    return {"length": len(text)}
""",
        "data/a.txt": "hello\n",
        "data/b.txt": "artifacts\n",
        "data/slow.txt": "slow\n",
    }


def save_artifacts(base, token, project_name, files, commit):
    """`qa save-artifacts` from this checkout, as the project's CI would"""
    with tempfile.TemporaryDirectory(prefix="qaboard-helm-e2e-") as tmp:
        project = Path(tmp)
        for path, content in files.items():
            (project / path).parent.mkdir(parents=True, exist_ok=True)
            (project / path).write_text(content)
        subprocess.run(["git", "init", "-q"], cwd=project, check=True)
        env = {k: v for k, v in os.environ.items() if not k.startswith(("GITHUB_", "GITLAB_", "CI_", "JENKINS", "QA_", "QABOARD_")) and k != "CI"}
        env.update({"CI": "true", "GITHUB_ACTIONS": "true", "GITHUB_SHA": commit, "GITHUB_REF": "refs/heads/e2e",
                    "GITHUB_REPOSITORY": project_name, "GIT_MESSAGE": "helm-e2e", "QABOARD_URL": base,
                    "QABOARD_TOKEN": token, "QA_NO_CHECK_FOR_UPDATES": "1"})
        r = subprocess.run([sys.executable, "-m", "qaboard", "save-artifacts"], cwd=project, env=env, text=True, capture_output=True)
        print(r.stdout + r.stderr, flush=True)
        if r.returncode:
            fail(f"qa save-artifacts failed ({r.returncode})")


def batch_tokens(session, command_id):
    """The active tokens of the batch (the tokens list shows the server's short-lived tokens only while active)"""
    tokens = session.request("GET", "/api/v1/user/tokens")["tokens"]
    return [t for t in tokens if t["kind"] == "batch" and (t.get("data") or {}).get("command_id") == command_id]


def start_batch(session, project_name, commit, label, batch):
    query = f"project={urllib.parse.quote(project_name)}"
    body = {"batch_label": label, "selected_group": batch, "notify": False}
    check = session.request("POST", f"/api/v1/commit/{commit}/batch/check?{query}", body)
    if check.get("errors"):
        fail(f"QA-Board refuses to start a batch from the uploaded artifacts: {check['errors']}")
    started = session.request("POST", f"/api/v1/commit/{commit}/batch?{query}", body)
    submission = started.get("submission", {})
    log(f"Started the batch {label} from the web app: {started.get('cmd')} runner, {submission.get('status')}")
    return started.get("cmd"), submission


def batch_runs(session, project_name, commit, label):
    query = f"project={urllib.parse.quote(project_name)}&batch={urllib.parse.quote(label)}"
    commit_data = session.request("GET", f"/api/v1/commit/{commit}?{query}")
    batch = commit_data.get("batches", {}).get(label, {})
    return batch, list(batch.get("outputs", {}).values())


def submission_log(release, submission):
    """The log of `qa batch`, read in the backend's pod: the results volume is mounted there"""
    log_dir = submission.get("log_dir")
    if not log_dir:
        return ""
    return kubectl("exec", f"deploy/{release}-backend", "-c", "backend", "--", "sh", "-c",
                   f"cat {log_dir}/log.pending.txt {log_dir}/log.txt 2>/dev/null | tail -100", check=False)


def kubernetes_debug(command_id):
    selector = f"qaboard.io/command-id={command_id}"
    print(kubectl("get", "jobs,pods", "-l", selector, "-o", "wide", check=False))
    for pod in kubectl("get", "pods", "-l", selector, "-o", "name", check=False).split():
        print(f"--- {pod}\n" + kubectl("logs", pod, "--all-containers", "--tail", "60", check=False), flush=True)


def check_batch_from_web_app(base, release, timeout, kubernetes, session, token, storage=None):
    """
    A batch started from the web app: without a shared storage, on the backend (`local`) or on Kubernetes, or with
    `storage`, a storage shared with the server. Its runs end with their metrics and files, and the batch's token is
    revoked.
    """
    runner = "kubernetes" if kubernetes else "local"
    image = None
    if kubernetes:
        # the runs' pods use the backend's image: it has this checkout's qaboard, with the kubernetes extra
        deployment = kubectl("get", "deployment", f"{release}-backend", "-o", "json", json_output=True)
        image = next(c for c in deployment["spec"]["template"]["spec"]["containers"] if c["name"] == "backend")["image"]
    # In the shared storage, the project's folder is created by `qa save-artifacts` here, as this user: not in a group
    # folder the server (another user, e.g. root) created for other projects' runs
    project_name = f"e2e-shared-storage/web-app-{runner}" if storage else f"e2e/web-app-{runner}"
    commit = uuid.uuid4().hex + uuid.uuid4().hex[:8]
    save_artifacts(base, token, project_name, artifacts_project(project_name, image, storage), commit)

    label = f"from-web-app-{runner}"
    cmd, submission = start_batch(session, project_name, commit, label, "e2e")
    command_id = submission.get("id")
    if cmd != runner:
        fail(f"The server started the batch with its {cmd} runner, not {runner}: is runners.kubernetes.enabled {kubernetes}?")
    # minted before the batch starts
    if not [t for t in batch_tokens(session, command_id) if t["status"] == "active"]:
        fail("The batch has no active token while it runs")
    start = time.time()
    while True:
        _, outputs = batch_runs(session, project_name, commit, label)
        done = [o for o in outputs if not o.get("is_pending") and not o.get("is_running")]
        if len(done) == 2:
            break
        if time.time() - start > timeout:
            print(submission_log(release, submission), flush=True)
            if kubernetes:
                kubernetes_debug(command_id)
            fail(f"The batch started from the web app didn't finish in {timeout}s: {[(o.get('test_input_path'), o.get('is_pending'), o.get('is_failed')) for o in outputs]}")
        time.sleep(5)
    log(f"Its runs ended in {time.time() - start:.0f}s")
    failed = [o.get("test_input_path") for o in done if o.get("is_failed")]
    lengths = sorted((o.get("metrics") or {}).get("length") for o in done)
    if failed or lengths != [6, 10]:
        print(submission_log(release, submission), flush=True)
        if kubernetes:
            kubernetes_debug(command_id)
        fail(f"The runs failed ({failed}) or have unexpected metrics ({lengths})")
    for output in done:
        url = output.get("output_dir_url") or ""
        if storage and not url.startswith(f"/s{storage}/{project_name}/"):
            fail(f"The run didn't save its files in the shared storage: {url}")
        if not storage and f"/{project_name}/-/" not in url:
            fail(f"The run didn't send its files to the server's folder for uploads: {url}")
        text = (ARTIFACT_INPUTS[output["test_input_path"]]).upper().encode()
        if get(base, f"{url}/upper.txt") != text:
            fail(f"Unexpected content for {url}/upper.txt")
    log(f"The runs sent their metrics and files: {done[0].get('output_dir_url')}")
    # where the web app reads it: on Kubernetes without a shared storage, the driver pod sent it
    batch_log = ""
    for _ in range(10):
        batch_log = submission_log(release, submission)
        if "[qaboard] qa batch exited with code 0" in batch_log:
            break
        time.sleep(2)
    else:
        if kubernetes:
            kubernetes_debug(command_id)
        fail(f"The log of `qa batch` isn't complete in its folder on the server:\n{batch_log}")
    log("The log of `qa batch` is in its folder on the server")

    if kubernetes:
        jobs = kubectl("get", "jobs", "-l", f"qaboard.io/command-id={command_id}", "-o", "json", json_output=True)["items"]
        roles = sorted(j["metadata"]["labels"].get("qaboard.io/role", "runs") for j in jobs)
        if roles != ["driver", "runs"]:
            kubernetes_debug(command_id)
            fail(f"Expected the driver's Job and the runs' Job, labeled with the batch's command id: {roles}")
        log("qa batch ran in a driver pod, the runs in a Job of their own")

    # the driver may still send the end of its log: the token expires a little later
    soon = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=11)
    lasting = [t for t in batch_tokens(session, command_id) if datetime.datetime.fromisoformat(t["expires_at"]) > soon]
    if lasting:
        fail(f"The batch's token doesn't end soon after its runs ended: {lasting}")
    log("The batch's token ends soon after its runs ended")
    if kubernetes:
        check_stopped_batch(base, release, session, project_name, commit, timeout)


def check_stopped_batch(base, release, session, project_name, commit, timeout):
    """A batch stopped from the web app while its run is running: its Jobs are deleted, its token revoked"""
    label = "stopped-from-web-app"
    _, submission = start_batch(session, project_name, commit, label, "slow")
    command_id = submission["id"]
    selector = f"qaboard.io/command-id={command_id}"
    start = time.time()
    while True:
        batch, outputs = batch_runs(session, project_name, commit, label)
        if outputs and outputs[0].get("is_running"):
            break
        if time.time() - start > timeout:
            print(submission_log(release, submission), flush=True)
            kubernetes_debug(command_id)
            fail(f"The slow run didn't start in {timeout}s: {outputs}")
        time.sleep(3)
    # the token is in the driver's ConfigMap: the pods get it from there
    configmaps = kubectl("get", "configmaps", "-l", selector, "-o", "json", json_output=True)["items"]
    secret = next((line.split("=", 1)[1].strip("'\"") for c in configmaps for v in c.get("data", {}).values()
                   for line in v.splitlines() if "QABOARD_TOKEN=" in line), None)
    status = session.request("POST", "/api/v1/batch/stop", {"id": batch["id"]})
    log(f"Stopped the batch: {status}")
    for _ in range(60):
        if not kubectl("get", "pods", "-l", selector, "-o", "name", check=False).strip():
            break
        time.sleep(2)
    else:
        fail(f"The pods of the stopped batch are still there: {kubectl('get', 'pods', '-l', selector, check=False)}")
    if kubectl("get", "jobs", "-l", selector, "-o", "name", check=False).strip():
        fail("The Jobs of the stopped batch are still there")
    if batch_tokens(session, command_id):
        fail("The token of the stopped batch is still active")
    if secret:
        request = urllib.request.Request(f"{base}/api/v1/user/tokens", headers={"Authorization": f"Bearer {secret}"})
        try:
            urllib.request.urlopen(request, timeout=30)
            fail("The token of the stopped batch still works")
        except urllib.error.HTTPError as e:
            if e.code != 401:
                fail(f"Unexpected answer with the token of the stopped batch: HTTP {e.code}")
    else:
        fail("Could not find the batch's token in its driver's ConfigMap")
    log("The stopped batch's Jobs were deleted, and its token revoked")


ARTIFACT_INPUTS = {"a.txt": "hello\n", "b.txt": "artifacts\n"}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", help="QA-Board, e.g. http://localhost:5151")
    parser.add_argument("--release", default="qaboard")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--kubernetes", action="store_true", help="Only a batch started from the web app, on Kubernetes (runners.kubernetes.enabled)")
    args = parser.parse_args()
    base = args.url.rstrip("/")
    session, token = sign_in(base, args.release)
    if not args.kubernetes:
        mount_path = run_job(args.release, args.timeout, token)
        check_results(base, mount_path)
    check_batch_from_web_app(base, args.release, args.timeout, args.kubernetes, session, token)
    if not args.kubernetes:
        # Servers that require tokens for results: the runs of a project with a shared storage get one too
        session.request("POST", "/api/v1/admin/settings", {"ingest.auth": "token"})
        try:
            # each of the backend's processes caches the settings for a few seconds
            for _ in range(10):
                if all(session.request("GET", "/api/v1/config").get("ingest_auth") == "token" for _ in range(4)):
                    break
                time.sleep(1)
            check_batch_from_web_app(base, args.release, args.timeout, False, session, token, storage=mount_path)
        finally:
            session.request("POST", "/api/v1/admin/settings", {"ingest.auth": None})
    log("All checks passed")


if __name__ == "__main__":
    main()
