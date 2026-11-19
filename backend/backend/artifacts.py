"""
A commit's artifacts are the files `qa save-artifacts` copies to the storage: qaboard.yaml, the code
and binaries runs need. QA-Board runs redos and tuning from that folder.

This module answers two questions:
- Can we still run from a commit's artifacts? Folders are also deleted outside of QA-Board (scripts,
  quota cleanups, users...), so we check the files instead of trusting `CiCommit.deleted`.
- What may we delete? Subprojects of a repository share the commit's artifacts folder. Their manifests list
  files at the repository root (e.g. the root qaboard.yaml, binaries), so deleting a subproject's artifacts
  must keep the files that other subprojects still use.
"""
import os
import json
import fnmatch
from pathlib import Path
from shlex import quote
from typing import Callable, Dict, Iterable, List, Optional, Set, Tuple


CONFIG_NAMES = ('qaboard.yaml', 'qatools.yaml')
# In CiCommit.data: the location of the artifacts `qa save-artifacts` sent over HTTP (api/commit_artifacts.py)
UPLOADED_ARTIFACTS = 'uploaded_artifacts'

# Checking that every file in the manifests exists is slow on network filesystems, we sample at most
MAX_CHECKED_FILES = 500


def config_file(directory: Path) -> Optional[Path]:
  """The qaboard.yaml (or legacy qatools.yaml) in a folder, if any."""
  for name in CONFIG_NAMES:
    if (directory / name).is_file():
      return directory / name
  return None


def read_manifest(manifest: Path) -> Dict:
  with manifest.open() as f:
    files = json.load(f)
  if not isinstance(files, dict):
    raise ValueError(f"{manifest} is not a JSON object")
  return files


def manifests(artifacts_dir: Path) -> List[Path]:
  manifests_dir = artifacts_dir / 'manifests'
  if not manifests_dir.is_dir():
    return []
  return sorted(p for p in manifests_dir.iterdir() if p.suffix == '.json')


def artifacts_status(artifacts_dir: Path, repo_artifacts_dir: Path, is_subproject: bool, max_checked_files=MAX_CHECKED_FILES) -> Dict:
  """
  Checks that we can run from a commit's artifacts. Returns
    ok: False if runs started from there would fail or use the wrong configuration
    problems: what makes runs fail or go to the wrong project: we don't run then
    warnings: what may be fine, e.g. some files listed in the manifests are missing
    missing_files: some files listed in the manifests that don't exist anymore
  """
  artifacts_dir, repo_artifacts_dir = Path(artifacts_dir), Path(repo_artifacts_dir)
  problems: List[str] = []
  warnings: List[str] = []
  missing_files: List[str] = []
  nb_missing_files = 0
  nb_checked_files = 0
  if not artifacts_dir.is_dir():
    problems.append(f"The artifacts folder does not exist: {artifacts_dir}")
  else:
    if not config_file(repo_artifacts_dir):
      problems.append(f"qaboard.yaml is missing from {repo_artifacts_dir}")
    if is_subproject and not config_file(artifacts_dir):
      # qa looks for qaboard.yaml in the parent folders: it would use the parent project's configuration,
      # and save the runs in the parent project.
      problems.append(f"The subproject's qaboard.yaml is missing from {artifacts_dir}: runs would use the parent project's configuration, and be saved in the wrong project.")
    for manifest in manifests(artifacts_dir):
      try:
        files = read_manifest(manifest)
      except Exception as e:
        problems.append(f"Could not read the artifacts manifest {manifest.name}: {e}")
        continue
      for file in files:
        if nb_checked_files >= max_checked_files:
          break
        nb_checked_files += 1
        if not (repo_artifacts_dir / file).exists():
          nb_missing_files += 1
          if len(missing_files) < 10:
            missing_files.append(file)
    if nb_missing_files:
      # Runs may not need them, and manifests keep files that are gone (`qa save-artifacts` only adds to them)
      warnings.append(f"{nb_missing_files} artifacts listed in the manifests are missing, like {missing_files[0]}")
  return {
    "ok": not problems,
    "problems": problems,
    "warnings": warnings,
    "missing_files": missing_files,
    "nb_missing_files": nb_missing_files,
    "nb_checked_files": nb_checked_files,
    "artifacts_dir": str(artifacts_dir),
    "exists": artifacts_dir.is_dir(),
  }



# The first line of the scripts that run `qa batch` from a commit's artifacts (redo.py, api/tuning.py): tells users how
# it went, and removes the copy of the artifacts the batch fetched (cd_lines), with the runs' local files
# On Kubernetes without a shared storage, `qa send-batch-log` (QABOARD_LOG_PID) sends the log: it gets the end of it.
EXIT_TRAP = """trap 'code=$?; [[ -n "${QABOARD_BATCH_TMP:-}" ]] && rm -rf "$QABOARD_BATCH_TMP"; echo "[qaboard] qa batch exited with code $code"; [[ -n "${QABOARD_LOG_PID:-}" ]] && { exec >&- 2>&-; wait "$QABOARD_LOG_PID"; }' EXIT"""
# Where `qa batch` can run from artifacts sent to the server: they are fetched where it runs, the server's machine or
# a Kubernetes pod, and so are the runs' on Kubernetes. The other runners' jobs would need the batch's copy.
UPLOADED_ARTIFACTS_RUNNERS = ('local', 'kubernetes')


def cd_lines(ci_commit, source_envrc: bool = False) -> List[str]:
  """
  Bash lines that go to a commit's artifacts folder, in the scripts that run `qa batch` there (redo.py, api/tuning.py).
  When `qa save-artifacts` sent them to the server, the batch fetches its own copy (`qa fetch-artifacts`, cached in
  a temporary folder that EXIT_TRAP removes), wherever it runs: its runs save their files there, then send them.
  `source_envrc`: then source the repository's .envrc files down to the project's folder.
  """
  folder = quote(str(ci_commit.artifacts_dir))
  if ci_commit.uploaded_artifacts_dir is None:
    return [f'mkdir -p {folder}', f'cd {folder}']
  fetch = f"qa fetch-artifacts --project {quote(ci_commit.project_id)} --commit {quote(ci_commit.hexsha)}"
  lines = [
    'QABOARD_BATCH_TMP="$(mktemp -d)"',
    'export QABOARD_ARTIFACTS_CACHE="$QABOARD_BATCH_TMP"',
    f'QABOARD_ARTIFACTS_DIR="$({fetch})" || {{ echo "[qaboard] ERROR: could not fetch the commit\'s artifacts from QA-Board (see above)" >&2; exit 1; }}',
    'cd "$QABOARD_ARTIFACTS_DIR"',
  ]
  if source_envrc:
    depth = len([part for part in Path(ci_commit.project.id_relative or '.').parts if part not in ('', '.')])
    envrcs = " ".join("../" * level + ".envrc" for level in reversed(range(depth + 1)))
    lines.append(f'set +e; for envrc in {envrcs}; do [[ -f "$envrc" ]] && source "$envrc"; done; set -e')
  return lines


def runner_unsupported(ci_commit, runner: Optional[str]) -> Optional[str]:
  """
  Why QA-Board can't start runs from this commit's artifacts with `runner` (server_runner.server_runner(), or for redo
  redo_runner(): "bridge"), if it can't. None says nothing: server_runner.refusal() refuses it first. Here:
  without a shared storage, or when their results need a token its jobs can't get (tokens.RUNNERS_WITHOUT_TOKEN).
  """
  if runner is None:
    return None
  if ci_commit.uploaded_artifacts_dir is None:
    from .tokens import RUNNERS_WITHOUT_TOKEN
    from .settings import setting
    if runner in RUNNERS_WITHOUT_TOKEN and setting('ingest.auth') == 'token':
      return ("QA-Board can't start this project's runs through LSF: this server only accepts results sent with a "
              "token, and LSF jobs don't get one from QA-Board. Start the batch from CI or a terminal with `qa batch` "
              "after `qa auth login`, or ask its administrators to run batches on Kubernetes (QABOARD_TUNING_RUNNER=kubernetes).")
    return None
  if runner in UPLOADED_ARTIFACTS_RUNNERS:
    return None
  return (f"QA-Board can't start this project's runs with its {runner} runner: the project has no storage shared with "
          "QA-Board. Ask its administrators to run batches on Kubernetes (QABOARD_TUNING_RUNNER=kubernetes; local works "
          "too, but runs the projects' code in QA-Board's own container), or start the batch from CI or a terminal with `qa batch`.")


class Protected:
  """Files and folders, relative to a commit's repository artifacts folder, that a deletion must keep."""
  def __init__(self, files: Iterable[str] = (), dirs: Iterable[str] = (), all_but: Optional[str] = None):
    self.files: Set[str] = {normalize(f) for f in files}
    # "" would be the repository folder itself: the root project is protected by its manifests' files
    self.dirs: List[str] = [normalize(d) for d in dirs if normalize(d) != '.']
    # when we can't know what a sibling uses, we protect everything outside of our own folder
    self.all_but = normalize(all_but) if all_but is not None else None

  def __bool__(self):
    return bool(self.files or self.dirs or self.all_but is not None)

  def __call__(self, relative_path: str) -> bool:
    """Is this path, or something it contains, protected?"""
    path = normalize(relative_path)
    if self.all_but is not None and self.all_but != '.':
      if not (path == self.all_but or path.startswith(f"{self.all_but}/")):
        return True
    if path in self.files:
      return True
    for d in self.dirs:
      if path == d or path.startswith(f"{d}/") or d.startswith(f"{path}/"):
        return True
    prefix = f"{path}/"
    return any(f.startswith(prefix) for f in self.files)


def normalize(relative_path: str) -> str:
  # "sub/a/../b/x" is "sub/b/x"
  return Path(os.path.normpath(str(relative_path))).as_posix()


def protected_by_siblings(repo_artifacts_dir: Path, siblings: Iterable[Tuple[Path, Path]], own_dir: Optional[Path] = None) -> Protected:
  """
  The files other (sub)projects of the same commit still need.
  siblings: (repo_artifacts_dir, artifacts_dir) of each commit that was not deleted.
  own_dir: the artifacts folder of the commit we delete
  """
  repo_artifacts_dir = Path(repo_artifacts_dir)
  files: Set[str] = set()
  dirs: List[str] = []
  all_but = None
  for sibling_repo_dir, sibling_dir in siblings:
    if Path(sibling_repo_dir) != repo_artifacts_dir:
      continue # stored elsewhere, nothing is shared
    try:
      dirs.append(Path(sibling_dir).relative_to(repo_artifacts_dir).as_posix())
    except ValueError:
      continue
    try:
      sibling_manifests = manifests(Path(sibling_dir))
    except Exception:
      sibling_manifests = []
    if not sibling_manifests:
      # Saved before manifests existed, or unreadable: we can't tell what it uses.
      # We keep everything but our own folder.
      files.update(CONFIG_NAMES)
      if own_dir is not None:
        try:
          all_but = Path(own_dir).relative_to(repo_artifacts_dir).as_posix()
        except ValueError:
          pass
    for manifest in sibling_manifests:
      try:
        files.update(read_manifest(manifest).keys())
      except Exception:
        # we can't tell what it uses: keep its whole folder, and what's at the repository's root
        files.update(CONFIG_NAMES)
  return Protected(files, dirs, all_but=all_but)


def is_kept(group: str, file: str, keep: Iterable[str]) -> bool:
  """`storage.garbage.artifacts.keep` lists artifact groups (e.g. `coverage_report`) or paths/globs (e.g. `build/my_binary`)"""
  for k in keep or []:
    k = str(k).rstrip('/')
    if group == k or file == k or file.startswith(f"{k}/") or fnmatch.fnmatch(file, k):
      return True
  return False


def rmtree_except(directory: Path, root: Path, is_protected: Callable[[str], bool], rmtree: Callable[[Path], int], dryrun=False) -> int:
  """Deletes everything in `directory` but the protected paths (relative to `root`). Returns the number of files deleted."""
  nb_deleted = 0
  if not directory.is_dir() or directory.is_symlink():
    return 0
  for child in sorted(directory.iterdir()):
    relative = child.relative_to(root).as_posix()
    if not is_protected(relative):
      nb_deleted += 1 if dryrun else rmtree(child)
    elif child.is_dir() and not child.is_symlink():
      nb_deleted += rmtree_except(child, root, is_protected, rmtree, dryrun)
  return nb_deleted


class ArtifactsUnavailable(Exception):
  """We can't run from a commit's artifacts (yet). `details` is returned to the web app."""
  def __init__(self, message, details=None):
    super().__init__(message)
    self.message = message
    self.details = details or {}

  def to_dict(self):
    return {"error": self.message, "artifacts": self.details}
