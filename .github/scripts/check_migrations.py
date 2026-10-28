#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = []
# ///
"""
Fails if migrations that were already on BASE were changed, renamed or deleted.
Usage: check_migrations.py BASE   (compared from the merge base of BASE and HEAD)

Databases record the migrations they ran by their revision id: a migration changed after it ran somewhere never runs
again there, its database silently differs from the others. Write a new migration instead.
For the rare edits that are safe (a comment, a migration that failed everywhere), say why in one of the commits,
with a line "Migration-Edit: <why>".
"""
import subprocess
import sys

MIGRATIONS = "backend/backend/alembic/versions/"


def git(*args: str) -> str:
  return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def main(base: str) -> int:
  merge_base = git("merge-base", base, "HEAD").strip()
  changed = git("diff", "--name-status", "--diff-filter=MDR", merge_base, "HEAD", "--", MIGRATIONS).splitlines()
  if not changed:
    print(f"OK: no migration from {merge_base[:8]} was changed")
    return 0
  reasons = [line for line in git("log", "--format=%B", f"{merge_base}..HEAD").splitlines() if line.startswith("Migration-Edit:")]
  print("These migrations were already merged, and were changed:")
  for line in changed:
    print(f"  {line}")
  if reasons:
    print("Allowed by:", *reasons, sep="\n  ")
    return 0
  print("Databases that ran them won't run them again: write a new migration instead.")
  print('If the edit is safe (a comment, a migration that failed everywhere), add "Migration-Edit: <why>" to a commit message.')
  return 1


if __name__ == "__main__":
  if len(sys.argv) != 2:
    sys.exit(__doc__)
  sys.exit(main(sys.argv[1]))
