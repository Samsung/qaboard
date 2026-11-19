"""
A commit's artifacts sent over HTTP, for projects without a storage shared with the server (`storage: upload` in
qaboard.yaml): the files that runs QA-Board starts itself (tuning, runs done again) need, like qaboard.yaml, the batch
files and the binaries the CI built.

- `qa save-artifacts` sends each file with PUT /api/v1/commit/<commit>/artifacts/files/<path>?project=<project>,
  then the manifests that list them (<subproject>/manifests/<group>.json), then POST /api/v1/commit/ as before.
  The server saves them in a folder it chooses for the commit (backend/uploads.py, commit_artifacts_dir), and
  remembers it (CiCommit.uploaded_artifacts_dir): from there on they are artifacts like those in a shared storage,
  checked, listed, read and deleted by the same code (backend/artifacts.py, CiCommit).
- Pods and machines without that folder fetch them (`qa fetch-artifacts`, qaboard/commit_artifacts.py): GET
  /api/v1/commit/<commit>/artifacts?project=<project> lists the files with their SHA-256, and the hash of the whole
  that clients cache them by; the files are downloaded from the storage's URL (/s/..., with its access checks).
"""
import os
import re
from pathlib import Path

from flask import request, jsonify, g
from sqlalchemy.orm.attributes import flag_modified

from backend import app, db_session
from ..access import invalid_project
from .auth import is_authorized_user, ingest_access, forbidden_project
from ..actor import batch_token_refused
from ..models import CiCommit
from ..artifacts import UPLOADED_ARTIFACTS, manifests, read_manifest
from .. import locations, uploads, tokens
from qaboard.api import dir_to_url
from qaboard.commit_artifacts import bundle_hash, sha256_of


FULL_COMMIT_ID = re.compile(r'[0-9a-f]{40}')


def find_commit(project_id, hexsha):
  return CiCommit.query.filter(CiCommit.project_id == project_id, CiCommit.hexsha == hexsha).one_or_none()


def uploaded_files(ci_commit) -> dict:
  """
  {path in the repository: {"sha256", "size", "executable"}} for the files the commit's manifests list, that exist.
  Paths are checked like the deletion checks them: never out of the folder.
  """
  root = ci_commit.repo_artifacts_dir
  files = {}
  for manifest in manifests(ci_commit.artifacts_dir):
    try:
      listed = read_manifest(manifest)
    except Exception:
      continue
    manifest_mtime = manifest.stat().st_mtime_ns
    # the manifest itself too (hashed here: it doesn't list itself), so that the copy is the folder the server has
    listed = {**listed, manifest.relative_to(root).as_posix(): None}
    for path, info in listed.items():
      relative = os.path.normpath(str(path))
      if relative.startswith(('/', '..')) or relative == '.' or relative in files:
        continue
      file = root / relative
      if not file.is_file() or file.is_symlink():
        continue
      stat = file.stat()
      info = info if isinstance(info, dict) else {}
      sha256 = info.get('sha256')
      # The SHA-256 `qa save-artifacts` listed, unless the file changed since the manifest was written: sent again
      # with another group, or by a save that failed before its manifest. Else, or restored by the server, we hash it.
      if not (isinstance(sha256, str) and re.fullmatch(r'[0-9a-f]{64}', sha256) and stat.st_mtime_ns <= manifest_mtime):
        sha256 = sha256_of(file)
      # the mode the client said, else the file's here (artifacts the server restored from the source code)
      executable = info['executable'] if isinstance(info.get('executable'), bool) else bool(stat.st_mode & 0o111)
      files[Path(relative).as_posix()] = {"sha256": sha256, "size": stat.st_size, "executable": executable}
  return dict(sorted(files.items()))


@app.route("/api/v1/commit/<commit_id>/artifacts/files/<path:path>", methods=['PUT'])
def upload_commit_artifact(commit_id, path):
  """
  Saves one of a commit's artifacts: `path` is its path in the repository (a subproject's files under its folder).
  The request's body is the file, `X-Content-SHA256` its SHA-256 (required). Sending a file again replaces it.
  The commit must exist (POST /api/v1/commit/ first). Always with a token that can send results to the project.
  """
  project_id = request.args.get('project')
  if error := invalid_project(project_id):
    return error
  if not isinstance(commit_id, str) or not FULL_COMMIT_ID.fullmatch(commit_id):
    return jsonify({"error": "Artifacts are saved for a git commit, named by its full id (40 hexadecimal characters).", "reason": "invalid_commit"}), 400
  # who can't see the project doesn't learn whether the commit exists
  if not is_authorized_user(None, project_id):
    return forbidden_project(project_id)
  _, error = ingest_access(project_id, require_token=True)
  if error:
    return error
  # batches only fetch them (`qa fetch-artifacts`): a batch's token can't change what other batches run
  if tokens.is_batch_token(getattr(g.get('actor'), 'token', None)):
    return batch_token_refused("send a commit's artifacts")
  if not uploads.enabled(project_id):
    return jsonify({"error": uploads.disabled_message(), "reason": "uploads_disabled"}), 400
  if request.content_length is None:
    return jsonify({"error": "Send the file's size (Content-Length): chunked uploads aren't supported."}), 411
  sha256 = request.headers.get('X-Content-SHA256')
  if not sha256 or not re.fullmatch(r'[0-9a-fA-F]{64}', sha256):
    return jsonify({"error": "Send the file's SHA-256 (X-Content-SHA256): pods that fetch the artifacts check it.", "reason": "digest_required"}), 400
  ci_commit = find_commit(project_id, commit_id)
  if ci_commit is None:
    return jsonify({"error": f"QA-Board doesn't know the commit {commit_id} of {project_id}: send it first (POST /api/v1/commit/), as `qa save-artifacts` does.", "reason": "unknown_commit"}), 404

  # Where they are already: they stay there, even when the project's new runs go to another storage location since
  directory = ci_commit.uploaded_artifacts_dir
  try:
    if directory is None:
      directory = uploads.commit_artifacts_dir(project_id, commit_id)
    size = uploads.save_file(directory, path, request.stream, request.content_length, sha256=sha256)
  except uploads.UploadError as e:
    return jsonify({"error": str(e), "reason": e.reason, **e.details}), e.status
  location = locations.location_of(directory)
  if (ci_commit.data or {}).get(UPLOADED_ARTIFACTS) != location:
    ci_commit.data = {**(ci_commit.data or {}), UPLOADED_ARTIFACTS: location}
    flag_modified(ci_commit, "data")
    db_session.add(ci_commit)
    db_session.commit()
  return jsonify({"path": path, "size": size})


@app.route("/api/v1/commit/<commit_id>/artifacts", methods=['GET'])
def get_commit_artifacts(commit_id):
  """
  The artifacts `qa save-artifacts` sent for a commit: {"files": {path: {"sha256", "size", "executable"}}, "hash", "url",
  "subproject"}. Download each file from <server><url>/<path>. `hash` changes when any file does: clients cache the
  files by it. `subproject`: where the project is in the repository ("" at its root).
  """
  if not FULL_COMMIT_ID.fullmatch(commit_id or ''):
    # a branch whose name ends with "/artifacts": the commit's results, as before this endpoint
    from .commit import api_ci_commit
    return api_ci_commit(f"{commit_id}/artifacts")
  project_id = request.args.get('project')
  if error := invalid_project(project_id):
    return error
  if not is_authorized_user(None, project_id):
    return forbidden_project(project_id)
  ci_commit = find_commit(project_id, commit_id)
  if ci_commit is None:
    return jsonify({"error": f"QA-Board doesn't know the commit {commit_id} of {project_id}.", "reason": "unknown_commit"}), 404
  if ci_commit.uploaded_artifacts_dir is None:
    return jsonify({"error": f"The artifacts of {commit_id[:8]} weren't sent to QA-Board: they are in a storage it shares with its runs, or weren't saved (`qa save-artifacts`).", "reason": "not_uploaded"}), 404
  if ci_commit.deleted:
    return jsonify({"error": f"The artifacts of {commit_id[:8]} were deleted. Run `qa save-artifacts` on this commit again.", "reason": "deleted"}), 404
  files = uploaded_files(ci_commit)
  if not files:
    return jsonify({"error": f"No artifacts of {commit_id[:8]} are left: run `qa save-artifacts` on this commit again.", "reason": "deleted"}), 404
  return jsonify({
    "files": files,
    "hash": bundle_hash(files),
    "url": dir_to_url(ci_commit.repo_artifacts_dir),
    "subproject": ci_commit.project.id_relative or "",
  })
