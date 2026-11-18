"""
`qa batch --commit` and `qa optimize --commit`: QA-Board starts the batch on a commit, as when users start one from its
web app (backend/api/tuning.py): from the commit's artifacts, with its qaboard.yaml and batch files. Nothing runs here,
and the local code doesn't matter: the results are those of the commit, like the web app's (they are "webapp" runs).

    qa --label my-tuning batch --commit abc1234 nightly --tuning-search-file tuning.yaml --batches-file local.yaml

What it does:
1. Finds the commit with git: a full id, and warnings when it doesn't seem to be pushed, or when the local batch files
   differ from the commit's (they are not used, unless sent with --batches-file).
2. Asks the server to check the request (POST /api/v1/commit/<id>/batch/check), and says what's wrong.
3. Starts the batch (POST /api/v1/commit/<id>/batch), prints its page and returns. It doesn't wait for the runs.

It refuses to start without --label (the runs would go with the commit's CI results), without the commit's artifacts
(unless QA-Board can ask the CI to recreate them), and with options that only apply to local runs.
Exit codes: 0 started, 1 not started, 2 not yet (the artifacts are being recreated).
"""
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import quote

import click
from click.core import ParameterSource


class StartError(Exception):
  """Why we didn't start the batch. The message says what to do. `try_later`: it may work later, e.g. once the CI recreated the artifacts."""
  def __init__(self, message: str, try_later: bool = False):
    super().__init__(message)
    self.try_later = try_later


# What the server does with them: the other options of `qa` and `qa batch` don't apply
SERVER_OPTIONS = {
  'qa': {'label', 'platform', 'dryrun'},
  'batch': {'on_commit', 'batches', 'batch_names', 'batches_files', 'tuning_search_dict', 'tuning_search_file', 'action_on_existing', 'no_wait'},
  'optimize': {'on_commit', 'batches', 'batches_files', 'config_file'},
}


def given_options(ctx: click.Context) -> List[click.Parameter]:
  """
  The parameters users gave on the command line. Those from the environment (QA_RUNNER, QA_DATABASE...) are often
  set for all commands, e.g. in an .envrc: they are ignored, except QA_LABEL and QA_PLATFORM.
  """
  return [p for p in ctx.command.params if p.name and ctx.get_parameter_source(p.name) == ParameterSource.COMMANDLINE]


def check_options(ctx: click.Context, forwarded_args: Iterable[str] = ()):
  """Refuses the options that don't apply when QA-Board starts the batch, instead of ignoring them."""
  unsupported: List[str] = []
  for context in (ctx.parent, ctx):
    if context is None:
      continue
    allowed = SERVER_OPTIONS['qa'] if context is ctx.parent else SERVER_OPTIONS[ctx.command.name or 'batch']
    unsupported.extend(p.opts[0] if p.opts else p.name for p in given_options(context) if p.name not in allowed)
  if unsupported:
    raise StartError(f"{', '.join(unsupported)} can't be used with --commit: QA-Board starts the batch as from its web app, "
                     "with the commit's code and settings. Run without --commit to use them locally.")
  if list(forwarded_args):
    raise StartError(f"With --commit, QA-Board can't forward arguments to your code ({' '.join(forwarded_args)}).")


def git(*args: str, cwd: Optional[Path] = None) -> Optional[str]:
  """git's output, or None if it failed (e.g. not a repository)."""
  try:
    p = subprocess.run(["git", *args], cwd=cwd, encoding='utf-8', stdout=subprocess.PIPE, stderr=subprocess.PIPE)
  except OSError: # no git
    return None
  return p.stdout.strip() if p.returncode == 0 else None


def resolve_commit(rev: str, cwd: Optional[Path] = None) -> Tuple[str, List[str]]:
  """
  The commit id to send for a revision (an id, a branch, a tag, HEAD...), and warnings.
  Raises StartError when git doesn't know it and it doesn't look like a commit id the server may know.
  """
  warnings: List[str] = []
  sha = git("rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}", cwd=cwd)
  if not sha:
    if re.fullmatch(r'[0-9a-fA-F]{7,40}', rev):
      # e.g. outside of the repository: QA-Board knows the commits CI ran `qa` on
      return rev.lower(), warnings
    raise StartError(f"Unknown commit {rev!r}: give a commit id, a branch or a tag" +
                     (" (run `git fetch` if it was pushed from elsewhere)." if git("rev-parse", "--git-dir", cwd=cwd) else ", from your repository."))
  # A local branch can be behind or ahead of what was pushed
  upstream = git("rev-parse", "--verify", "--quiet", f"{rev}@{{upstream}}^{{commit}}", cwd=cwd)
  if upstream and upstream != sha and git("rev-parse", "--verify", "--quiet", f"refs/heads/{rev}", cwd=cwd):
    name = git("rev-parse", "--abbrev-ref", f"{rev}@{{upstream}}", cwd=cwd) or "its upstream"
    warnings.append(f"Your branch {rev} is at {sha[:10]}, but {name} is at {upstream[:10]}: using {sha[:10]}.")
  if git("rev-parse", "--git-dir", cwd=cwd) and not git("branch", "--remotes", "--contains", sha, cwd=cwd):
    warnings.append(f"{sha[:10]} is on none of the remote branches you fetched: QA-Board only knows it if it was pushed, and its CI ran `qa`.")
  return sha, warnings


def changed_batches_files(sha: str, files: Iterable[Path], root: Path) -> List[Path]:
  """The local batch files (from inputs.batches) that differ from the commit's: QA-Board uses the commit's."""
  # git can't compare files outside of the repository
  paths = [str(f) for f in files if not Path(f).is_absolute() and (root / f).exists()]
  if not paths or not git("rev-parse", "--git-dir", cwd=root):
    return []
  # -z: paths as they are, not quoted when they aren't ASCII
  changed = set((git("diff", "-z", "--name-only", "--relative", sha, "--", *paths, cwd=root) or "").split("\0"))
  changed |= set((git("ls-files", "-z", "--others", "--exclude-standard", "--", *paths, cwd=root) or "").split("\0"))
  return [Path(p) for p in paths if Path(p).as_posix() in changed]


def local_file(path: Path, root: Path, previous_cwd: Optional[Path], what: str) -> Path:
  """A file users give: relative paths are from the root qaboard.yaml's folder, like for `qa batch`, else from where qa was started."""
  path = Path(path)
  candidates = [path] if path.is_absolute() else [root / path, *([previous_cwd / path] if previous_cwd else [])]
  location = next((c for c in candidates if c.is_file()), None)
  if location is None:
    raise StartError(f"Could not find the {what} {path}.")
  return location


def read_text(location: Path, what: str) -> str:
  try:
    return location.read_text(encoding='utf-8')
  except (OSError, UnicodeDecodeError) as e:
    raise StartError(f"Could not read the {what} {location}: {e}")


def batches_file_to_send(path: Path, root: Path, previous_cwd: Optional[Path] = None) -> Dict[str, str]:
  """{path, content} for the server."""
  location = local_file(path, root, previous_cwd, "batch file")
  content = read_text(location, "batch file")
  location = location.resolve()
  # users see it as they know it: relative to the project when it's in it
  shown = location.relative_to(root.resolve()).as_posix() if location.is_relative_to(root.resolve()) else location.name
  return {"path": shown, "content": content}


def tuning_search_to_send(value: Optional[str], file: Optional[Path], root: Path, previous_cwd: Optional[Path]) -> Optional[Dict[str, Any]]:
  """The tuning search of --tuning-search (JSON) or --tuning-search-file (JSON or YAML), like `qa batch` reads them."""
  if value and file:
    raise StartError("Give either --tuning-search or --tuning-search-file, not both.")
  if not value and not file:
    return None
  if file:
    location = local_file(file, root, previous_cwd, "tuning search file")
    text, is_yaml = read_text(location, "tuning search file"), location.suffix in ('.yaml', '.yml')
    if not is_yaml and location.suffix != '.json':
      raise StartError(f"The tuning search file should be .json, .yaml or .yml: {file}")
  else:
    text, is_yaml = str(value), False
  try:
    import json
    import yaml
    search = yaml.load(text, Loader=yaml.SafeLoader) if is_yaml else json.loads(text)
  except Exception as e:
    raise StartError(f"Invalid tuning search{f' in {file}' if file else ''}: {e}")
  if not isinstance(search, dict):
    raise StartError("The tuning search should be a mapping, e.g. {\"parameter_search\": {\"threshold\": [1, 2]}}.")
  return search


def describe_definitions(definitions: List[Dict[str, Any]]) -> List[str]:
  """Where each batch is defined, e.g. "night: qa/batches.yaml, then qa/local.yaml (sent), which wins"."""
  lines = []
  for definition in definitions:
    files = [f"{path} (sent)" if source == 'sent' else f"QA-Board's {path}" if source == 'qaboard' else path
             for path, source in zip(definition.get('files', []), definition.get('sources', []))]
    described = files[0] if len(files) == 1 else f"{', '.join(files[:-1])}, then {files[-1]}, which wins"
    lines.append(f"{definition['name']}: {described}")
  return lines


def request_body(label: str, platform: Optional[str], batches: List[str], sent: List[Dict[str, str]],
                 tuning_search: Optional[Dict[str, Any]], action_on_existing: Optional[str]) -> Dict[str, Any]:
  """What the web app's form sends, for the server's defaults see with_defaults() in backend/api/tuning.py"""
  body: Dict[str, Any] = {
    "batch_label": label,
    "selected_group": batches,
    # scripts don't want emails
    "notify": False,
  }
  if platform:
    body["platform"] = platform
  if sent:
    body["batches_files"] = sent
  if tuning_search is not None:
    body["tuning_search"] = tuning_search
  if action_on_existing is not None:
    if action_on_existing not in ('run', 'sync'):
      raise StartError(f"With --commit, --action-on-existing can only be run (redo existing runs) or sync (keep them, the default), not {action_on_existing!r}.")
    body["overwrite"] = action_on_existing == 'run'
  return body


def post(path: str, project: str, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
  """POSTs to the server's API. Returns (status, JSON body). Raises StartError for network errors and refused requests."""
  import requests
  from .api import api_prefix, api_verify, api_timeout, headers_for, qaboard_url, print_auth_error
  from .credentials import json_body, describe_body, describe_network_error
  try:
    r = requests.post(f"{api_prefix}{path}", params={"project": project}, json=body, headers=headers_for(qaboard_url), verify=api_verify, timeout=api_timeout)
  except requests.exceptions.RequestException as e:
    raise StartError(f"Could not reach QA-Board at {qaboard_url}: {describe_network_error(e)}")
  if r.status_code in (401, 403):
    # it says why, and what to do (sign in, ask for a role...)
    if not print_auth_error(r, "QA-Board refused to start the batch"):
      raise StartError(f"QA-Board refused to start the batch ({r.status_code}): {describe_body(r)}")
    raise StartError("Nothing was started.")
  data = json_body(r)
  if not data:
    raise StartError(f"Unexpected answer from QA-Board ({r.status_code}): {describe_body(r)}")
  if not 200 <= r.status_code < 300:
    # e.g. the artifacts are being recreated: scripts can try again later
    later = r.status_code == 409 and (data.get('artifacts') or {}).get('status') == 'recreating'
    raise StartError("\n       ".join(errors_of(data)) or f"QA-Board refused ({r.status_code}): {describe_body(r)}", try_later=later)
  return r.status_code, data


def errors_of(data: Dict[str, Any]) -> List[str]:
  return [str(e) for e in data.get('errors') or []] or ([str(data['error'])] if data.get('error') else [])


def check_artifacts(artifacts: Dict[str, Any]):
  """
  We don't start without the commit's artifacts, unless QA-Board can ask the CI to recreate them.
  The web app would restore what is in the source code, but runs that need build outputs would then fail.
  """
  if not artifacts or artifacts.get('ok'):
    return
  problems = " ".join(artifacts.get('problems') or [])
  if artifacts.get('recreating'):
    raise StartError(f"The commit's artifacts are being recreated: {problems} Try again once it's done.", try_later=True)
  if artifacts.get('recreate') and not artifacts.get('recreate_errors'):
    # starting asks the CI to recreate them
    return
  docs = f" ({artifacts['recreate_docs']})" if artifacts.get('recreate_docs') else ""
  raise StartError(f"The commit's artifacts are missing: {problems} If the commit was just pushed, wait for its CI to "
                   f"save them (`qa save-artifacts`). To have QA-Board rebuild deleted artifacts, set `recreate_artifacts` in qaboard.yaml{docs}.")


# Exit codes: scripts can try again later when the commit's artifacts are being recreated
EXIT_STARTED, EXIT_FAILED, EXIT_TRY_LATER = 0, 1, 2

def start_on_server(ctx: click.Context, rev: str, batches: List[str], batches_files: Iterable[Path] = (),
                    tuning_search: Tuple[Optional[str], Optional[Path]] = (None, None), optimize_config: Optional[Path] = None,
                    action_on_existing: Optional[str] = None, forwarded_args: Iterable[str] = ()):
  """
  Asks QA-Board to start the batch on the commit, and exits: 0 when it started, 1 when it didn't, with why,
  2 when it can't start yet (the artifacts are being recreated).
  """
  try:
    url = _start_on_server(ctx, rev, batches, batches_files, tuning_search, optimize_config, action_on_existing, forwarded_args)
  except StartError as e:
    click.secho(f"ERROR: {e}", fg='red', bold=True, err=True)
    sys.exit(EXIT_TRY_LATER if e.try_later else EXIT_FAILED)
  if url:
    # the only output on stdout: scripts can read it
    click.echo(url)
  sys.exit(EXIT_STARTED)


def _start_on_server(ctx, rev, batches, batches_files, tuning_search, optimize_config, action_on_existing, forwarded_args) -> Optional[str]:
  from .config import project, root_qatools, default_batches_files
  from .api import qaboard_url
  check_options(ctx, forwarded_args)
  if not rev.strip():
    raise StartError("--commit is empty: give a commit id, a branch or a tag.")
  if not batches:
    raise StartError("Give the batch to run, e.g. `qa --label my-tuning batch --commit abc1234 nightly`.")
  if project is None:
    raise StartError("Run `qa batch --commit` from your project, next to its qaboard.yaml.")
  # The label from --label or QA_LABEL, never "@user| " like with --share: these are the commit's results
  label = ctx.obj['raw_batch_label']
  if ctx.parent.get_parameter_source('label') in (None, ParameterSource.DEFAULT, ParameterSource.DEFAULT_MAP):
    raise StartError(f"Name the batch with --label, e.g. `qa --label my-tuning {ctx.command.name} --commit ...`: "
                     f"without it, the runs would be added to the commit's CI results ({label!r}).")
  root = Path(root_qatools) if root_qatools else Path()
  previous_cwd = Path(ctx.obj['previous_cwd']) if ctx.obj.get('previous_cwd') else None
  search: Optional[Dict[str, Any]]
  if optimize_config is not None:
    search = {"search_type": "optimize", "parameter_search": read_text(local_file(optimize_config, root, previous_cwd, "configuration file"), "configuration file")}
  else:
    search = tuning_search_to_send(tuning_search[0], tuning_search[1], root, previous_cwd)

  sha, warnings = resolve_commit(rev.strip(), cwd=root)
  for warning in warnings:
    click.secho(f"WARNING: {warning}", fg='yellow', err=True)

  # The batch files given on the command line are sent. inputs.batches are the commit's.
  given = ctx.get_parameter_source('batches_files') not in (None, ParameterSource.DEFAULT, ParameterSource.DEFAULT_MAP)
  sent = [batches_file_to_send(Path(f), root, previous_cwd) for f in batches_files] if given else []
  sent_paths = {s["path"] for s in sent}
  for changed in changed_batches_files(sha, (Path(f) for f in default_batches_files or []), root):
    if changed.as_posix() not in sent_paths:
      click.secho(f"WARNING: {changed} differs from {sha[:10]}'s, and QA-Board uses the commit's. To use yours, send it with --batches-file {changed}", fg='yellow', err=True)

  # --platform or QA_PLATFORM, else the server's default
  platform = ctx.obj['platform'] if ctx.parent.get_parameter_source('platform') not in (None, ParameterSource.DEFAULT, ParameterSource.DEFAULT_MAP) else None
  body = request_body(label, platform, batches, sent, search, action_on_existing)
  project_id = project.as_posix()
  _, check = post(f"/commit/{sha}/batch/check", project_id, body)
  errors = [str(e) for e in check.get('errors') or []]
  if not errors:
    # before the warnings: they'd say the server would restore the artifacts, but we don't start
    check_artifacts(check.get('artifacts') or {})
  for warning in check.get('warnings') or []:
    click.secho(f"WARNING: {warning}", fg='yellow', err=True)
  if errors:
    raise StartError("\n       ".join(errors))
  for line in describe_definitions(check.get('definitions') or []):
    click.secho(f"  {line}", err=True)

  page = f"{qaboard_url}/{project_id}/commit/{sha}?batch={quote(label)}"
  if ctx.obj.get('dryrun'):
    click.secho(f"Would start {label!r} on {sha[:10]} (--dryrun: nothing started).", fg='green', err=True)
    return None
  _, started = post(f"/commit/{sha}/batch", project_id, body)
  if started.get('warning'):
    click.secho(f"WARNING: {started['warning']}", fg='yellow', err=True)
  click.secho(f"Started {label!r} on {sha[:10]} with QA-Board. Its runs and logs:", fg='green', err=True)
  return page
