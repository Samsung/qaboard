#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml==6.0.3"]
# ///
"""
The shots a change affects (docs-media/README.md#when-it-runs-githubworkflowsdocs-mediayml), as comma-separated globs
for SHOTS_ONLY, tapes/record.py --only and publish.py --only. Prints nothing when no shot is affected.

  uv run docs-media/affected.py origin/master          # files changed since the merge base with origin/master
  uv run docs-media/affected.py --files webapp/src/App.jsx examples/image-quality/qa/main.py

- webapp/**, docs-media/shots/lib/**, the shots' config and packages: every still and clip (the areas of the specs);
  the tapes record terminals, not the web app. docs-media/fonts.conf: every shot (*)
- docs-media/shots/<area>.spec.ts: <area>/*; docs-media/shots/templates/<subject>.html: */<subject>
- examples/<project>/**: the project's shots (shots.yaml), which need a reseed
- docs-media/tapes/<area>-<subject>.tape: <area>/<subject>; tapes/_settings.tape or tapes/record.py: every tape
- what the quickstarts' tapes start: deployments/quickstart/** (quickstart/compose), charts/qaboard/** (quickstart/kind),
  docs-media/demo-data/** (both)
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

import yaml

DOCS_MEDIA = Path(__file__).resolve().parent
REPO = DOCS_MEDIA.parent
AREAS = ["quickstart", "cli", "ci", "projects", "commits", "integrations", "commit", "logs", "history", "tuning", "files",
         "whats-new", "auth", "landing"]
# What the quickstarts' tapes start
QUICKSTARTS = {r"^deployments/quickstart/": "quickstart/compose", r"^charts/qaboard/": "quickstart/kind",
               r"^docs-media/demo-data/": "quickstart/*"}
EVERYTHING = [r"^docs-media/fonts\.conf$"]
# What every still and clip shows, or how they're captured
WEB = [r"^webapp/", r"^docs-media/shots/lib/", r"^docs-media/shots/(playwright\.config\.ts|package(-lock)?\.json)$"]


def tape_id(name: str) -> str | None:
    for area in sorted(AREAS, key=len, reverse=True):
        if name.startswith(area + "-"):
            return f"{area}/{name[len(area) + 1:]}"
    return None


def affected(files: list[str]) -> list[str]:
    shots = yaml.safe_load((DOCS_MEDIA / "shots.yaml").read_text()).get("shots", [])
    tapes = [tape_id(p.stem) for p in (DOCS_MEDIA / "tapes").glob("*.tape") if not p.name.startswith("_")]
    globs: set[str] = set()
    specs = sorted(f"{p.name.removesuffix('.spec.ts')}/*" for p in (DOCS_MEDIA / "shots").glob("*.spec.ts"))
    for f in files:
        if any(re.search(pattern, f) for pattern in EVERYTHING):
            return ["*"]
        if any(re.search(pattern, f) for pattern in WEB):
            globs.update(specs)
        if m := re.match(r"^docs-media/shots/([a-z0-9-]+)\.spec\.ts$", f):
            globs.add(f"{m.group(1)}/*")
        elif m := re.match(r"^docs-media/shots/templates/([a-z0-9-]+)\.html$", f):
            globs.update(s["id"] for s in shots if s["id"].split("/")[1] == m.group(1))
        elif m := re.match(r"^examples/([a-z0-9-]+)/", f):
            globs.update(s["id"] for s in shots if s.get("project") == m.group(1) and s.get("status") != "retired")
        elif m := re.match(r"^docs-media/tapes/([a-z0-9-]+)\.tape$", f):
            if tid := tape_id(m.group(1)):
                globs.add(tid)
        elif f in ("docs-media/tapes/_settings.tape", "docs-media/tapes/record.py"):
            globs.update(t for t in tapes if t)
        globs.update(shot for pattern, shot in QUICKSTARTS.items() if re.search(pattern, f))
    return sorted(globs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("base", nargs="?", help="git ref to compare with (merge base)")
    parser.add_argument("--files", nargs="*", help="the changed files, instead of a git diff")
    args = parser.parse_args()
    if args.files is not None:
        files = args.files
    elif args.base:
        files = subprocess.run(["git", "-C", str(REPO), "diff", "--name-only", f"{args.base}...HEAD"],
                               capture_output=True, text=True, check=True).stdout.split()
    else:
        parser.error("give a base ref or --files")
    print(",".join(affected(files)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
