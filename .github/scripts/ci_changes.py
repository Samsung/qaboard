#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""
Which jobs of .github/workflows/ci.yaml a change needs: the one place that maps files to jobs (see docs/ci.md).
Usage:
  ci_changes.py                    what your branch (commits and uncommitted files) needs, compared with origin/master
  ci_changes.py --base REF --head REF [--labels run-e2e]
  ci_changes.py --files -          the file names on stdin
  ci_changes.py --github           in CI: decides from the event, writes the jobs' outputs and a summary

- pushes to master, releases and workflow_dispatch run every job (a push to master with only docs, as before: none)
- other branches and pull requests run the jobs whose inputs changed, compared with where they left master
- the end-to-end jobs (E2E) run on them only for changes to the systems they protect, or with the label run-e2e
When in doubt, a job runs: a file no rule mentions runs the Python tests, a change to CI itself runs everything.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from functools import lru_cache
from typing import Dict, Iterable, List, Optional, Tuple

LABEL = "run-e2e"
DEFAULT_BRANCH = "master"

# Patterns are GitHub's (*: in a folder, **: across folders); in each list, the last pattern a file matches decides,
# and one starting with ! excludes. Like ci.yaml's former `paths:`, docs alone run nothing.
IGNORED = ["docs/**", "drafts/**", "**.md", "!website/release-notes/**"]
# CI itself: everything runs, the end-to-end jobs too
EVERYTHING = [".github/workflows/ci.yaml", ".github/scripts/ci_changes.py"]

# Shared images' sources: the end-to-end jobs deploy them
DOCKERFILES = ["**/Dockerfile*", ".dockerignore", "docker-compose.yml"]
DEMO_DATA = [
  ".github/scripts/demo_data_*", "docs-media/demo-data/**", "docs-media/seed.py", "docs-media/snapshot.py",
  "docs-media/tests/fixture/**",
]

JOBS: Dict[str, List[str]] = {
  # The tests read the whole repository (the docs pages qa links to, the nginx config, the chart's values, the
  # examples' qaboard.yaml...): anything but what other jobs or workflows own
  "python": [
    "**",
    "!webapp/**",
    "!charts/**", "charts/qaboard/values.yaml", "charts/qaboard/files/**",
    "!website/**", "website/docs/**", "website/release-notes/**", "website/media.json",
    "!.github/**", ".github/scripts/check_migrations.py",
  ],
  # vite bundles the release notes and the schemas, the viewers' tests read the shared fixtures
  "webapp": ["webapp/**", "website/release-notes/**", "qaboard/schemas/**", "tests/fixtures/**"],
  # Builds every image (the backend's has qaboard/ and tests/, the frontend's the release notes), deploys them, tests
  # the backend, uploads end to end, a rolling deploy. The website's pages are built by website.yml.
  "docker": [
    "backend/**", "qaboard/**", "tests/**", "pyproject.toml", "uv.lock",
    "webapp/**", "website/release-notes/**", "website/package.json", "website/yarn.lock",
    "services/**", "deployments/*", *DOCKERFILES,
    ".github/scripts/uploads_e2e.py", ".github/scripts/load.py",
  ],
  "helm": ["charts/**"],
  # E2E: the Docker Compose quickstart, with its demo data
  "quickstart": ["deployments/quickstart/**", *DEMO_DATA, *DOCKERFILES],
  # E2E: the chart on kind, demo data, `qa batch` in the cluster, batches the server starts on Kubernetes
  "helm-e2e": [
    "charts/**", ".github/scripts/helm_e2e.py", *DEMO_DATA, *DOCKERFILES,
    "qaboard/runners/kubernetes.py", "qaboard/runners/registry.py", "qaboard/on_server.py", "qaboard/commit_artifacts.py",
    "backend/backend/server_runner.py", "backend/backend/runner_jobs.py", "backend/backend/local_jobs.py",
    "backend/backend/tokens.py", "backend/backend/api/tuning.py", "backend/backend/api/commit_artifacts.py",
  ],
  # E2E: `qa batch --runner kubernetes` on kind
  "kubernetes-runner-e2e": ["qaboard/runners/**", ".github/scripts/kubernetes_runner_e2e.py"],
}
E2E = {"quickstart", "helm-e2e", "kubernetes-runner-e2e"}


@lru_cache(maxsize=None)
def _regex(pattern: str) -> "re.Pattern[str]":
  out, i = [], 0
  while i < len(pattern):
    if pattern.startswith("**/", i):
      out.append("(?:.*/)?")
      i += 3
    elif pattern.startswith("**", i):
      out.append(".*")
      i += 2
    elif pattern[i] == "*":
      out.append("[^/]*")
      i += 1
    elif pattern[i] == "?":
      out.append("[^/]")
      i += 1
    else:
      out.append(re.escape(pattern[i]))
      i += 1
  return re.compile("".join(out))


def matches(path: str, patterns: Iterable[str]) -> bool:
  matched = False
  for pattern in patterns:
    negated = pattern.startswith("!")
    if _regex(pattern.lstrip("!")).fullmatch(path):
      matched = not negated
  return matched


def decide(files: Optional[Iterable[str]], labels: Iterable[str] = (), full: str = "") -> Tuple[str, Dict[str, str]]:
  """The mode (full, diff, docs-only) and, for each job, why it runs ("" when it doesn't).
  files=None: the change is unknown, everything runs. full: why everything runs (an event), if it does."""
  if files is None:
    return "full", {job: full or "the changed files are unknown" for job in JOBS}
  files = [f for f in files if not matches(f, IGNORED)]
  if not files:
    return "docs-only", {job: "" for job in JOBS}
  everything = full or next((f"{f} changed" for f in files if matches(f, EVERYTHING)), "")
  if everything:
    return "full", {job: everything for job in JOBS}
  labeled = LABEL in labels
  why = {}
  for job, patterns in JOBS.items():
    changed = next((f for f in files if matches(f, patterns)), None)
    why[job] = f"{changed} changed" if changed else ""
    if job in E2E and labeled:
      why[job] = f"the {LABEL} label"
  return "diff", why


def git(*args: str) -> str:
  return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def changed_files(base: str, head: Optional[str]) -> Optional[List[str]]:
  """The files changed since head (or the working tree, with untracked files) left base. None if git can't tell."""
  try:
    merge_base = git("merge-base", base, head or "HEAD").strip()
    # --no-renames: a renamed file counts at both paths (and git needs no file contents for it, see blob:none)
    files = git("diff", "--name-only", "--no-renames", merge_base, *([head] if head else []), "--").splitlines()
    if not head:
      files += git("ls-files", "--others", "--exclude-standard").splitlines()
    return sorted(set(files))
  except subprocess.CalledProcessError as e:
    print(f"::warning::Can't compare with {base}, every job runs: {e.stderr.strip()}", file=sys.stderr)
    return None


def pull_request_labels(repository: str, sha: str) -> List[str]:
  """The labels of the open pull requests of a commit (a push to a branch doesn't say them)"""
  request = urllib.request.Request(
    f"{os.environ.get('GITHUB_API_URL', 'https://api.github.com')}/repos/{repository}/commits/{sha}/pulls",
    headers={"Authorization": f"Bearer {os.environ['GH_TOKEN']}", "Accept": "application/vnd.github+json"},
  )
  try:
    with urllib.request.urlopen(request, timeout=30) as response:
      pulls = json.load(response)
  except Exception as e:  # the label is an opt-in: without it, the end-to-end jobs follow the files
    print(f"::warning::Can't read the pull request's labels ({e}): add {LABEL} again, or run the workflow by hand")
    return []
  return [label["name"] for pull in pulls if pull.get("state") == "open" for label in pull.get("labels", [])]


def from_github() -> Tuple[str, Dict[str, str]]:
  event_name = os.environ["GITHUB_EVENT_NAME"]
  with open(os.environ["GITHUB_EVENT_PATH"]) as f:
    event = json.load(f)
  default = event.get("repository", {}).get("default_branch") or DEFAULT_BRANCH
  if event_name in ("release", "workflow_dispatch"):
    return decide(None, full=f"a {event_name} runs every job")
  if event_name == "push" and os.environ["GITHUB_REF"] == f"refs/heads/{default}":
    before = event.get("before") or ""
    files = None if set(before) <= {"0"} else changed_files(before, os.environ["GITHUB_SHA"])
    return decide(files, full=f"a push to {default} runs every job")
  if event_name == "pull_request":
    labels = [label["name"] for label in event["pull_request"].get("labels", [])]
    return decide(changed_files(f"origin/{event['pull_request']['base']['ref']}", "HEAD"), labels)
  if event_name == "push":
    labels = pull_request_labels(os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_SHA"])
    return decide(changed_files(f"origin/{default}", os.environ["GITHUB_SHA"]), labels)
  return decide(None, full=f"a {event_name} runs every job")


def main() -> int:
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument("--github", action="store_true", help="in GitHub Actions: from the event, to $GITHUB_OUTPUT")
  parser.add_argument("--base", default=f"origin/{DEFAULT_BRANCH}")
  parser.add_argument("--head", help="a commit (default: the working tree)")
  parser.add_argument("--files", help="a file with the changed files' names, one per line (-: stdin)")
  parser.add_argument("--labels", default="", help="the pull request's labels, comma-separated")
  args = parser.parse_args()

  if args.github:
    mode, why = from_github()
  else:
    if args.files:
      with (open(0) if args.files == "-" else open(args.files)) as f:
        files: Optional[List[str]] = f.read().split()
    else:
      files = changed_files(args.base, args.head)
    mode, why = decide(files, [label for label in args.labels.split(",") if label])

  rows = [f"| {job}{' (e2e)' if job in E2E else ''} | {'yes' if reason else 'no'} | {reason} |" for job, reason in why.items()]
  summary = "\n".join([f"Mode: **{mode}**", "", "| Job | Runs | Why |", "|---|---|---|", *rows])
  print(summary)
  skipped = [job for job in E2E if not why[job]]
  if skipped and mode == "diff":
    print(f"\nNot run: {', '.join(sorted(skipped))}. If your change can break them, run them locally (docs/ci.md) or add the {LABEL} label.")
  if args.github:
    with open(os.environ["GITHUB_OUTPUT"], "a") as f:
      f.write(f"mode={mode}\n")
      for job, reason in why.items():
        f.write(f"{job}={'true' if reason else 'false'}\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
      f.write(f"### Jobs this change needs\n\n{summary}\n\nThe mapping: .github/scripts/ci_changes.py\n")
  return 0


if __name__ == "__main__":
  sys.exit(main())
