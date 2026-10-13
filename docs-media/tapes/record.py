#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Records the terminal tapes (docs-media/README.md#terminal-tapes) with the pinned VHS:
docs-media/tapes/<area>-<subject>.tape makes out/<area>/<subject>/tape.mp4, tape.webm and meta.json.

  uv run docs-media/tapes/record.py [--only GLOB] [--skip GLOB]

A tape starts with `# key: value` lines, then `Source "tapes/_settings.tape"`:
  project   the demo project (examples/<project>), or none
  user      the persona running the commands (examples/README.md#people): QA_USER and git identity
  env       extra environment, KEY=VALUE separated by spaces (CI variables for CI tapes)
  passenv   variables kept from the environment when they're set, names separated by spaces (e.g. QABOARD_IMAGE for the
            quickstarts, which run this checkout's images)
  alt       required alt text (website/STYLE.md); caption: the default caption; poster: first, last or ms
  revision  bump it to publish a recording the dedupe would keep as unchanged
  dedupe_tolerance, dedupe_mask   how publish.py compares a new recording with the published one (README.md#determinism)
  timeout   seconds VHS may take, hidden waits included (default 600)
Commands run for real, against the restored demo stack (QABOARD_URL, from the demo facts), from ~/kitefin/<repo>:
HOME is /home/<user> (TAPES_HOME), where ~/kitefin/<repo> is a workspace like the seeder's, built by workspace(): a .venv
with `qa` and the example's dependencies, the inputs, and a git repository whose HEAD is on a story commit.
CI and QA-Board variables of the environment are dropped, unless the tape's `env` sets them or `passenv` names them.
Tools: VHS, ttyd and ffmpeg from docs-media/install-tools.sh or PATH, a Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE,
Playwright's, or `chromium` in PATH), and `qa` in PATH.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

DOCS_MEDIA = Path(__file__).resolve().parent.parent
REPO = DOCS_MEDIA.parent
TAPES = DOCS_MEDIA / "tapes"
OUT = DOCS_MEDIA / "out"
TOOLS_BIN = Path(os.environ.get("DOCS_MEDIA_BIN", Path.home() / ".cache" / "qaboard-docs-media" / "bin"))
AREAS = ["quickstart", "cli", "ci", "projects", "commits", "integrations", "commit", "logs", "history", "tuning", "files",
         "whats-new", "auth", "landing"]
PROJECT_IDS = {
    "image-quality": "kitefin/camera-isp",
    "serving-latency": "kitefin/inference-gateway",
    "detection-eval": "kitefin/detector",
    "robotics-3d": "kitefin/slam",
    "agent-evals": "kitefin/fleet-assistant",
}
PEOPLE = {
    "ines": "Ines Marchetti", "tobias": "Tobias Wendt", "arjun": "Arjun Sethuraman", "mira": "Mira Kowalczyk",
    "adaeze": "Adaeze Nwankwo", "kaito": "Kaito Nishimaki", "agent": "Kitefin Agent", "ci": "ci",
}
MAX_SECONDS = 45


def log(*args) -> None:
    print(*args, file=sys.stderr, flush=True)


def tape_id(path: Path) -> str:
    """cli-first-run.tape -> cli/first-run; whats-new-dialog.tape -> whats-new/dialog"""
    name = path.stem
    for area in sorted(AREAS, key=len, reverse=True):
        if name.startswith(area + "-"):
            return f"{area}/{name[len(area) + 1:]}"
    raise SystemExit(f"{path.name}: the file name must be <area>-<subject>.tape, with an area of the README")


def header(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text().splitlines():
        if not line.startswith("#"):
            break
        match = re.match(r"#\s*([a-z_]+):\s*(.*\S)\s*$", line)
        if match:
            values[match.group(1)] = match.group(2)
    return values


def dedupe_mask(tape: Path, value: str) -> list[list[int]]:
    """`x,y,w,h x,y,w,h`: rectangles of the video (pixels) that publish.py's dedupe ignores"""
    rects = []
    for rect in value.split():
        if not re.fullmatch(r"\d+,\d+,\d+,\d+", rect):
            raise SystemExit(f"{tape.name}: dedupe_mask is `x,y,w,h` rectangles in pixels, separated by spaces, not {rect!r}")
        rects.append([int(v) for v in rect.split(",")])
    return rects


def demo_facts() -> dict:
    """Like shots/lib/demo.ts: <results>/.qaboard-demo/demo.json (written by seed.py), completed by the environment"""
    results = os.environ.get("QABOARD_DEMO_RESULTS") or "/mnt/qaboard"
    path = Path(os.environ.get("DEMO_META") or Path(results) / ".qaboard-demo" / "demo.json")
    facts = json.loads(path.read_text()) if path.exists() else {}
    for key, env in [("t0", "DEMO_T0"), ("base_url", "DEMO_BASE_URL"), ("app_version", "DEMO_APP_VERSION")]:
        if os.environ.get(env):
            facts[key] = os.environ[env]
    facts.setdefault("base_url", f"http://localhost:{os.environ.get('QABOARD_DEMO_PORT') or 5151}")
    if not facts.get("app_version"):
        version = re.search(r'^version\s*=\s*"([^"]+)"', (REPO / "pyproject.toml").read_text(), re.M).group(1)
        sha = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short=7", "HEAD"], capture_output=True, text=True).stdout.strip()
        facts["app_version"] = f"{version}+{sha}" if sha else version
    return facts


def chromium() -> str:
    candidates = [os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE", ""), shutil.which("chromium") or "", shutil.which("chromium-browser") or ""]
    for root in [os.environ.get("PLAYWRIGHT_BROWSERS_PATH", ""), str(Path.home() / ".cache" / "ms-playwright")]:
        if root:
            candidates += sorted(glob.glob(f"{root}/chromium-*/chrome-linux*/chrome"), reverse=True)
    for candidate in candidates:
        if candidate and os.access(candidate, os.X_OK):
            return candidate
    raise SystemExit("No Chromium for VHS: set PLAYWRIGHT_CHROMIUM_EXECUTABLE, or run `npx playwright install chromium` in docs-media/shots")


# Variables that tell `qa` it runs in a CI, or about a commit: never inherited (a tape's `env` can set them)
SCRUBBED_ENV = re.compile(r"^(CI|CI_.*|GITHUB_.*|GITLAB_.*|GIT_.*|gitlab.*|CIRCLE.*|TRAVIS.*|BUILD_URL|JENKINS_.*|QA_.*|QABOARD_.*|RUNNER_.*|VIRTUAL_ENV)$")


def main_head(facts: dict, project: str) -> str | None:
    """The sha of the reference branch's last commit at T0, from the demo facts"""
    commits = facts.get("projects", {}).get(project, {}).get("commits", {})
    on_main = [c for c in commits.values() if c.get("branch") == "main"]
    return max(on_main, key=lambda c: c["at"])["sha"] if on_main else None


def head_commit(facts: dict, project: str, env: dict[str, str]) -> tuple[str, str] | None:
    """The (branch, sha) the workspace's git HEAD is on: the commit the tape's CI variables name, else the reference
    branch's last commit at T0"""
    sha = env.get("GITHUB_SHA") or env.get("CI_COMMIT_SHA") or env.get("GIT_COMMIT")
    if sha:
        branch = env.get("GITHUB_REF") or env.get("CI_COMMIT_REF_NAME") or env.get("GIT_BRANCH") or "main"
        return re.sub(r"^(refs/heads/|origin/)", "", branch), sha
    sha = main_head(facts, project)
    return ("main", sha) if sha else None


def runs_qa(venv: Path) -> bool:
    """The venv's `qa` starts: its qaboard is an editable install, broken once the checkout it points to is gone"""
    python = venv / "bin" / "python"
    return (venv / "bin" / "qa").exists() and python.exists() \
        and subprocess.run([str(python), "-I", "-c", "import qaboard.qa"], capture_output=True).returncode == 0  # -I: not from the cwd


def workspace(project: str, home: Path, facts: dict, head: tuple[str, str] | None) -> Path:
    """~/kitefin/<repo>, where the tape's commands run, built like the seeder's workspace: a copy of the example, a git
    repository (`git init`, so that git commands like `qa check-bit-accuracy`'s work) whose HEAD is on `head`, the
    story commit (like the seeder, a ref to a sha the repository doesn't have: the story's shas aren't real commits), a
    venv with this checkout's qaboard and the example's requirements.txt, and the inputs generated (the first import of
    qa/main.py does it). Always a real directory, never a link to the seeder's workspace: `qa` prints paths from
    os.getcwd(), which resolves links, so the tape would show /tmp/kitefin/<repo>.
    """
    project_id = PROJECT_IDS[project]
    repo = project_id.split("/")[-1]
    target = home / "kitefin" / repo
    if target.is_symlink():
        target.unlink()
    target.parent.mkdir(parents=True, exist_ok=True)
    example = REPO / "examples" / project
    log(f"  building the workspace {target} from {example.relative_to(REPO)}")
    shutil.copytree(example, target, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(".venv", "build", "target", "output", "__pycache__", "*.pyc", ".git"))
    # a repository without commits or remotes: re-initializing one keeps its HEAD and refs
    subprocess.run(["git", "-c", "init.defaultBranch=main", "init", "-q", str(target)], check=True)
    if head:
        branch, sha = head
        git = target / ".git"
        (git / "HEAD").write_text(f"ref: refs/heads/{branch}\n")
        ref = git / "refs" / "heads" / branch
        ref.parent.mkdir(parents=True, exist_ok=True)
        ref.write_text(sha + "\n")
    venv = target / ".venv"
    requirements = example / "requirements.txt"
    stamp = venv / ".record-stamp"
    wanted = hashlib.sha256(((requirements.read_text() if requirements.exists() else "")
                             + (REPO / "pyproject.toml").read_text()).encode()).hexdigest()
    if not stamp.exists() or stamp.read_text() != wanted or not runs_qa(venv):
        log(f"  installing qaboard and the example's requirements in {venv}")
        subprocess.run(["uv", "venv", "-q", "--allow-existing", "--python", "3.12", str(venv)], check=True)
        deps = ["-r", str(requirements)] if requirements.exists() else []
        subprocess.run(["uv", "pip", "install", "-q", "--python", str(venv / "bin" / "python"), "-e", str(REPO), *deps], check=True)
        stamp.write_text(wanted)
    # the inputs (photos, charts) are fetched and generated the first time qa/main.py is imported
    env = {k: v for k, v in os.environ.items() if not SCRUBBED_ENV.match(k)}
    subprocess.run([str(venv / "bin" / "python"), "-c", "import sys; sys.path.insert(0, 'qa'); import main"],
                   cwd=target, env=env, check=True)
    return target


def home_dir(user: str, sandbox: Path) -> Path:
    """/home/<user>, so that paths look like the persona's (TAPES_HOME overrides it). Created with sudo if needed."""
    home = Path(os.environ.get("TAPES_HOME", f"/home/{user}"))
    if not home.exists():
        try:
            home.mkdir(parents=True)
        except PermissionError:
            subprocess.run(["sudo", "-n", "install", "-d", "-o", str(os.getuid()), str(home)], capture_output=True)
    if home.exists() and os.access(home, os.W_OK):
        return home
    log(f"  warning: can't write {home}, the tape's paths will show {sandbox / 'home'}")
    return sandbox / "home"


def record(tape: Path, facts: dict) -> Path:
    id_ = tape_id(tape)
    meta = header(tape)
    if not meta.get("alt"):
        raise SystemExit(f"{tape.name}: add a `# alt: ...` line (website/STYLE.md)")
    if len(meta["alt"]) > 300:
        raise SystemExit(f"{tape.name}: the alt text has {len(meta['alt'])} characters, at most 300 (website/media.schema.json)")
    out = OUT / id_
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    expected = f"Output out/{id_}/tape.mp4"
    if expected not in tape.read_text():
        raise SystemExit(f"{tape.name}: it must write `{expected}` and tape.webm")

    sandbox = OUT / ".tapes"
    user = meta.get("user", "ines")
    home = home_dir(user, sandbox)
    shim = sandbox / "bin"
    shim.mkdir(parents=True, exist_ok=True)
    (shim / "chromium").unlink(missing_ok=True)
    (shim / "chromium").symlink_to(chromium())
    project = meta.get("project", "none")
    tape_env = dict(pair.partition("=")[::2] for pair in meta.get("env", "").split())
    path = [str(shim), str(TOOLS_BIN), os.environ.get("PATH", "")]
    if project in PROJECT_IDS:
        venv = workspace(project, home, facts, head_commit(facts, project, tape_env)) / ".venv"
        path.insert(1, str(venv / "bin"))
    name = PEOPLE.get(user, user)
    env = {
        **{k: v for k, v in os.environ.items() if not SCRUBBED_ENV.match(k)},
        "HOME": str(home),
        "PATH": os.pathsep.join(path),
        "PS1": "$ ",
        "TERM": "xterm-256color",
        "LANG": "C.UTF-8",
        "TZ": "UTC",
        "FONTCONFIG_FILE": str(DOCS_MEDIA / "fonts.conf"),
        "QABOARD_URL": facts["base_url"],
        "QA_USER": user,
        "GIT_AUTHOR_NAME": name, "GIT_COMMITTER_NAME": name,
        "GIT_AUTHOR_EMAIL": f"{user}@kitefin.example", "GIT_COMMITTER_EMAIL": f"{user}@kitefin.example",
    }
    env.update({name: os.environ[name] for name in meta.get("passenv", "").split() if name in os.environ})
    env.update(tape_env)
    if os.geteuid() == 0:
        env["VHS_NO_SANDBOX"] = "true"   # Chromium refuses to run as root with its sandbox
    if project in PROJECT_IDS and not shutil.which("qa", path=env["PATH"]):
        log("  warning: `qa` isn't in PATH: the tape's commands will fail")

    vhs = shutil.which("vhs", path=env["PATH"])
    if not vhs:
        raise SystemExit("vhs is missing: run docs-media/install-tools.sh")
    log(f"{id_}: recording {tape.relative_to(DOCS_MEDIA)}")
    result = subprocess.run([vhs, str(tape.relative_to(DOCS_MEDIA))], cwd=DOCS_MEDIA, env=env, capture_output=True, text=True,
                            timeout=int(meta.get("timeout", 600)))
    if result.returncode != 0 or not (out / "tape.mp4").exists() or not (out / "tape.webm").exists():
        raise SystemExit(f"{id_}: VHS failed ({result.returncode}):\n{result.stdout[-3000:]}\n{result.stderr[-3000:]}")

    probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json",
                                       str(out / "tape.mp4")], capture_output=True, text=True, check=True).stdout)
    duration = float(probe["format"]["duration"])
    stream = probe["streams"][0]
    if duration > MAX_SECONDS:
        log(f"  warning: the tape lasts {duration:.1f} s, at most {MAX_SECONDS} s: cut long waits with Hide/Show")
    poster = meta.get("poster", "last")
    data = {
        "id": id_,
        "kind": "tape",
        "alt": meta["alt"],
        "caption": meta.get("caption"),
        "project": project if project in PROJECT_IDS else None,
        "app_version": facts["app_version"],
        "source_spec": f"docs-media/tapes/{tape.name}",
        "captured": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "t0": facts.get("t0"),
        "dedupe_tolerance": float(meta.get("dedupe_tolerance", 0.0005)),
        "dedupe_mask": dedupe_mask(tape, meta.get("dedupe_mask", "")),
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "scale": 1,
        "duration": round(duration, 3),
        "poster": poster if poster in ("first", "last") else int(poster),
        "files": {"mp4": "tape.mp4", "webm": "tape.webm"},
    }
    if meta.get("revision"):
        data["revision"] = int(meta["revision"])
    (out / "meta.json").write_text(json.dumps(data, indent=2) + "\n")
    log(f"  {duration:.1f} s, {stream['width']}x{stream['height']}: {out.relative_to(DOCS_MEDIA)}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="comma-separated globs over shot ids, e.g. 'cli/*'")
    parser.add_argument("--skip", help="comma-separated globs over shot ids not to record, e.g. 'quickstart/*'")
    parser.add_argument("tapes", nargs="*", type=Path, help="tape files (default: every tapes/<area>-<subject>.tape)")
    args = parser.parse_args()
    tapes = [t.resolve() for t in args.tapes] or sorted(t for t in TAPES.glob("*.tape") if not t.name.startswith("_"))
    globs = [g.strip() for g in (args.only or "").split(",") if g.strip() and g.strip() != "*"]
    tapes = [t for t in tapes if not globs or any(fnmatch.fnmatchcase(tape_id(t), g) for g in globs)]
    skip = [g.strip() for g in (args.skip or "").split(",") if g.strip()]
    tapes = [t for t in tapes if not any(fnmatch.fnmatchcase(tape_id(t), g) for g in skip)]
    if not tapes:
        log("No tape matches")
        return 0
    facts = demo_facts()
    for tape in tapes:
        record(tape, facts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
