#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Records the terminal tapes (docs-media/README.md#terminal-tapes) with the pinned VHS:
docs-media/tapes/<area>-<subject>.tape makes out/<area>/<subject>/tape.mp4, tape.webm and meta.json.

  uv run docs-media/tapes/record.py [--only GLOB]

A tape starts with `# key: value` lines, then `Source "tapes/_settings.tape"`:
  project   the demo project (examples/<project>), or none
  user      the persona running the commands (examples/README.md#people): QA_USER and git identity
  env       extra environment, KEY=VALUE separated by spaces (CI variables for CI tapes)
  alt       required alt text (website/STYLE.md); caption: the default caption; poster: first, last or ms
Commands run for real, against the restored demo stack (QABOARD_URL, from the demo facts), from ~/kitefin/<repo>:
HOME is /home/<user> (TAPES_HOME), where ~/kitefin/<repo> is the seeder's workspace ($DEMO_WORKSPACES/<repo>, default
/tmp/kitefin/<repo>, whose .venv has `qa` and the example's dependencies), or else a git copy of examples/<project>.
Tools: VHS, ttyd and ffmpeg from docs-media/install-tools.sh or PATH, a Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE,
Playwright's, or `chromium` in PATH), and `qa` in PATH.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import glob
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


def workspace(project: str, home: Path, user: str) -> Path:
    """~/kitefin/<repo>: the seeder's workspace for the project ($DEMO_WORKSPACES/<repo>, default /tmp/kitefin/<repo>,
    with the venv where `qa` and the example's dependencies are), else a git copy of the example"""
    project_id = PROJECT_IDS[project]
    target = home / project_id
    seeded = Path(os.environ.get("DEMO_WORKSPACES") or "/tmp/kitefin") / project_id.split("/")[-1]
    if target.is_symlink() and not target.exists():
        target.unlink()
    if target.exists() or target.is_symlink():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    if seeded.exists():
        target.symlink_to(seeded)
        return target
    shutil.copytree(REPO / "examples" / project, target, ignore=shutil.ignore_patterns("build", "output", "__pycache__"))
    name = PEOPLE.get(user, user)
    env = {**os.environ, "GIT_AUTHOR_NAME": name, "GIT_COMMITTER_NAME": name, "GIT_AUTHOR_EMAIL": f"{user}@kitefin.example",
           "GIT_COMMITTER_EMAIL": f"{user}@kitefin.example", "GIT_AUTHOR_DATE": "2026-01-01T12:00:00Z",
           "GIT_COMMITTER_DATE": "2026-01-01T12:00:00Z"}
    for cmd in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "Initial commit"]):
        subprocess.run(["git", *cmd], cwd=target, env=env, check=True)
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
    path = [str(shim), str(TOOLS_BIN), os.environ.get("PATH", "")]
    if project in PROJECT_IDS:
        venv = workspace(project, home, user) / ".venv"
        if (venv / "bin" / "qa").exists():
            path.insert(1, str(venv / "bin"))
    name = PEOPLE.get(user, user)
    env = {
        **os.environ,
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
    for pair in meta.get("env", "").split():
        key, _, value = pair.partition("=")
        env[key] = value
    if os.geteuid() == 0:
        env["VHS_NO_SANDBOX"] = "true"   # Chromium refuses to run as root with its sandbox
    if not shutil.which("qa", path=env["PATH"]):
        log("  warning: `qa` isn't in PATH: the tape's commands will fail")

    vhs = shutil.which("vhs", path=env["PATH"])
    if not vhs:
        raise SystemExit("vhs is missing: run docs-media/install-tools.sh")
    log(f"{id_}: recording {tape.relative_to(DOCS_MEDIA)}")
    result = subprocess.run([vhs, str(tape.relative_to(DOCS_MEDIA))], cwd=DOCS_MEDIA, env=env, capture_output=True, text=True,
                            timeout=600)
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
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "scale": 1,
        "duration": round(duration, 3),
        "poster": poster if poster in ("first", "last") else int(poster),
        "files": {"mp4": "tape.mp4", "webm": "tape.webm"},
    }
    (out / "meta.json").write_text(json.dumps(data, indent=2) + "\n")
    log(f"  {duration:.1f} s, {stream['width']}x{stream['height']}: {out.relative_to(DOCS_MEDIA)}")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="comma-separated globs over shot ids, e.g. 'cli/*'")
    parser.add_argument("tapes", nargs="*", type=Path, help="tape files (default: every tapes/<area>-<subject>.tape)")
    args = parser.parse_args()
    tapes = [t.resolve() for t in args.tapes] or sorted(t for t in TAPES.glob("*.tape") if not t.name.startswith("_"))
    globs = [g.strip() for g in (args.only or "").split(",") if g.strip() and g.strip() != "*"]
    tapes = [t for t in tapes if not globs or any(fnmatch.fnmatchcase(tape_id(t), g) for g in globs)]
    if not tapes:
        log("No tape matches")
        return 0
    facts = demo_facts()
    for tape in tapes:
        record(tape, facts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
