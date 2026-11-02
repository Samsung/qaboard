"""
`qa doctor`: checks what you need to run batches with QA-Board, and says how to fix each problem.

Each check is a small function that returns Checks (qaboard/checks.py), from what it's given: they are tested alone
(tests/test_doctor.py). `run_doctor` gathers what they need from qaboard.config and the API settings, and prints
the checks as they come. Runners check themselves with BaseRunner.doctor().

Rules for the checks:
- Quick: the network checks have short timeouts, and stop at the first failure.
- They change nothing: writing tests create a temporary file and delete it. Only `--test-job` starts jobs.
- A failed check says what to do, in a form people can copy: commands, a qaboard.yaml snippet, whom to ask.
- They never print secrets: tokens and passwords are masked.
"""
import os
import sys
import re
import json
import uuid
import errno
import shutil
import fnmatch
import tempfile
import subprocess
from pathlib import Path
from urllib.parse import quote
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Tuple

import click
import yaml

from .checks import Check, OK, WARNING, ERROR, SKIPPED


DOCS = "https://samsung.github.io/qaboard/docs"
ISSUES = "https://github.com/Samsung/qaboard/issues"
SCHEMA_URL = "https://samsung.github.io/qaboard/qaboard.schema.json"

def docs(page: str) -> str:
  """The URL of a docs page, by its id, e.g. docs('lsf-integration#limiting-concurrency')"""
  return f"{DOCS}/{page}"


# (connect, read) timeouts of the requests to QA-Board: `qa doctor` must be quick even if the server is down
TIMEOUT = (3.05, 5)
# Below this, we warn that the storage may soon be full
LOW_DISK_SPACE = 1024 ** 3
CONFIG_NAMES = ('qaboard.yaml', 'qatools.yaml')


def run_command(command: str, timeout: float = 15, cwd: Optional[str] = None) -> Tuple[Optional[int], str]:
  """Runs a shell command: (its exit code, None if it timed out, and its output: stdout and stderr together)."""
  try:
    out = subprocess.run(command, shell=True, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         encoding='utf-8', errors='replace', timeout=timeout)
  except subprocess.TimeoutExpired as e:
    output = e.output.decode('utf-8', 'replace') if isinstance(e.output, bytes) else (e.output or '')
    return None, output
  return out.returncode, out.stdout or ''


def config_module():
  """The qaboard.config module: in qaboard/__init__.py, `qaboard.config` is the configuration's dict."""
  import importlib
  return importlib.import_module('qaboard.config')


def tail(text: str, lines: int = 5) -> str:
  """The last lines of a command's output, to quote it in a message."""
  return '\n'.join(line.rstrip() for line in (text or '').strip().splitlines()[-lines:])


def mask_token(token: str, prefix: Optional[str] = None) -> str:
  """What we show of a token: the prefix the server shows too, or its first characters."""
  if prefix:
    return f"{prefix}..."
  shown = 12 if token.startswith('qab_') else 4
  return f"{token[:shown]}..." if len(token) > 2 * shown else "****"


def mask_url_password(url: str) -> str:
  """
  Hides the secrets in URLs: pyamqp://user:secret@host/vhost => pyamqp://user:****@host/vhost, ?password=secret...
  Also in each URL of a list, like kombu's failover brokers "url1;url2".
  """
  url = re.sub(r'(://[^/@:;\s]*:)[^@/;\s]*@', r'\1****@', str(url))
  return re.sub(r'((?:password|passwd|pwd|token|secret|api_key|apikey)=)[^&;\s]*', r'\1****', url, flags=re.IGNORECASE)


def plural(n: int, word: str, words: Optional[str] = None) -> str:
  return f"{n} {word if n == 1 else (words or word + 's')}"


def human_size(size: float) -> str:
  for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
    if size < 1024 or unit == 'TB':
      return f"{size:.0f} {unit}" if unit in ('B', 'KB') else f"{size:.1f} {unit}"
    size /= 1024
  return f"{size:.1f} PB"


###############################################################################
# qa and qaboard.yaml
###############################################################################

def latest_version() -> Optional[str]:
  """The latest qaboard version, from the cache `qa` keeps (see check_for_updates.py), else asked quickly."""
  from .site_config import user_config_dir
  try:
    with (user_config_dir() / 'latest-version').open() as f:
      return json.load(f)['version']
  except Exception:
    pass
  if 'QA_NO_CHECK_FOR_UPDATES' in os.environ:
    return None
  from .check_for_updates import latest_qaboard_version
  return latest_qaboard_version(quiet=True)


def check_version(current: str, latest: Optional[str], python: Tuple[int, ...] = tuple(sys.version_info[:3])) -> Check:
  """`qa` is up to date, and Python is recent enough."""
  from .check_for_updates import version_key, upgrade_command
  python_str = '.'.join(str(n) for n in python)
  name = "qa version"
  if python[:2] < (3, 9):
    return Check(name, WARNING, f"qa {current} on Python {python_str}: `qa optimize` and the dask runner need Python 3.9 or later.",
                 fix=f"Use Python 3.9 or later, e.g. in a new virtual environment:\n  python3 -m venv .venv && . .venv/bin/activate && pip install qaboard\nDocs: {docs('installation')}")
  if current == 'unknown':
    return Check(name, OK, f"qa from a source checkout (its version is unknown), on Python {python_str}")
  current_key, latest_key = version_key(current), version_key(latest) if latest else None
  if current_key is not None and latest_key is not None and current_key < latest_key:
    return Check(name, WARNING, f"qa {current} is not the latest version ({latest}).", fix=f"{upgrade_command()}")
  checked = "" if latest else " (could not check for a newer version)"
  return Check(name, OK, f"qa {current}{checked}, on Python {python_str}")


def yaml_problem(e: Exception) -> str:
  """A YAML error in one line, with where it is."""
  mark = getattr(e, 'problem_mark', None)
  problem = getattr(e, 'problem', None) or str(e)
  where = f" (line {mark.line + 1}, column {mark.column + 1})" if mark is not None else ''
  return f"{problem}{where}"


PROJECT_SNIPPET = """project:
  name: group/repo      # your project in QA-Board, usually your git repository's path
  url: https://github.com/group/repo
  entrypoint: qa/main.py"""


def find_config_files(start: Path) -> Tuple[List[Tuple[Dict[str, Any], Path]], Optional[Check]]:
  """
  The qaboard.yaml files of the project at `start`, root first, like config.find_configs,
  and an ERROR Check if one can't be read or is not valid YAML.
  """
  found: List[Tuple[Dict[str, Any], Path]] = []
  start = Path(os.path.abspath(start))
  for parent in [start, *start.parents]:
    path = next((parent / n for n in CONFIG_NAMES if (parent / n).is_file()), None)
    if path is None:
      continue
    try:
      with path.open(encoding='utf-8') as f:
        content = yaml.safe_load(f)
    except yaml.YAMLError as e:
      return found, Check("qaboard.yaml", ERROR, f"{path} is not valid YAML: {yaml_problem(e)}.",
                          fix=f"Fix the YAML syntax at that line: check the indentation (spaces, not tabs), and quote values with `:` or `#`.\nDocs: {docs('project-init')}")
    except (OSError, UnicodeDecodeError) as e:
      return found, Check("qaboard.yaml", ERROR, f"Can't read {path}: {e}.", fix=f"ls -l {path}")
    if content is None: # empty files mark subprojects
      content = {}
    if not isinstance(content, dict):
      return found, Check("qaboard.yaml", ERROR, f"{path} must be a mapping of settings (key: value), not a {type(content).__name__}.",
                          fix=f"For instance:\n{PROJECT_SNIPPET}\nDocs: {docs('project-init')}")
    found.append((content, path))
    if content.get('root'):
      break
  found.reverse()
  return found, None


def schema_errors(content: Dict[str, Any]) -> Optional[List[str]]:
  """The errors of a qaboard.yaml against its JSON schema, as "path: message". None if jsonschema isn't installed."""
  try:
    from jsonschema import Draft202012Validator  # type: ignore
  except ImportError:
    return None
  schemas_dir = Path(__file__).parent / 'schemas'
  schema = json.loads((schemas_dir / 'qaboard.schema.json').read_text())
  kwargs: Dict[str, Any] = {}
  try:
    from referencing import Registry, Resource
    schemas = [json.loads(p.read_text()) for p in schemas_dir.glob('*.schema.json')]
    kwargs['registry'] = Registry().with_resources((s['$id'], Resource.from_contents(s)) for s in schemas)
  except ImportError:
    pass
  validator = Draft202012Validator(schema, **kwargs)
  errors = sorted(validator.iter_errors(content), key=lambda e: list(str(p) for p in e.absolute_path))
  return [f"{'.'.join(str(p) for p in e.absolute_path) or '(top)'}: {e.message}" for e in errors]


def check_config(start: Path, load_error: Optional[str] = None) -> Iterator[Check]:
  """
  qaboard.yaml is found from `start`, is valid YAML, has what `qa` needs, and matches its JSON schema
  (when jsonschema is installed). `load_error` is why qaboard.config could not load it, if it failed.
  """
  name = "qaboard.yaml"
  found, error = find_config_files(start)
  if error:
    yield error
    return
  if not found:
    yield Check(name, ERROR, f"No qaboard.yaml in {Path(os.path.abspath(start))} or its parent folders.",
                fix=f"Run qa in your project's folder: cd path/to/your/project\nTo add QA-Board to a project, run in its folder:\n  qa init\nDocs: {docs('project-init')}")
    return
  root_config, root_path = found[0]
  problems = []
  project = root_config.get('project')
  missing = [k for k in ('name', 'url') if not (isinstance(project, dict) and isinstance(project.get(k), str) and project.get(k))]
  if missing:
    problems.append(Check(name, ERROR, f"{root_path} needs project.{' and project.'.join(missing)}, as text.",
                          fix=f"In {root_path}:\n{PROJECT_SNIPPET}\nDocs: {docs('project-init')}"))
  for content, path in found:
    include = content.get('include')
    if include and not (root_path.parent / str(include)).exists():
      problems.append(Check(name, ERROR, f"{path} includes {include}, which doesn't exist (paths are relative to {root_path.parent}).",
                            fix=f"Fix `include:` in {path}, or create {root_path.parent / str(include)}"))
  # settings qa can't use: other commands fail on them
  from .config import invalid_settings
  wrong_types = []
  for content, path in found:
    entrypoint = (content.get('project') or {}).get('entrypoint') if isinstance(content.get('project'), dict) else None
    invalid = invalid_settings(content) + ([(('project', 'entrypoint'), entrypoint, (str,))] if entrypoint is not None and not isinstance(entrypoint, str) else [])
    for keys, value, types in invalid:
      kinds = ' or '.join({'str': 'a path or text', 'list': 'a list of paths', 'dict': 'a mapping (key: value)'}[t.__name__] for t in types)
      wrong_types.append(f"{path if len(found) > 1 else path.name}: {'.'.join(keys)} must be {kinds}, not {str(value)[:40]!r}")
  if wrong_types:
    problems.append(Check(name, ERROR, "qa can't use these settings:\n" + '\n'.join(f"  {e}" for e in wrong_types),
                          fix=f"Fix them in qaboard.yaml: see the examples in the docs: {docs('project-init')}\n"
                              f"Editors check qaboard.yaml as you type with this first line:\n  # yaml-language-server: $schema={SCHEMA_URL}"))
  if problems:
    yield from problems
    return
  if load_error:
    yield Check(name, ERROR, f"qa can't load the project's configuration: {load_error}", fix=f"Fix {root_path}\nDocs: {docs('project-init')}")
    return

  where = str(root_path) if len(found) == 1 else f"{root_path}, and {found[-1][1]} for this subproject"
  all_errors: List[str] = []
  checked = True
  for content, path in found:
    errors = schema_errors(content)
    if errors is None:
      checked = False
      break
    all_errors.extend(e if len(found) == 1 else f"{path}: {e}" for e in errors)
  if all_errors:
    shown = '\n'.join(f"  {e}" for e in all_errors[:5]) + (f"\n  ...and {len(all_errors) - 5} more" if len(all_errors) > 5 else '')
    yield Check(name, WARNING, f"{where} has settings qa doesn't know, or of the wrong type:\n{shown}",
                fix=f"Fix them: qa ignores unknown settings, e.g. with a typo.\nEditors check qaboard.yaml as you type with this first line:\n  # yaml-language-server: $schema={SCHEMA_URL}")
    return
  yield Check(name, OK, where + ('' if checked else " (not checked against the schema: pip install jsonschema)"))


def check_project(project: Optional[Path], project_root: Optional[Path], subproject: Path, config: Dict[str, Any], root: Path) -> Iterator[Check]:
  """The project's name, its entrypoint (the code `qa run` runs), and its batches files."""
  if not project:
    return
  sub = f" (subproject {subproject.as_posix()} of {Path(project_root).as_posix()})" if project_root and str(subproject) not in ('', '.') else ''
  yield Check("Project", OK, f"{Path(project).as_posix()}{sub}")

  entrypoint = (config.get('project') or {}).get('entrypoint')
  name = "Entrypoint"
  if entrypoint is not None and not isinstance(entrypoint, str):
    # check_config says so
    return
  if not entrypoint:
    yield Check(name, ERROR, "project.entrypoint isn't set: `qa run` doesn't know what code to run.",
                fix=f"In qaboard.yaml, the Python file with your run(context) function:\nproject:\n  entrypoint: qa/main.py\nDocs: {docs('running-your-code')}")
  else:
    path = root / entrypoint
    if not path.is_file():
      yield Check(name, ERROR, f"{entrypoint} doesn't exist (project.entrypoint, relative to {root}).",
                  fix=f"Fix project.entrypoint in qaboard.yaml, or create it: qa init writes an example.\nDocs: {docs('running-your-code')}")
    else:
      try:
        compile(path.read_text(encoding='utf-8', errors='replace'), str(path), 'exec')
        yield Check(name, OK, f"{entrypoint}")
      except SyntaxError as e:
        yield Check(name, ERROR, f"{entrypoint} has a syntax error, line {e.lineno}: {e.msg}", fix=f"python -m py_compile {path}")
      except (OSError, ValueError) as e:
        yield Check(name, ERROR, f"qa can't read {entrypoint}: {e}", fix=f"ls -l {path}   # ask its owner for read access")


def check_batches_files(batches_files: List[Any], root: Path) -> Check:
  """The files that define the batches `qa batch` runs: listed, existing, valid YAML."""
  name = "Batches"
  snippet = "inputs:\n  batches: qa/batches.yaml"
  if not batches_files:
    return Check(name, WARNING, "No batches files: `qa batch` needs them to know what to run.",
                 fix=f"In qaboard.yaml:\n{snippet}\nand list your batches there.\nDocs: {docs('batches-running-on-multiple-inputs')}")
  names: List[str] = []
  for batches_file in batches_files:
    path = root / batches_file
    if not path.is_file():
      return Check(name, ERROR, f"{batches_file} doesn't exist (inputs.batches in qaboard.yaml, relative to {root}).",
                   fix=f"Create it, or fix inputs.batches in qaboard.yaml.\nDocs: {docs('batches-running-on-multiple-inputs')}")
    try:
      with path.open(encoding='utf-8') as f:
        batches = yaml.safe_load(f) or {}
    except yaml.YAMLError as e:
      return Check(name, ERROR, f"{batches_file} is not valid YAML: {yaml_problem(e)}.", fix="Fix the YAML syntax at that line.")
    except (OSError, UnicodeDecodeError) as e:
      return Check(name, ERROR, f"Can't read {batches_file}: {e}.", fix=f"ls -l {path}")
    if isinstance(batches, dict):
      names.extend(str(k) for k in batches if not str(k).startswith('.'))
  files = ', '.join(str(b) for b in batches_files)
  shown = ', '.join(names[:5]) + (', ...' if len(names) > 5 else '')
  return Check(name, OK, f"{files}: {plural(len(names), 'batch', 'batches')}" + (f" ({shown})" if names else ''))


def check_git(is_in_git_repo: bool, commit_id: Optional[str], commit_branch: Optional[str], is_ci: bool, placeholder: str) -> Check:
  """Results are saved per commit: qa needs to know which one."""
  name = "Git commit"
  if not commit_id or commit_id == placeholder:
    if is_ci:
      return Check(name, WARNING, f"qa can't tell the CI's commit: results are saved as \"{placeholder}\".",
                   fix="Run qa in the git clone of the commit, or set CI_COMMIT_SHA (or GIT_COMMIT) to the commit's hash.")
    if not is_in_git_repo:
      return Check(name, WARNING, f"Not in a git repository: QA-Board can't tell which commit results come from (they're all \"{placeholder}\"), "
                                  "and `qa --share` saves them in your project's folder, not in the storage.",
                   fix=f"Use git for your project, then commit:\n  git init && git add -A && git commit -m \"First commit\"\nDocs: {docs('project-init')}")
    return Check(name, WARNING, f"The git repository has no commit yet: QA-Board can't tell which commit results come from (they're all \"{placeholder}\").",
                 fix="git add -A && git commit -m \"First commit\"")
  where = " (from the CI)" if is_ci else ''
  return Check(name, OK, f"{commit_id[:10]} on {commit_branch}{where}")


###############################################################################
# QA-Board server
###############################################################################

def describe_error(e: Exception) -> str:
  from .credentials import describe_network_error
  return describe_network_error(e)


def json_of(r) -> Any:
  try:
    return r.json()
  except Exception:
    return None


def server_fix(server, reason: str) -> str:
  """What to do when we can't reach the server."""
  if 'TLS certificate' in reason:
    return ("The server's certificate is signed by an authority this machine doesn't trust. Give qa your company's CA bundle:\n"
            "  export QABOARD_API_VERIFY=/path/to/ca-bundle.pem\n"
            f"or skip the checks: export QABOARD_API_VERIFY=false\nDocs: {docs('installation#connecting-to-a-custom-qa-board-server')}")
  if not server.where:
    return ("Tell qa where your QA-Board server is, e.g. in your shell's profile:\n"
            "  export QABOARD_URL=https://<your-qaboard>\n"
            "Your QA-Board admins know its address, or your organization's site package sets it.\n"
            f"No server yet? Start one on your computer: {docs('get-started/quickstart')}, or for your team: {docs('deploy')}")
  return (f"Check {server.setting()} ({server.url}), and that you can reach the server from here:\n"
          f"  curl {server.api_prefix}/health\n"
          f"If it's down, tell your QA-Board admins.\nDocs: {docs('installation#connecting-to-a-custom-qa-board-server')}")


def check_server(server, verify: Any = True, timeout=TIMEOUT) -> Tuple[Check, Optional[Dict[str, Any]]]:
  """
  The server answers like QA-Board, and its database works. Returns the Check and the server's settings
  (/api/v1/config: how it authenticates results...), or None if it can't be reached.
  `server` is an auth.Server: its URL, API prefix, and the setting that gives it.
  """
  import requests
  from .credentials import describe_body
  name = "QA-Board server"
  where = server.described()
  try:
    r = requests.get(f"{server.api_prefix}/health", verify=verify, timeout=timeout)
  except requests.RequestException as e:
    reason = describe_error(e)
    return Check(name, ERROR, f"Can't reach QA-Board at {where}: {reason}.", fix=server_fix(server, reason)), None
  health = json_of(r)
  if r.status_code == 503 and isinstance(health, dict) and health.get('database'):
    return Check(name, ERROR, f"QA-Board at {server.url} answers, but can't use its database: {str(health['database'])[:200]}",
                 fix=f"Tell your QA-Board admins.\nDocs for them: {docs('backend-admin/troubleshooting')}"), None
  if r.status_code >= 500:
    return Check(name, ERROR, f"QA-Board at {server.url} answered {r.status_code}: it may be down or restarting.",
                 fix="Try again in a minute. If it lasts, tell your QA-Board admins."), None
  try:
    c = requests.get(f"{server.api_prefix}/config", verify=verify, timeout=timeout)
    site = json_of(c) if c.ok else None
  except requests.RequestException:
    site = None
  healthy = isinstance(health, dict) and health.get('status') == 'ok'
  # older servers don't have /health
  if not healthy and not isinstance(site, dict):
    return Check(name, ERROR, f"{server.api_prefix}/health answered {r.status_code} ({describe_body(r) or 'an empty body'}): that's not QA-Board's API.",
                 fix=f"{server.is_url_right()} It's the address of the web app, e.g. https://qaboard.example.com\n{server_fix(server, '')}"), None
  site = site if isinstance(site, dict) else {}
  if not server.where:
    return Check(name, WARNING, f"QABOARD_URL isn't set: qa uses {server.url}, which answers.",
                 fix=f"If it's your server, say so to remove the doubt, e.g. in your shell's profile:\n  export QABOARD_URL={server.url}"), site
  return Check(name, OK, f"{where}"), site


def token_matches_project(patterns: List[str], project: Optional[str]) -> bool:
  """Like the server's tokens.matches_project: whether a token restricted to `patterns` can access a project."""
  if not patterns:
    return True
  if not project:
    return False
  for pattern in patterns:
    pattern = pattern.strip().rstrip('/')
    if not pattern:
      continue
    if project == pattern or project.startswith(pattern + '/'):
      return True
    if any(c in pattern for c in '*?[') and (fnmatch.fnmatchcase(project, pattern) or fnmatch.fnmatchcase(project, pattern + '/*')):
      return True
  return False


def auth_fix(refused: Dict[str, Any], token_source: Optional[str], ci: bool, project: Optional[str], server: str) -> Optional[str]:
  """credentials.fix_for, with the link to the web app's page where people create tokens."""
  from .credentials import fix_for, ACCESS_TOKENS_PAGE
  fix = fix_for(refused, token_source, ci=ci, project=project, server=server)
  return fix.replace(ACCESS_TOKENS_PAGE, f"{ACCESS_TOKENS_PAGE}: {server.rstrip('/')}/settings/tokens") if fix else fix


def sign_in_fix(server, ci: bool) -> str:
  if ci:
    return (f"Create a token with the Ingest scope in QA-Board: {server.url}/settings/tokens (Settings → Access tokens),\n"
            f"and set it as QABOARD_TOKEN in your CI's secrets.\nDocs: {docs('ci-integration#tokens')}")
  return (f"  {server.login_command()}\n"
          "It works over SSH too: open the link it prints in any browser.\n"
          f"Docs: {docs('installation#signing-in')}")


def check_sign_in(server, token: Optional[str], token_source: Optional[str], site: Dict[str, Any], project: Optional[str],
                  ci: bool, verify: Any = True, timeout=TIMEOUT, now=None) -> Tuple[List[Check], bool]:
  """
  Whether QA-Board accepts the results qa sends: signed in (with a valid token that can send results to the project),
  or the server accepts them without a token. Returns the Checks, and whether the token was accepted.
  `site` are the server's settings (/api/v1/config): ingest_auth is "off", "warn" or "token".
  """
  import requests
  import datetime
  from .credentials import refusal, describe_source, describe_body
  from .auth import parse_time, format_time
  name = "Signed in"
  ingest_auth = site.get('ingest_auth')
  # how bad it is when QA-Board won't verify the results qa sends
  severity = ERROR if (ingest_auth == 'token' or site.get('require_sign_in')) else WARNING
  if not token:
    if site.get('require_sign_in'):
      return [Check(name, ERROR, "Not signed in, and this QA-Board requires it.", fix=sign_in_fix(server, ci))], False
    if ingest_auth == 'token':
      return [Check(name, ERROR, "Not signed in, and this QA-Board only accepts results sent with a token.", fix=sign_in_fix(server, ci))], False
    if ingest_auth == 'warn':
      return [Check(name, WARNING, "Not signed in: QA-Board saves your results as unverified, and will soon require a token.", fix=sign_in_fix(server, ci))], False
    return [Check(name, OK, f"Not signed in: this QA-Board accepts results without it, as unverified. To sign them as yours: {server.login_command()}")], False

  source = describe_source(token_source)
  try:
    r = requests.get(f"{server.api_prefix}/user/me/", headers={'Accept': 'application/json', 'Authorization': f"Bearer {token}"}, verify=verify, timeout=timeout)
  except requests.RequestException as e:
    return [Check(name, SKIPPED, f"Couldn't check your token: {describe_error(e)}.")], False
  refused = refusal(r)
  if refused:
    fix = auth_fix(refused, token_source, ci=ci, project=project, server=server.url)
    return [Check(name, ERROR, f"QA-Board refused your token (from {source}): {refused['error']}", fix=fix)], False
  me = json_of(r)
  if not r.ok or not isinstance(me, dict) or 'is_authenticated' not in me:
    return [Check(name, WARNING, f"Couldn't check your token: {server.api_prefix}/user/me/ answered {r.status_code} ({describe_body(r) or 'an empty body'}).",
                  fix="The server may be an older version. `qa auth status` says more.")], False
  if not me.get('is_authenticated') or not me.get('user_name'):
    fix = auth_fix({'reason': 'token_invalid'}, token_source, ci=ci, project=project, server=server.url)
    return [Check(name, ERROR, f"QA-Board did not accept your token ({mask_token(token)}, from {source}).", fix=fix)], False

  token_info: Dict[str, Any] = me['token'] if isinstance(me.get('token'), dict) else {}
  shown = mask_token(token, token_info.get('prefix'))
  checks = [Check(name, OK, f"as {me['user_name']} (token {shown} from {source})")]
  scopes = token_info.get('scopes')
  if isinstance(scopes, list) and 'ingest' not in scopes:
    fix = auth_fix({'reason': 'missing_scope', 'required': 'ingest'}, token_source, ci=ci, project=project, server=server.url)
    checks.append(Check("Token scopes", severity, f"Your token can't send results: it doesn't have the Ingest scope (it has: {', '.join(scopes) or 'none'}).", fix=fix))
  projects = token_info.get('projects')
  if isinstance(projects, list) and projects and project and not token_matches_project(projects, project):
    fix = auth_fix({'reason': 'token_project'}, token_source, ci=ci, project=project, server=server.url)
    checks.append(Check("Token projects", severity, f"Your token is only for {', '.join(projects)}, not {project}.", fix=fix))
  expires_at = parse_time(token_info.get('expires_at'))
  now = now or datetime.datetime.now(datetime.timezone.utc)
  if expires_at and expires_at - now < datetime.timedelta(days=7):
    expired = expires_at <= now
    fix = auth_fix({'reason': 'token_expired'}, token_source, ci=ci, project=project, server=server.url)
    checks.append(Check("Token expiry", ERROR if expired else WARNING, f"Your token {'expired' if expired else 'expires'} on {format_time(token_info['expires_at'])}.", fix=fix))
  return checks, True


def check_project_access(server, token: str, token_source: Optional[str], project: str, site: Dict[str, Any], ci: bool,
                         verify: Any = True, timeout=TIMEOUT) -> Check:
  """Signed-in users need the developer role to send results to a project (or QA-Board saves them as unverified)."""
  import requests
  from .credentials import refusal
  name = "Project access"
  severity = ERROR if site.get('ingest_auth') == 'token' else WARNING
  consequence = "QA-Board refuses the results you send" if severity == ERROR else "QA-Board saves the results you send as unverified"
  try:
    r = requests.get(f"{server.api_prefix}/project/access", params={'project': project},
                     headers={'Accept': 'application/json', 'Authorization': f"Bearer {token}"}, verify=verify, timeout=timeout)
  except requests.RequestException as e:
    return Check(name, SKIPPED, f"Couldn't check your role in {project}: {describe_error(e)}.")
  refused = refusal(r)
  if refused:
    refused = {**refused, 'required': refused.get('required') or 'developer', 'project': refused.get('project') or project}
    return Check(name, severity, f"{refused['error']} {consequence}.", fix=auth_fix(refused, token_source, ci=ci, project=project, server=server.url))
  body = json_of(r)
  if not r.ok or not isinstance(body, dict) or 'my_role' not in body:
    return Check(name, SKIPPED, f"This QA-Board doesn't say who can access projects (it answered {r.status_code}): it may be an older version.")
  role = body.get('my_role')
  if role in ('developer', 'owner'):
    return Check(name, OK, f"You're {'an' if role == 'owner' else 'a'} {role} of {project}")
  owners = [o.get('name') for o in body.get('owners') or [] if isinstance(o, dict) and o.get('name')]
  refused = {'reason': 'missing_role', 'required': 'developer', 'project': project, 'owners': owners}
  you_are = f"You're a {role} of {project}" if role else f"You don't have a role in {project}"
  return Check(name, severity, f"{you_are}: sending results needs the developer role, else {consequence}.",
               fix=auth_fix(refused, token_source, ci=ci, project=project, server=server.url))


def check_server_sees(server, path: Path, token: Optional[str], verify: Any = True, timeout=TIMEOUT) -> Check:
  """
  The server reads the storage at the same path as here: else the web app can't show the results.
  We ask for the folder's listing (/s/<path>), like the web app's file browser.
  """
  import requests
  from .api import serialize_path
  from .credentials import refusal, describe_body
  name = "Server sees the storage"
  posix = serialize_path(path)
  url = f"{server.url}/s{quote(posix)}/"
  headers = {'Accept': 'application/json', **({'Authorization': f"Bearer {token}"} if token else {})}
  try:
    r = requests.get(url, headers=headers, verify=verify, timeout=timeout)
  except requests.RequestException as e:
    return Check(name, SKIPPED, f"Couldn't ask QA-Board: {describe_error(e)}.")
  body = json_of(r)
  reason = body.get('reason') if isinstance(body, dict) else None
  if r.ok and body is not None:
    return Check(name, OK, f"QA-Board reads {posix}")
  if reason == 'not-listable':
    return Check(name, WARNING, f"QA-Board doesn't read the files in {posix}: it's not in its storage folders.",
                 fix=("Save the results where QA-Board reads them: set `storage` in qaboard.yaml (or QA_STORAGE),\n"
                      f"or ask your QA-Board admins to mount {posix} on the server, at the same path, and add it to QABOARD_STORAGE_ROOTS.\n"
                      f"Docs: {docs('storage/where-is-the-data')}"))
  if reason == 'not-found':
    return Check(name, WARNING, f"QA-Board doesn't see {posix}: the storage isn't mounted on the server at this path.",
                 fix=(f"Ask your QA-Board admins to mount it on the server at {posix}, the same path as here.\n"
                      f"Docs for them: {docs('deploy#2-create-the-results-storage')}"))
  if reason == 'permissions':
    return Check(name, WARNING, f"QA-Board can't read {posix}: the server's account doesn't have the permissions.",
                 fix=(f"Ask your QA-Board admins to give the server read access to {posix}\n"
                      "(e.g. add its account to the folder's group, with chmod -R g+rX), or save the results in a folder it reads.\n"
                      f"Docs for them: {docs('backend-admin/storage')}"))
  if reason == 'forbidden':
    return Check(name, WARNING, f"QA-Board doesn't let your account read {posix}: {body.get('error')}",
                 fix="Ask the project's owners, or your QA-Board admins, for access to these files.")
  if reason in ('login', 'sign_in_required') or (refusal(r) and not token):
    if token:
      return Check(name, SKIPPED, f"QA-Board didn't accept your token to read {posix}: see \"Signed in\" above.")
    return Check(name, SKIPPED, "Sign in to check if QA-Board reads your storage: qa auth login")
  return Check(name, SKIPPED, f"Couldn't tell if QA-Board reads {posix}: {url} answered {r.status_code} ({describe_body(r) or 'an empty body'}).")


###############################################################################
# Storage and inputs
###############################################################################

def closest_existing(path: Path) -> Optional[Path]:
  """The path, or its closest parent that exists."""
  for candidate in [path, *path.parents]:
    if candidate.exists():
      return candidate
  return None


def make_test_dir(job_options: Dict[str, Any]) -> Tuple[Path, Optional[Path]]:
  """
  Creates a folder for a test job's files, in the batch's folder like the runs' (<batch_dir>/doctor/<id>).
  Returns it, and its closest parent that existed before, for remove_test_dir. Raises OSError if it can't.
  """
  command_id = job_options.get('command_id') or 'qadoctor'
  path = Path(job_options.get('batch_dir') or '.').resolve() / 'doctor' / command_id[:8]
  existing = closest_existing(path)
  path.mkdir(parents=True, exist_ok=True)
  return path, existing


def remove_test_dir(path: Path, existing: Optional[Path]):
  """Removes a test job's folder, and the parents make_test_dir created, if they're empty."""
  shutil.rmtree(path, ignore_errors=True)
  parent = path.parent
  while existing is not None and existing in parent.parents:
    try:
      parent.rmdir()
    except OSError:
      break
    parent = parent.parent


def write_error(folder: Path) -> Optional[OSError]:
  """Whether we can create files in a folder: we create a temporary file there, and delete it. None if we can."""
  try:
    fd, tmp = tempfile.mkstemp(prefix='.qa-doctor-', dir=str(folder))
  except OSError as e:
    return e
  os.close(fd)
  try:
    os.unlink(tmp)
  except OSError:
    pass
  return None


def describe_os_error(e: OSError) -> str:
  reasons = {
    errno.EACCES: "permission denied", errno.EPERM: "permission denied", errno.EROFS: "read-only file system",
    errno.ENOSPC: "no space left on the disk", errno.EDQUOT: "disk quota exceeded",
  }
  return reasons.get(e.errno or 0, e.strerror or str(e))


def storage_help() -> str:
  from .site_config import site_config
  help_text = site_config('QABOARD_STORAGE_HELP')
  return f"\n{help_text}" if help_text else ''


def check_folder(name: str, path: Path, required: bool = True, root: Optional[Path] = None, purpose: str = '') -> Check:
  """
  qa can write in `path`, or create it: we write a temporary file in its closest existing parent.
  `root` is the storage folder it's in: when it's missing, the fix is about the storage, not the permissions.
  `required`: an ERROR if it fails, else a WARNING. `purpose` says what needs it, e.g. "`qa save-artifacts` saves builds there".
  """
  severity = ERROR if required else WARNING
  why = f" {purpose}." if purpose else ''
  existing = closest_existing(path)
  root_missing = root is not None and not root.exists()
  storage_fix = ("The storage is where shared results go (`qa --share`, CI): a folder your QA-Board server reads too, often a shared drive.\n"
                 f"Mount it at {root}, or create it:\n  mkdir -p {root}\n"
                 "Or use another folder that your QA-Board server reads:\n  export QA_STORAGE=/path/to/storage   # or `storage:` in qaboard.yaml"
                 f"{storage_help()}\nDocs: {docs('storage/where-is-the-data')}")
  if existing is None or not existing.is_dir():
    return Check(name, severity, f"Can't create {path}: {existing} is not a folder.{why}", fix=f"ls -ld {existing}")
  error = write_error(existing)
  if error and root_missing:
    return Check(name, severity, f"The storage folder {root} doesn't exist, and qa can't create it ({describe_os_error(error)} in {existing}).{why}", fix=storage_fix)
  if root_missing:
    return Check(name, WARNING, f"The storage folder {root} doesn't exist: qa will create it, in {existing}. If it's a shared drive, it isn't mounted here.{why}",
                 fix=storage_fix)
  if error:
    reason = describe_os_error(error)
    if error.errno in (errno.ENOSPC, errno.EDQUOT):
      fix = f"Free some space: du -sh {existing}/* | sort -h\nOr ask your storage admins for more.{storage_help()}"
    else:
      fix = (f"  ls -ld {existing}   # who owns it\n"
             "Ask its owner or your admins for write access (e.g. add you to its group, with chmod g+w),\n"
             f"or use another storage folder: export QA_STORAGE=/path/to/storage{storage_help()}")
    return Check(name, severity, f"qa can't write in {existing}: {reason}.{why}", fix=fix)
  where = f"{path}" if existing == path else f"{path} (qa will create it, in {existing})"
  try:
    free = shutil.disk_usage(str(existing)).free
  except OSError:
    return Check(name, OK, f"{where}, writable")
  if free < LOW_DISK_SPACE:
    return Check(name, WARNING, f"{where}: only {human_size(free)} free.", fix=f"Free some space, or ask your storage admins for more.{storage_help()}")
  return Check(name, OK, f"{where}, writable, {human_size(free)} free")


def check_storage_setting(config: Dict[str, Any], project: Path, subproject: Path) -> Optional[Check]:
  """An ERROR if qaboard.yaml (or QA_STORAGE) doesn't say where to save shared results, None if it does."""
  qaboard_config = config_module()
  fix = (f"In qaboard.yaml, a folder that your QA-Board server reads too:\nstorage:\n  linux: /mnt/qaboard\n  windows: \\\\server\\share\\qaboard\n"
         f"Or: export QA_STORAGE=/path/to/storage\nIf your organization has a site package, install it: it sets the storage.{storage_help()}\n"
         f"Docs: {docs('storage/where-is-the-data')}")
  if not os.environ.get('QA_STORAGE') and not config.get('storage') and not config.get('ci_root'):
    return Check("Results storage", ERROR, "qaboard.yaml doesn't say where to save shared results (`storage`), and QA_STORAGE isn't set.", fix=fix)
  # storage_roots prints errors, unless they're ignored
  previous, qaboard_config.ignore_config_errors = qaboard_config.ignore_config_errors, True
  try:
    outputs_root, artifacts_root, _ = qaboard_config.storage_roots(dict(config), project, subproject, raise_errors=True)
    if str(outputs_root) not in ('', '.') and str(artifacts_root) not in ('', '.'):
      return None
    problem = "The storage setting doesn't give a folder for the outputs and the artifacts."
  except (ValueError, TypeError) as e:
    flavor = 'windows' if os.name == 'nt' else 'linux'
    problem = f"The storage setting has no path for this machine ({flavor}): {e}" if isinstance(e, ValueError) else f"The storage setting is wrong: {e}"
  finally:
    qaboard_config.ignore_config_errors = previous
  return Check("Results storage", ERROR, problem, fix=fix)


def check_database(database: Path, input_type: str = 'default', configured: bool = True) -> Check:
  """The inputs database (the folder input paths are relative to) exists and is readable."""
  name = "Inputs database" if input_type == 'default' else f"Inputs database ({input_type})"
  snippet = "inputs:\n  database:\n    linux: /mnt/datasets\n    windows: \\\\server\\datasets"
  if not configured:
    return Check(name, WARNING, f"inputs.database isn't set: input paths are relative to {Path(os.path.abspath(database))}.",
                 fix=f"If your inputs are elsewhere, in qaboard.yaml:\n{snippet}\nDocs: {docs('inputs')}")
  if not database.exists():
    return Check(name, ERROR, f"{database} doesn't exist, or isn't mounted here.",
                 fix=f"Mount it, or fix inputs.database in qaboard.yaml:\n{snippet}\nFor one command: qa --database /path/to/inputs batch <batch>\nDocs: {docs('inputs')}")
  if not database.is_dir():
    return Check(name, ERROR, f"{database} is not a folder.", fix=f"Fix inputs.database in qaboard.yaml.\nDocs: {docs('inputs')}")
  if not os.access(str(database), os.R_OK | os.X_OK):
    return Check(name, ERROR, f"qa can't read {database}: permission denied.", fix=f"ls -ld {database}   # ask its owner or your admins for read access")
  return Check(name, OK, f"{database}")


###############################################################################
# Runners
###############################################################################

def runner_settings_key(runner: str) -> str:
  """The runner `windows` has its settings under runners.jenkins."""
  return 'jenkins' if runner == 'windows' else runner


def runner_job_options(runner: str, config: Dict[str, Any], project: Optional[Path], user: str, batch_dir: Path, cwd: Path,
                       command_id: Optional[str] = None, environ=os.environ) -> Dict[str, Any]:
  """
  The job options `qa batch` gives a runner, from qaboard.yaml and the environment (not the command line's options),
  for the runners' doctor(). A simpler version of what `batch` does in qa.py.
  """
  runners_config = config.get('runners') or {}
  lsf_config = config['lsf'] if 'lsf' in config else (runners_config.get('lsf') or {})
  settings = runners_config.get(runner_settings_key(runner))
  default_project = str(project) if project else 'qaboard'
  options: Dict[str, Any] = {
    "type": runner,
    "command_id": command_id or str(uuid.uuid4()),
    **(settings if isinstance(settings, dict) else {}),
    "user": user,
    "batch_dir": str(batch_dir),
    "cwd": str(cwd),
  }
  if runner == 'lsf':
    options.update(lsf_config)
    options['max_memory'] = lsf_config.get('max_memory', lsf_config.get('memory', 0))
    options['project'] = lsf_config.get('project', default_project)
  elif runner == 'local':
    if environ.get('QA_BATCH_CONCURRENCY'):
      options['concurrency'] = environ['QA_BATCH_CONCURRENCY']
    if environ.get('QA_BATCH_TIMEOUT'):
      options['timeout'] = environ['QA_BATCH_TIMEOUT']
  elif runner == 'dask':
    options['lsf'] = {
      "project": lsf_config.get('project', default_project),
      **{k: v for k, v in lsf_config.items() if k in ('queue', 'project', 'resources', 'max_memory', 'options')},
    }
    if isinstance(options.get('cluster'), dict) and options['cluster'].get('type') == 'kubernetes':
      from .runners.dask_runner import kubernetes_defaults
      options['kubernetes'] = kubernetes_defaults(config)
  else:
    options.setdefault('project', default_project)
  return options


def unknown_runner_fix(runner: str, known: Iterable[str]) -> str:
  if runner == 'jenkins':
    return ("The Jenkins runner is named `windows`, while its settings are under runners.jenkins. In qaboard.yaml:\n"
            f"runners:\n  default: local   # or windows\n  jenkins:\n    build_url: ...\nDocs: {docs('jenkins-integration')}")
  return (f"Use one of them, e.g. qa doctor --runner local, or in qaboard.yaml:\nrunners:\n  default: local\n"
          f"Docs: {docs('using-the-qa-cli#batch-runners')}")


def check_runner(runner: str, job_options: Dict[str, Any], test_job: bool = False, registry: Optional[Dict[str, Any]] = None) -> Iterator[Check]:
  """The runner's own checks (BaseRunner.doctor). Its unexpected exceptions become ERROR checks."""
  if registry is None:
    from .runners import runners as registry
  assert registry is not None
  if runner not in registry:
    yield Check("Runner", ERROR, f"There is no runner named {runner!r}. Runners: {', '.join(sorted(registry))}.", fix=unknown_runner_fix(runner, registry))
    return
  Runner = registry[runner]
  name = f"{runner} runner"
  checks = 0
  try:
    for check in Runner.doctor(job_options, test_job=test_job):
      checks += 1
      yield check
  except Exception as e:
    yield Check(name, ERROR, f"Checking the {runner} runner failed unexpectedly: {type(e).__name__}: {e}",
                fix=f"Please report it, with the output of `qa doctor`: {ISSUES}")
    return
  if not checks:
    yield Check(name, SKIPPED, f"qa doctor doesn't know how to check the {runner} runner yet.")


###############################################################################
# Report
###############################################################################

def symbols() -> Dict[str, str]:
  """✔ ! ✘ -, or ASCII when the terminal can't show them (e.g. Windows' legacy consoles)."""
  fancy = {OK: '✔', WARNING: '!', ERROR: '✘', SKIPPED: '-'}
  encoding = getattr(sys.stdout, 'encoding', None) or 'ascii'
  try:
    ''.join(fancy.values()).encode(encoding)
    return fancy
  except (UnicodeEncodeError, LookupError):
    return {OK: 'ok', WARNING: '!!', ERROR: 'XX', SKIPPED: '--'}

COLORS = {OK: 'green', WARNING: 'yellow', ERROR: 'red', SKIPPED: None}


class Report():
  """Prints the checks as they come, and says at the end what's wrong."""
  def __init__(self, echo=click.echo):
    self.checks: List[Check] = []
    self.echo = echo
    self.symbols = symbols()

  def section(self, title: str):
    self.echo('')
    self.echo(click.style(title, bold=True))

  def add(self, checks: Iterable[Check]) -> List[Check]:
    added = []
    for check in checks:
      if check is None:
        continue
      added.append(check)
      self.checks.append(check)
      self.print_check(check)
    return added

  def print_check(self, check: Check):
    symbol = click.style(self.symbols.get(check.status, '?'), fg=COLORS.get(check.status), bold=True)
    title = click.style(check.name, fg=COLORS.get(check.status) if check.status != OK else None, bold=check.status in (ERROR, WARNING))
    message_lines = (check.message or '').splitlines() or ['']
    self.echo(f"  {symbol} {title}: {message_lines[0]}" if message_lines[0] else f"  {symbol} {title}")
    for line in message_lines[1:]:
      self.echo(f"      {line}")
    if check.fix and check.status in (ERROR, WARNING):
      for line in check.fix.splitlines():
        self.echo(f"      {line}")

  def summary(self, next_step: str = "qa --share batch <batch>") -> int:
    """Prints how it went, and the command to run next if nothing must be fixed. Returns the exit code: 1 if a check failed."""
    errors = [c for c in self.checks if c.status == ERROR]
    warnings = [c for c in self.checks if c.status == WARNING]
    self.echo('')
    if errors:
      self.echo(click.style(f"{self.symbols[ERROR]} {plural(len(errors), 'problem')} to fix", fg='red', bold=True)
                + (f", {plural(len(warnings), 'warning')}" if warnings else '') + f": see above how to fix {'it' if len(errors) == 1 else 'them'}, then run `qa doctor` again.")
      return 1
    if warnings:
      self.echo(click.style(f"{self.symbols[WARNING]} {plural(len(warnings), 'warning')}", fg='yellow', bold=True)
                + f", nothing blocking. You can run batches: {next_step}")
      return 0
    self.echo(click.style(f"{self.symbols[OK]} All good", fg='green', bold=True) + f". Run your batches: {next_step}")
    return 0


def guarded(name: str, checks: Callable[[], Iterable[Check]]) -> Iterator[Check]:
  """The checks, or an ERROR check if they fail unexpectedly: `qa doctor` goes on with the next ones."""
  try:
    yield from checks()
  except Exception as e:
    yield Check(name, ERROR, f"qa doctor failed to check this: {type(e).__name__}: {e}",
                fix=f"Fix what the other checks say first. If it lasts, please report it, with the output of `qa doctor`: {ISSUES}")


def run_doctor(obj: Dict[str, Any], runner: str, test_job: bool = False, echo=click.echo) -> int:
  """
  `qa doctor`: prints the checks, and returns the exit code. `obj` is the `qa` command's context (ctx.obj).
  Like `qa --share batch` (or a CI), it checks what's needed for results that show in QA-Board:
  with `qa --offline doctor`, only what local runs need.
  Each section is guarded: if a check fails unexpectedly, it's an ERROR, and the next sections still run.
  """
  qaboard_config = config_module()
  from . import __version__
  from .config import config, project, project_root, subproject, root_qatools, user, is_ci
  from .conventions import make_batch_dir

  offline = bool(obj.get('offline'))
  cwd = Path(obj.get('previous_cwd') or os.getcwd())
  report = Report(echo=echo)
  shared = "what you need for runs whose results show in QA-Board (like `qa --share batch`)" if not offline else "what you need for local runs (--offline)"
  echo(click.style("qa doctor", bold=True) + f": checking {shared}, with the {runner} runner.")
  root = Path(root_qatools) if root_qatools else cwd
  state: Dict[str, Any] = {
    'has_project': False, 'server': None, 'site': None, 'token': None,
    'batch_dir': Path(obj.get('batch_dir') or (root / 'output')),
  }

  def project_checks() -> Iterator[Check]:
    yield check_version(__version__, latest_version())
    config_checks = []
    for check in check_config(cwd, qaboard_config.config_error):
      config_checks.append(check)
      yield check
    state['has_project'] = bool(project) and not any(c.status == ERROR for c in config_checks)
    for message, fix in qaboard_config.config_errors:
      yield Check("qaboard.yaml", ERROR, message, fix=fix)
    for message, fix in qaboard_config.config_warnings:
      yield Check("qaboard.yaml", WARNING, message, fix=fix)
    if state['has_project']:
      yield from check_project(project, project_root, subproject, config, root)
      yield check_batches_files(list(qaboard_config.default_batches_files), root)
      yield check_git(qaboard_config.is_in_git_repo, qaboard_config.commit_id, qaboard_config.commit_branch, is_ci, qaboard_config.local_commit_placeholder)

  def server_checks() -> Iterator[Check]:
    if offline:
      yield Check("QA-Board server", SKIPPED, "--offline: qa doesn't send anything to QA-Board.")
      return
    from .auth import server_api
    from .api import api_verify, qa_token, qa_token_source
    server = state['server'] = server_api(None)
    state['token'] = qa_token
    server_check, site = check_server(server, verify=api_verify)
    state['site'] = site
    yield server_check
    if site is None:
      return
    project_name = Path(project).as_posix() if project else None
    sign_in_checks, accepted = check_sign_in(server, qa_token, qa_token_source, site, project_name, ci=is_ci, verify=api_verify)
    yield from sign_in_checks
    if accepted and qa_token and project_name:
      yield check_project_access(server, qa_token, qa_token_source, project_name, site, ci=is_ci, verify=api_verify)

  def storage_checks() -> Iterator[Check]:
    label = obj.get('raw_batch_label') or 'default'
    platform = obj.get('platform') or qaboard_config.default_platform
    configurations = obj.get('configurations') or []
    extra_parameters = obj.get('extra_parameters') or {}
    if not state['has_project']:
      yield Check("Storage", SKIPPED, "Fix qaboard.yaml first.")
      return
    if offline:
      state['batch_dir'] = make_batch_dir(qaboard_config.outputs_commit, label, platform, configurations, extra_parameters, False)
      yield check_folder("Local results", root / 'output', purpose="Local runs save their results there")
    else:
      assert project is not None
      setting_error = check_storage_setting(config, project, subproject)
      if setting_error:
        yield setting_error
      else:
        yield from shared_storage_checks(label, platform, configurations, extra_parameters)
    yield from database_checks(config, obj)

  def shared_storage_checks(label, platform, configurations, extra_parameters) -> Iterator[Check]:
    batch_label = label if is_ci else f"@{user}| {label}"
    state['batch_dir'] = make_batch_dir(qaboard_config.outputs_commit, batch_label, platform, configurations, extra_parameters, True)
    outputs_root = Path(qaboard_config.outputs_root or '')
    artifacts_root = qaboard_config.artifacts_root
    outputs_commit = Path(qaboard_config.outputs_commit)
    purpose = "`qa --share` and CI runs save their results there"
    if outputs_commit != outputs_root and outputs_root not in outputs_commit.parents:
      # without a git commit, qa saves shared results in the project's folder
      yield Check("Results location", WARNING, f"Without a git commit, `qa --share` saves results in {outputs_commit}, not in the storage ({outputs_root}): QA-Board won't find them.",
                  fix=f"Use git for your project, then commit:\n  git init && git add -A && git commit -m \"First commit\"\nDocs: {docs('project-init')}")
      yield check_folder("Results storage", outputs_root, root=outputs_root, purpose=purpose)
    else:
      yield check_folder("Results storage", outputs_commit, root=outputs_root, purpose=purpose)
    if artifacts_root and Path(artifacts_root) != outputs_root:
      yield check_folder("Artifacts storage", Path(qaboard_config.artifacts_commit), root=artifacts_root, required=is_ci,
                         purpose="`qa save-artifacts` saves builds there, for runs started from the web app")
    if state['site'] is not None and str(outputs_root) not in ('', '.'):
      storage_path = closest_existing(Path(qaboard_config.outputs_project or outputs_root))
      if storage_path and storage_path.is_dir():
        from .api import api_verify
        yield check_server_sees(state['server'], storage_path, state['token'], verify=api_verify)

  def runner_checks() -> Iterator[Check]:
    job_options = runner_job_options(runner, config, project, user, state['batch_dir'], cwd)
    yield from check_runner(runner, job_options, test_job=test_job)

  report.section("qa and your project")
  report.add(guarded("qaboard.yaml", project_checks))
  report.section("QA-Board server")
  report.add(guarded("QA-Board server", server_checks))
  report.section("Storage")
  report.add(guarded("Storage", storage_checks))
  report.section(f"Runner: {runner}")
  report.add(guarded(f"{runner} runner", runner_checks))

  runner_option = f" --runner {runner}" if runner != default_runner_name() else ''
  if not test_job and not any(c.status == ERROR for c in report.checks):
    echo('')
    echo(click.style(f"To check that a job really runs (where, as who, what it can access): qa doctor --test-job{runner_option}", dim=True))
  names = batch_names(list(qaboard_config.default_batches_files), root) if state['has_project'] else []
  return report.summary(f"qa{'' if offline else ' --share'} batch{runner_option} {names[0] if names else '<batch>'}")


def batch_names(batches_files: List[Any], root: Path) -> List[str]:
  """The names of the batches in these files, for examples. Files we can't read are ignored."""
  names: List[str] = []
  for batches_file in batches_files:
    try:
      with (root / batches_file).open(encoding='utf-8') as f:
        batches = yaml.safe_load(f)
    except Exception:
      continue
    if isinstance(batches, dict):
      names.extend(str(k) for k in batches if not str(k).startswith('.'))
  return names


def default_runner_name() -> str:
  try:
    from .qa import default_runner
    return default_runner
  except Exception:
    return 'local'


def database_checks(config: Dict[str, Any], obj: Dict[str, Any]) -> Iterator[Check]:
  """The inputs databases: the default input type's (or --database), and those of the other input types."""
  from .config import get_default_database
  from .conventions import get_settings
  inputs = config.get('inputs') or {}
  types = inputs.get('types') or {}
  default_type = obj.get('input_type') or types.get('default', 'default')
  known = [t for t in types if t != 'default']
  if default_type != 'default' and default_type not in known:
    yield Check("Input type", ERROR, f"There is no input type named {default_type!r} (inputs.types in qaboard.yaml). Types: {', '.join(known) or 'none'}.",
                fix=f"Use one of them: qa --type <type> ..., or define it in qaboard.yaml under inputs.types.\nDocs: {docs('inputs')}")
    default_type = 'default'
  names = [default_type, *[t for t in types if t not in ('default', default_type) and isinstance(types[t], dict) and 'database' in types[t]]]
  for input_type in names:
    try:
      settings = get_settings(input_type, config)
    except ValueError:
      continue
    default_database = Path(get_default_database(settings))
    database = default_database
    # qa --database, or QA_DATABASE
    if input_type == default_type and obj.get('database') and Path(obj['database']) != default_database:
      database = Path(obj['database'])
    legacy = settings.get(input_type)
    configured = 'database' in settings or (isinstance(legacy, dict) and 'database' in legacy) or database != default_database
    yield check_database(database, input_type, configured=configured)
