"""
`qa restore <run>`: the code a local run ran, in a branch of this repository (docs/rfcs/local-changes.md).

The run recorded its commit and its local changes (qaboard/local_changes.py): `qa restore` makes a branch
qa-restore/<run id> at the commit, and applies the uncommitted changes in the working tree. When the commit was
never pushed, it starts from the commit the run's unpushed commits are based on, and commits them first.

    qa restore 1234
    qa restore "https://qaboard/my/project/commit/abc123?filter=id:1234"
    qa restore 1234 --download     # only saves the patches here

It is `wandb restore`. It never touches a working tree with changes.
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

import click

from .local_changes import PATCH_FILE, UNPUSHED_FILE


def parse_run(run: str, server: str | None) -> tuple[int, str | None]:
  """(run id, server) from a run id, or a web app URL that names one run (filter=id:<n>, or /output/<n>)"""
  if re.fullmatch(r'\d+', run.strip()):
    return int(run), server
  parts = urlsplit(run.strip())
  if not parts.scheme or not parts.netloc:
    raise click.UsageError(f"{run!r}: give a run's id, or the address of its page in the web app.")
  found = re.search(r'(?:^|[?&])filter=id(?::|%3A)(\d+)', parts.query) or re.search(r'/output/(\d+)', unquote(parts.path))
  if not found:
    raise click.UsageError(f"{run} doesn't name one run: open the run in the web app (its menu has \"Copy link\"), or give its id.")
  return int(found.group(1)), server or f"{parts.scheme}://{parts.netloc}"


SHA = re.compile(r'[0-9a-f]{40}([0-9a-f]{24})?')
CONTROL = re.compile(r'[\x00-\x1f\x7f-\x9f]')


def _safe(value: Any) -> str:
  """What a run says, printed: without control characters (they could hide lines or rewrite the terminal)"""
  return CONTROL.sub('', str(value))


def _glob_literal(path: str) -> str:
  """A path as a glob that matches only itself, for git apply --exclude"""
  return re.sub(r'([*?\[\\])', r'[\1]', path)


def _git(args: list[str], cwd: Path, check: bool = True, input: str | None = None) -> subprocess.CompletedProcess:
  return subprocess.run(['git', *args], cwd=cwd, input=input, capture_output=True, encoding='utf-8', errors='replace', check=check)


def _created(repo: Path, patch: Path, excluded: list[str]) -> list[str]:
  """The files a patch creates (git apply --summary), and which of them are executable"""
  summary = _git(['apply', '--summary', *excluded, str(patch)], repo, check=False).stdout
  return [m.group(2) for m in re.finditer(r'^ create mode (\d+) (.+)$', summary, re.MULTILINE)]


def _has_commit(repo: Path, sha: str | None) -> bool:
  return bool(sha) and _git(['cat-file', '-e', f'{sha}^{{commit}}'], repo, check=False).returncode == 0


def plan(changes: dict[str, Any], has_commit) -> tuple[str | None, bool, str | None]:
  """
  (where to start, whether to apply the unpushed commits' patch, why we can't) for a run's local changes.
  `has_commit(sha)` says whether this repository has a commit.
  """
  # only commits: a run that says "HEAD" or "main" would restore someone else's code on your branch
  head = changes.get('head') if isinstance(changes.get('head'), str) and SHA.fullmatch(changes['head']) else None
  base = changes.get('base') if isinstance(changes.get('base'), str) and SHA.fullmatch(changes['base']) else None
  unpushed_saved = bool((changes.get('unpushed') or {}).get('path'))
  if head and has_commit(head):
    return head, False, None
  if base and unpushed_saved and has_commit(base):
    return base, True, None
  if not head:
    return None, False, "The run didn't record its commit (or not as a commit id)."
  if base and unpushed_saved:
    return None, False, f"This repository has neither the run's commit {head[:10]} nor {base[:10]}: `git fetch`, then try again."
  return None, False, f"This repository doesn't have the run's commit {head[:10]}{', which was never pushed' if changes.get('pushed') is False else ''}: `git fetch`, then try again."


def binary_files(changes: dict[str, Any]) -> list[str]:
  """Binary files are in the patch as "Binary files differ", without their content: git apply can't apply them"""
  return [f['path'] for f in changes.get('files') or [] if isinstance(f, dict) and f.get('binary') and isinstance(f.get('path'), str)]


@click.command()
@click.argument('run')
@click.option('--server', help="The QA-Board server, when the run's address doesn't say (e.g. served under a path prefix).")
@click.option('--branch', help="The branch to create. Default: qa-restore/<run id>.")
@click.option('--download', is_flag=True, help="Only save the run's patches in this folder: don't change the repository.")
def restore(run, server, branch, download):
  """
  Make a branch with the code a local run ran: its commit, and its uncommitted changes.

  \b
      qa restore 1234
      qa restore "https://qaboard/my/project/commit/abc123?filter=id:1234"

  The run must have saved its local changes (outputs.local_changes: patch, the default). Run it in a clone of the
  run's repository, without uncommitted changes.
  """
  from .credentials import default_server
  from .http_client import ResultsError
  from .results import _request, _token_for
  from .run_files import fetch_file
  run_id, server = parse_run(run, server)
  server = (server or default_server()[0]).rstrip('/')
  token = _token_for(server, None)
  try:
    output = _request(server, f"output/{run_id}", token=token)
  except ResultsError as e:
    click.secho(f"ERROR: can't get run {run_id} from {server}: {e}", fg='red', bold=True, err=True)
    sys.exit(1)
  changes = (output.get('data') or {}).get('local_changes')
  if not isinstance(changes, dict):
    ci = (output.get('data') or {}).get('ci')
    why = "it ran in CI, on its commit" if ci else "it ran before QA-Board recorded local changes, or with outputs.local_changes: off"
    click.secho(f"Run {run_id} didn't record its local changes: {why}.", fg='yellow', err=True)
    sys.exit(1)

  # only where qa saves them
  saved = {key: name for key, name in (('patch', PATCH_FILE), ('unpushed', UNPUSHED_FILE)) if (changes.get(key) or {}).get('path') == name}
  if changes.get('dirty') and not saved.get('patch'):
    omitted = (changes.get('patch') or {}).get('omitted')
    why = {'too_large': "it was too large", 'level': "the server keeps only a summary of runs' local changes", 'timeout': "git took too long",
           'no_answer': "the server didn't answer when the run started"}.get(omitted, "it couldn't be saved")
    click.secho(f"Run {run_id} changed {changes.get('files_total', '?')} files but didn't save its patch: {why}.", fg='red', bold=True, err=True)
    sys.exit(1)

  with tempfile.TemporaryDirectory(prefix='qa-restore-') as tmp:
    patches: dict[str, Path] = {}
    for key, name in saved.items():
      if not name:
        continue
      target = Path(tmp) / Path(name).name
      try:
        if not fetch_file(server, output, name, target, token=token):
          click.secho(f"ERROR: the server doesn't have {name} of run {run_id}: its files were deleted?", fg='red', bold=True, err=True)
          sys.exit(1)
      except (ResultsError, ValueError) as e:
        click.secho(f"ERROR: can't download {name}: {e}", fg='red', bold=True, err=True)
        sys.exit(1)
      patches[key] = target

    if download:
      for key, path in patches.items():
        destination = Path(f"run-{run_id}-{path.name}")
        destination.write_bytes(path.read_bytes())
        click.echo(f"Saved {destination}")
      sha = lambda key: changes[key] if isinstance(changes.get(key), str) and SHA.fullmatch(changes[key]) else f'<{key}>'
      applies = ' && '.join(f"git apply run-{run_id}-{patches[key].name}" for key in ('unpushed', 'patch') if key in patches)
      if 'unpushed' in patches:
        click.echo(f"To apply them: git checkout {sha('base')[:12]} && {applies}")
      elif patches:
        click.echo(f"To apply it: git checkout {sha('head')[:12]} && {applies}")
      else:
        click.echo(f"Run {run_id} had no local changes: it ran {sha('head')[:12]}.")
      click.secho(f"It is code from {_safe((output.get('data') or {}).get('user') or 'whoever sent the run')}: read it before you run it.", fg='yellow')
      return

    found = _git(['rev-parse', '--show-toplevel'], Path.cwd(), check=False)
    if found.returncode != 0:
      click.secho("ERROR: run qa restore in a clone of the run's repository (or use --download).", fg='red', bold=True, err=True)
      sys.exit(1)
    repo = Path(found.stdout.strip())
    status = _git(['status', '--porcelain', '--untracked-files=no'], repo).stdout
    if status.strip():
      click.secho("ERROR: this working tree has uncommitted changes: commit or stash them first (git stash -u).", fg='red', bold=True, err=True)
      sys.exit(1)

    start, apply_unpushed, problem = plan(changes, lambda sha: _has_commit(repo, sha))
    if problem or start is None:
      click.secho(f"ERROR: {problem}", fg='red', bold=True, err=True)
      sys.exit(1)
    branch = branch or f"qa-restore/{run_id}"
    created = _git(['switch', '-q', '-c', branch, start], repo, check=False)
    if created.returncode != 0:
      click.secho(f"ERROR: can't create the branch {branch}: {created.stderr.strip()}\nGive another name with --branch.", fg='red', bold=True, err=True)
      sys.exit(1)

    excluded = [f'--exclude={_glob_literal(path)}' for path in binary_files(changes)]
    who = _safe((output.get('data') or {}).get('user') or 'whoever sent the run')
    created_files: list[str] = []
    if apply_unpushed:
      applied = _git(['apply', '--index', *excluded, str(patches['unpushed'])], repo, check=False)
      if applied.returncode != 0:
        click.secho(f"ERROR: the run's unpushed commits don't apply on {start[:10]}: {_safe(applied.stderr.strip())}", fg='red', bold=True, err=True)
        sys.exit(1)
      created_files += _created(repo, patches['unpushed'], excluded)
      # not signed with your key: it's someone else's code
      _git(['commit', '-q', '--no-verify', '--no-gpg-sign', '--author=qa restore <qa-restore@localhost>',
            '-m', f"The unpushed commits of run {run_id}, by {who}, up to {(changes.get('head') or '')[:12]}"], repo)
    if 'patch' in patches:
      new_files = _created(repo, patches['patch'], excluded)
      applied = _git(['apply', *excluded, str(patches['patch'])], repo, check=False)
      if applied.returncode != 0:
        click.secho(f"ERROR: the run's local changes don't apply: {_safe(applied.stderr.strip())}", fg='red', bold=True, err=True)
        click.secho(f"The branch {branch} is at {start[:10]}{' with the unpushed commits' if apply_unpushed else ''}.", fg='yellow', err=True)
        sys.exit(1)
      # new files, as "intent to add": `git diff` shows them with the other changes
      if new_files:
        _git(['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul', '--'], repo, check=False, input=''.join(f + '\0' for f in new_files))
      created_files += new_files

  click.secho(f"On the branch {branch}: the code of run {run_id}", fg='green', bold=True)
  click.secho(f"  It is code from {who}: read it before you run it (git diff {start[:12]}).", fg='yellow')
  if created_files:
    click.echo(f"  New files: {', '.join(_safe(f) for f in created_files[:10])}{'...' if len(created_files) > 10 else ''}")
  details = [f"commit {(changes.get('head') or start)[:10]}"]
  if apply_unpushed:
    details.append(f"{changes.get('unpushed_commits') or 'its'} unpushed commit(s), committed as one")
  if 'patch' in patches:
    details.append(f"{_safe(changes.get('files_total', '?'))} changed files, not committed (git diff shows them)")
  click.echo("  " + ", ".join(details))
  skipped = binary_files(changes)
  if skipped:
    click.secho(f"  Binary files aren't saved with runs, they are as in the commit: {', '.join(_safe(p) for p in skipped[:5])}{'...' if len(skipped) > 5 else ''}", fg='yellow')
  if changes.get('excluded'):
    click.secho(f"  Left out when the run started (they look like secrets, or outputs.local_changes.exclude): {', '.join(_safe(p) for p in changes['excluded'][:5])}", fg='yellow')
  if changes.get('untracked_contents') == 'too_many':
    click.secho("  The run had too many untracked files to save their contents: they are missing.", fg='yellow')
  inputs = output.get('test_input_path')
  if inputs:
    configurations = output.get('configurations') or []
    click.echo(_safe(f"  It ran on {inputs}" + (f", with {configurations}" if configurations else '') + (f" and {output['extra_parameters']}" if output.get('extra_parameters') else '')))
