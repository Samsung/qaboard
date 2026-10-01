#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = []
# ///
"""
Deploys QA-Board with docker compose, with zero-downtime rolling updates of the backend.

Usage (from the root of the repository):
    deployments/deploy.py ENV_FILE up [--version VERSION] [--build]
    deployments/deploy.py ENV_FILE rollback
    deployments/deploy.py ENV_FILE status
    deployments/deploy.py ENV_FILE restore-db [DUMP|latest]
    deployments/deploy.py ENV_FILE compose ARGS...     # e.g. compose logs -f backend

ENV_FILE describes an environment, e.g. deployments/sirc/production.env. It's a docker compose env file
that sets at least COMPOSE_FILE and COMPOSE_PROJECT_NAME. Variables from the shell take precedence.

`up` does:
1. Pull the images for $QABOARD_VERSION (or build them with --build)
2. Run database migrations once. If they fail, nothing running is changed.
3. Update the infrastructure services (db, redis, proxy...). They are only recreated if their config/image changed.
4. Rolling update of the backend: start the new replicas next to the old ones, wait until they are healthy,
   point nginx at them, then stop the old ones gracefully. If the new replicas are not healthy, they are removed
   and the old ones keep serving.
5. Update the frontend/docs bundles (old bundles are kept, so clients with an old version keep working)
6. Record the version for `rollback`/`status`, remove old images to keep the disk from filling up.

No dependencies: runs with `python3` or `uv run`.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
# Bundles copied to volumes by one-shot containers, updated after the backend
STATIC_SERVICES = ["frontend", "website"]
KEEP_IMAGES = 3  # versions kept locally for fast rollbacks
DRAIN_SECONDS = 5  # after switching nginx to the new replicas, before stopping the old ones


def log(msg: str) -> None:
    print(f"\033[1m[deploy {datetime.now():%H:%M:%S}] {msg}\033[0m", flush=True)


def die(msg: str) -> None:
    print(f"\033[31m[deploy] ERROR: {msg}\033[0m", file=sys.stderr, flush=True)
    sys.exit(1)


def read_env_file(path: Path) -> Dict[str, str]:
    """Minimal parser for docker compose env files (KEY=VALUE, comments, optional quotes)."""
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        env[key] = value
    return env


class Deployment:
    def __init__(self, env_file: str, version: Optional[str] = None):
        self.env_file = Path(env_file).resolve()
        if not self.env_file.exists():
            die(f"{env_file} does not exist")
        file_env = read_env_file(self.env_file)
        # Like docker compose: the shell's environment takes precedence over the env file
        self.settings = {**file_env, **{k: os.environ[k] for k in file_env if k in os.environ}}
        self.project = self.settings.get("COMPOSE_PROJECT_NAME") or die(f"Set COMPOSE_PROJECT_NAME in {env_file}")
        self.state_path = ROOT / f".deploy-state.{self.project}.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {"history": []}
        self.version = version or os.environ.get("QABOARD_VERSION") or self.deployed_version()
        self.env = {**os.environ}
        if self.version:
            self.env["QABOARD_VERSION"] = self.version
        else:
            self.env.pop("QABOARD_VERSION", None)

    # --- helpers ---
    def compose_cmd(self, *args: str) -> List[str]:
        return ["docker", "compose", "--project-directory", str(ROOT), "--env-file", str(self.env_file), *args]

    def compose(self, *args: str, check=True, capture=False) -> subprocess.CompletedProcess:
        cmd = self.compose_cmd(*args)
        if not capture:
            print("+ docker compose " + " ".join(shlex.quote(a) for a in args), flush=True)
        r = subprocess.run(cmd, cwd=ROOT, env=self.env, text=True, capture_output=capture)
        if check and r.returncode:
            die(f"`docker compose {' '.join(args)}` failed{': ' + r.stderr.strip() if capture else ''}")
        return r

    def docker(self, *args: str, check=True) -> str:
        r = subprocess.run(["docker", *args], text=True, capture_output=True)
        if check and r.returncode:
            die(f"`docker {' '.join(args)}` failed: {r.stderr.strip()}")
        return r.stdout.strip()

    def config(self) -> dict:
        out = self.compose("config", "--format", "json", capture=True).stdout
        return json.loads(out)

    def containers(self, service: str, all_states=True) -> List[str]:
        args = ["ps", "-q", "--filter", f"label=com.docker.compose.project={self.project}",
                "--filter", f"label=com.docker.compose.service={service}"]
        if all_states:
            args.insert(1, "-a")
        return self.docker(*args).split()

    def health(self, container: str) -> str:
        return self.docker("inspect", "-f", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", container)

    def deployed_version(self) -> Optional[str]:
        return self.state.get("current")

    def proxy_running(self, services: List[str]) -> bool:
        return "proxy" in services and bool(self.containers("proxy", all_states=False))

    def set_upstream(self, services: List[str], containers: List[str]) -> None:
        """
        Points nginx at specific backend containers.
        Old replicas must stop receiving new requests *before* they are stopped: during a graceful shutdown
        uwsgi still accepts connections but never answers them, and nginx can't retry non-idempotent requests.
        """
        if not self.proxy_running(services):
            return
        ips = [self.docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", c).split()[0] for c in containers]
        servers = "".join(f"server {ip}:3000 max_fails=1 fail_timeout=5s;\n" for ip in ips)
        r = self.compose("exec", "-T", "proxy", "sh", "-c",
                         'printf "%s" "$1" > /etc/nginx/upstreams/backend.conf && nginx -t -q && nginx -s reload',
                         "_", servers, check=False)
        if r.returncode:
            log("WARNING: could not point nginx at the new replicas: requests to the old ones may fail while they stop")

    def reconfigure_proxy(self, services: List[str]) -> None:
        """Applies nginx config changes, and points nginx at the "backend" DNS name (all running replicas)."""
        if not self.proxy_running(services):
            return
        r = self.compose("exec", "-T", "proxy", "sh", "/tmp/etc/nginx/configure.sh", "--reload", check=False)
        if r.returncode:
            # Restarting nginx with an invalid config would take everything down: it keeps running with the previous one
            die("Could not reload nginx, is the configuration valid? It still runs with the previous one.")

    def only_tag_changed(self, service: str, config: dict) -> bool:
        """
        Every version has its own image tags, so compose would recreate e.g. nginx at every deploy, causing a short downtime.
        We don't if the image is the same and nothing else changed.
        """
        running = self.containers(service, all_states=False)
        image = config["services"][service].get("image", "")
        if len(running) != 1 or not self.version or not image.endswith(f"-{self.version}"):
            return False
        running_image, running_id, running_hash = self.docker(
            "inspect", "-f", '{{.Config.Image}} {{.Image}} {{index .Config.Labels "com.docker.compose.config-hash"}}', running[0]).split()
        if running_id != self.docker("image", "inspect", "-f", "{{.Id}}", image, check=False):
            return False
        prefix = image[: -len(self.version) - 1]  # repo:service
        env = {**self.env}
        if running_image.startswith(f"{prefix}-"):
            env["QABOARD_VERSION"] = running_image[len(prefix) + 1:]
        elif running_image == prefix:
            env.pop("QABOARD_VERSION", None)
        else:
            return False
        r = subprocess.run(self.compose_cmd("config", "--hash", service), cwd=ROOT, env=env, text=True, capture_output=True)
        return r.returncode == 0 and r.stdout.split()[-1:] == [running_hash]

    def up_services(self, services: List[str], config: dict, *flags: str) -> List[str]:
        """Returns the services that were (re)created if they changed."""
        todo = [s for s in services if not self.only_tag_changed(s, config)]
        skipped = sorted(set(services) - set(todo))
        if skipped:
            log(f"Unchanged, not recreated: {' '.join(skipped)}")
        if todo:
            self.compose("up", "-d", "--no-deps", "--no-build", *flags, *todo)
        return todo

    def run_hook(self) -> None:
        # e.g. at SIRC: make sure autofs mounts are mounted before we bind them in containers
        hook = self.settings.get("QABOARD_DEPLOY_PRE_HOOK")
        if hook:
            log(f"Running pre-deploy hook: {hook}")
            subprocess.run(hook, shell=True, cwd=ROOT, env=self.env, check=True)

    # --- deploy ---
    def up(self, build: bool = False, pull: bool = True, init: bool = False) -> None:
        log(f"Deploying {self.project} version={self.version or '(untagged)'} with {self.env_file}")
        config = self.config()
        existing = self.docker("ps", "-aq", "--filter", f"label=com.docker.compose.project={self.project}") or \
                   self.docker("volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={self.project}")
        if not existing and not init:
            die(f"There are no containers or volumes for the compose project '{self.project}'. "
                "If COMPOSE_PROJECT_NAME is wrong we would start with an empty database! "
                "Check `docker compose ls`. If this really is a new deployment, pass --init.")
        services = list(config["services"])
        backend = config["services"].get("backend")
        if not backend:
            die("No backend service in the compose configuration")
        replicas = int(self.settings.get("QABOARD_BACKEND_REPLICAS") or (backend.get("deploy") or {}).get("replicas") or 1)
        self.run_hook()

        # 1. Images
        built = [name for name, s in config["services"].items() if s.get("build")]
        built_images = {config["services"][name]["image"] for name in built}
        ours = [name for name, s in config["services"].items() if name in built or s.get("image") in built_images]
        if build:
            self.compose("build", *built)
        elif pull:
            # We only pull our images, so that a new upstream release of e.g. postgres doesn't restart the database.
            # Versioned tags never change: no need to contact the registry if we have them (e.g. fast rollbacks)
            self.compose("pull", "--policy", "missing" if self.version else "always", *ours)

        # 2. Migrations
        if "db" in services:
            self.compose("up", "-d", "--no-build", "--no-recreate", "db")
        log("Applying database migrations")
        self.compose("run", "--rm", "--no-deps", "--pull", "never", "backend", "bash", "-c",
                     './wait-for-it.sh "${QABOARD_DB_HOST:-db}:${QABOARD_DB_PORT:-5432}" -t 120 -- /qaboard/backend/migrate.sh')

        # 3. Infrastructure (only recreated if they changed)
        infra = [s for s in services if s not in ("backend", "proxy", *STATIC_SERVICES)]
        if infra:
            self.up_services(infra, config, "--remove-orphans")

        # 4. Backend
        self.rolling_update("backend", replicas, services)

        # 5. Proxy (after the backend: nginx doesn't start if "backend" can't be resolved) and static bundles
        last = [s for s in ("proxy", *STATIC_SERVICES) if s in services]
        if last and "proxy" not in self.up_services(last, config):
            self.reconfigure_proxy(services)  # the proxy wasn't recreated: apply nginx config changes

        # 6. Bookkeeping
        if self.version and self.version != self.state.get("current"):
            if self.state.get("current"):
                self.state["previous"] = self.state["current"]
            self.state["current"] = self.version
        self.state["history"] = (self.state.get("history", []) + [{
            "version": self.version,
            "date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "by": os.environ.get("GITLAB_USER_LOGIN") or os.environ.get("USER"),
            "pipeline": os.environ.get("CI_PIPELINE_URL"),
        }])[-50:]
        self.state_path.write_text(json.dumps(self.state, indent=2))
        self.cleanup_images(config, ours)
        log(f"✅ Deployed {self.project} {self.version or ''}")

    def rolling_update(self, service: str, replicas: int, services: List[str]) -> None:
        for c in self.containers(service):
            if self.health(c).startswith(("exited", "dead", "created")):
                self.docker("rm", "-f", c)
        old = self.containers(service)

        image = self.config()["services"][service]["image"]
        image_id = self.docker("image", "inspect", "-f", "{{.Id}}", image, check=False)
        config_hash = self.compose("config", "--hash", service, capture=True).stdout.split()[-1]
        up_to_date = [c for c in old if self.docker("inspect", "-f", '{{.Image}} {{index .Config.Labels "com.docker.compose.config-hash"}}', c) == f"{image_id} {config_hash}"]
        if old and len(up_to_date) == len(old) == replicas:
            log(f"{service} is up to date ({replicas} replicas)")
            return

        log(f"Starting {replicas} new {service} replicas next to the {len(old)} running")
        self.compose("up", "-d", "--no-deps", "--no-build", "--no-recreate", "--scale", f"{service}={len(old) + replicas}", service)
        new = [c for c in self.containers(service) if c not in old]
        if not self.wait_healthy(new):
            for c in new:
                print(self.docker("logs", "--tail", "80", c, check=False))
            log(f"New {service} replicas are not healthy, removing them. The previous version is still serving.")
            self.docker("rm", "-f", *new)
            die(f"{service} failed its healthcheck")

        if old:
            # A proxy started before deploy.py existed doesn't have /etc/nginx/upstreams/ yet
            self.reconfigure_proxy(services)
            self.set_upstream(services, new)  # new requests only go to the new replicas
            # nginx's reload is asynchronous: its old workers can still send requests they accepted to the old replicas
            time.sleep(DRAIN_SECONDS)
            log(f"Stopping the {len(old)} old {service} replicas (they finish in-flight requests)")
            self.docker("stop", "-t", "60", *old)
            self.docker("rm", *old)
        self.reconfigure_proxy(services)  # back to the "backend" DNS name, that now resolves to the new replicas

    def wait_healthy(self, containers: List[str], timeout: int = 300) -> bool:
        log(f"Waiting for {len(containers)} containers to be healthy (timeout {timeout}s)")
        start = time.time()
        while time.time() - start < timeout:
            states = [self.health(c) for c in containers]
            if all(s in ("running healthy", "running none") for s in states):
                log(f"Healthy after {time.time() - start:.0f}s")
                return True
            if any(not s.startswith("running") or s.endswith("unhealthy") for s in states):
                log(f"Unhealthy: {states}")
                return False
            time.sleep(2)
        log("Timeout")
        return False

    def cleanup_images(self, config: dict, ours: List[str]) -> None:
        """
        Every version has its own tags: remove the images of versions we deployed in the past,
        so we don't fill the disk. We keep the last few for fast rollbacks, and never touch versions we didn't deploy.
        """
        history = [h["version"] for h in self.state.get("history", []) if h.get("version")]
        keep = set(history[-KEEP_IMAGES:])
        old_versions = set(history) - keep
        if not self.version or not old_versions:
            return
        for name in ours:
            image = config["services"][name]["image"]  # repo:service-version
            repo, _, tag = image.rpartition(":")
            prefix = tag[: -len(self.version) - 1] if tag.endswith(f"-{self.version}") else None
            if not prefix:
                continue
            for line in self.docker("image", "ls", repo, "--format", "{{.Tag}}").splitlines():
                if line.startswith(f"{prefix}-") and line[len(prefix) + 1:] in old_versions:
                    # fails if a container still uses it, that's fine
                    self.docker("rmi", f"{repo}:{line}", check=False)

    # --- other commands ---
    def rollback(self, pull: bool = True) -> None:
        previous = self.state.get("previous")
        if not previous:
            die("No previous version recorded")
        log(f"Rolling back from {self.state.get('current')} to {previous}")
        self.version = previous
        self.env["QABOARD_VERSION"] = previous
        self.up(pull=pull)

    def status(self) -> None:
        print(f"Project:  {self.project}")
        print(f"Current:  {self.state.get('current')}")
        print(f"Previous: {self.state.get('previous')}")
        for h in self.state.get("history", [])[-5:]:
            print(f"  {h['date']}  {h['version']}  {h.get('by') or ''}  {h.get('pipeline') or ''}")
        self.compose("ps", "-a")

    def restore_db(self, dump: str) -> None:
        if dump == "latest":
            dump = self.compose("exec", "-T", "db", "sh", "-c", "ls -t /backups/*.dump | head -1", capture=True).stdout.strip()
            if not dump:
                die("No backups found in /backups")
        elif not dump.startswith("/"):
            dump = f"/backups/{dump}"
        log(f"Restoring {dump}: the backend is stopped meanwhile")
        users = [s for s in ("backend", "flower", "cron-backup-db") if s in self.config()["services"]]
        self.compose("stop", *users)
        try:
            self.compose("exec", "-T", "db", "/opt/restore", dump)
        finally:
            self.compose("up", "-d", "--no-deps", *users)
            self.reconfigure_proxy(list(self.config()["services"]))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("env_file", help="e.g. deployments/sirc/production.env")
    sub = parser.add_subparsers(dest="command", required=True)
    up = sub.add_parser("up", help="deploy a version")
    up.add_argument("--version", help="image version (default: $QABOARD_VERSION, else the deployed version)")
    up.add_argument("--build", action="store_true", help="build the images instead of pulling them")
    up.add_argument("--no-pull", action="store_true", help="use the local images")
    up.add_argument("--init", action="store_true", help="allow deploying a new environment (empty database)")
    rollback = sub.add_parser("rollback", help="redeploy the previous version")
    rollback.add_argument("--no-pull", action="store_true", help="use the local images")
    sub.add_parser("status", help="show the deployed version and containers")
    restore = sub.add_parser("restore-db", help="restore a database backup (from /backups in the db container)")
    restore.add_argument("dump", nargs="?", default="latest")
    compose = sub.add_parser("compose", help="run docker compose for this environment and version")
    compose.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    deployment = Deployment(args.env_file, version=getattr(args, "version", None))
    if args.command == "up":
        deployment.up(build=args.build, pull=not args.no_pull, init=args.init)
    elif args.command == "rollback":
        deployment.rollback(pull=not args.no_pull)
    elif args.command == "status":
        deployment.status()
    elif args.command == "restore-db":
        deployment.restore_db(args.dump)
    elif args.command == "compose":
        sys.exit(deployment.compose(*args.args, check=False).returncode)


if __name__ == "__main__":
    main()
