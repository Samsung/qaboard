r"""
Makes it possible to send qa runs on Windows hosts.

## How to use this?
Multiple options:
- On the CLI: `qa batch --runner=windows`
- In our YAML files defining batches:
```yaml
my-batch:
  runner: windows
  inputs:
  - my/images/
  configurations: [base, delta]
```

## Required configuration
- QA-Board needs to be setup with enough jenkins credentials to trigger builds
- qaboard.yaml needs to be configured with something like:
```yaml
runners:
  jenkins:
    build_url: http://jenkins.example.com/job/WindowsExecutor
    token: "1234"
``` 
- This Jenkins build job needs to be configured like this:
  * Enable "Trigger builds remotely", the token should match what's below
  * The build url and token should be the same as above
  * Parametrized: **task** should be a String parameter that gets a command to run
  * Build > "Execute Windows Batch command"
```
@echo %date% %time%
net use \\netapp\algo_data
net use \\netapp\raid
net use \\mars\stage\jenkins_ws
net use \\mars\stage\algo_jenkins_ws
net use \\mars\raid
@echo "%task%"
"%task%"" 
```
"""
import math
import os
import sys
import re
import time
from typing import List, Dict, Any, Optional, Tuple, Iterable

from click import secho

from .base import BaseRunner
from .job import Job
from ..run import RunContext
from ..checks import Check
from ..compat import linux_to_windows, linux_to_windows_path
from ..config import config

from ..api import api_prefix, api_verify, api_timeout, headers as api_headers, project_name

# Valid values for PowerShell's $ErrorActionPreference (case-insensitive)
ERROR_ACTION_PREFERENCES = frozenset({"continue", "stop", "silentlycontinue", "inquire", "ignore"})
DEFAULT_ERROR_ACTION = "Stop"


def get_error_action(job_options: Optional[Dict[str, Any]]) -> str:
  # ErrorActionPreference can be configured per-job, with an env var, and defaults to "Stop"
  preference = (job_options or {}).get('error_action') or os.environ.get('QA_RUNNER_ERROR_ACTION') or DEFAULT_ERROR_ACTION
  if preference.lower() not in ERROR_ACTION_PREFERENCES:
    secho(f'[WARNING] Invalid ErrorActionPreference: {preference}! Falling back to "{DEFAULT_ERROR_ACTION}"', fg='yellow')
    preference = DEFAULT_ERROR_ACTION
  return preference


# Defaults for polling Jenkins builds
DEFAULT_POLL_TIMEOUT_SECONDS = 2 * 60 * 60  # 2 hours
DEFAULT_POLL_INTERVAL_SECONDS = 30          # 0.5 minute
# Statuses while a Jenkins build is not finished yet
ACTIVE_BUILD_STATUSES = frozenset({"BLOCKED", "STUCK", "running"})

def build_powershell_env(context_env: Dict[str, Any]) -> List[str]:
  """Render custom node env vars as `$Env:KEY = 'value'` lines (single quotes escaped by doubling).
  A `prepend_path` key is special: instead of setting a variable, it prepends to the existing PATH."""
  env_lines = []
  env = dict(context_env)

  # $PATH-like: prepend dirs to the existing PATH instead of overwriting it
  prepend_path = env.pop('prepend_path', None)
  if prepend_path:
    if isinstance(prepend_path, str):
      prepend_path = [prepend_path]

    # build the joined PATH with the prepended paths
    joined = ';'.join(str(path) for path in prepend_path)
    # single quotes are escaped by doubling, per PowerShell's single-quoted string rules
    escaped_joined = joined.replace("'", "''")
    # PowerShell single-quoted strings are literal: $env:PATH is concatenated at runtime, not interpolated
    env_lines.append(f"$Env:PATH = '{escaped_joined};' + $env:PATH")
    
    # a regular PATH key would overwrite the prepended value since it's rendered after
    if 'PATH' in env:
      secho("[WARNING] Ignoring the custom PATH since prepend_path takes precedence", fg='yellow')
      del env['PATH']

  for key, value in env.items():
    # single quotes are escaped by doubling, per PowerShell's single-quoted string rules
    escaped_value = str(value).replace("'", "''")
    env_lines.append(f"$Env:{key} = '{escaped_value}'")
  return env_lines


def resolve_poll_settings(timeout_seconds: Optional[float] = None, interval_seconds: Optional[float] = None) -> Tuple[int, int]:
  """Resolve the polling timeout and interval: explicit params > environment variables > defaults."""
  def resolve(val: Any, env_var: str, default: int, param_name: str) -> int:
    # fallback to defaults
    if val is None and env_var not in os.environ:
      return default

    # resolve value according to the precedence ladder
    raw: Any = val if val is not None else os.environ.get(env_var)
    try:
      result = int(float(raw))
      if result <= 0:
        raise ValueError
    except (TypeError, ValueError, OverflowError):
      source = env_var if val is None else param_name
      secho(f"[WARNING] Invalid value for {source}: {raw}. Falling back to the default ({default} seconds)", fg='yellow')
      return default
    return result

  return (resolve(timeout_seconds, 'QA_JENKINS_TIMEOUT', DEFAULT_POLL_TIMEOUT_SECONDS, 'timeout_seconds'),
          resolve(interval_seconds, 'QA_JENKINS_STATUS_INTERVAL', DEFAULT_POLL_INTERVAL_SECONDS, 'interval_seconds'))


def get_jenkins_config():
    jenkins_config = {}
    error = None
    if "QA_RUNNERS_JENKINS_BUILD_URL" in os.environ:
        jenkins_config["build_url"] = os.environ["QA_RUNNERS_JENKINS_BUILD_URL"]
    if "QA_RUNNERS_JENKINS_TOKEN" in os.environ:
        jenkins_config["token"] = os.environ["QA_RUNNERS_JENKINS_TOKEN"]
    if not jenkins_config:
        if 'runners' not in config or 'jenkins' not in config['runners']:
            error = "You must configure your Jenkins runner in qaboard.yaml"
        jenkins_config.update(config['runners']['jenkins'])
    if "build_url" not in jenkins_config:
          error = "You must configure your Jenkins runner in qaboard.yaml with build_url (and usually a token)"
    if error:
        secho(f"ERROR: {error}", fg='red', bold=True)
        secho("     See https://samsung.github.io/qaboard/docs/jenkins-integration", fg='red')
        raise ValueError(error)
    return jenkins_config


def trigger_run(task: str) -> Dict:
    import requests
    from ..config import commit_id
    jenkins_config = get_jenkins_config()
    data = {
        "build_url": jenkins_config["build_url"],
        "token": jenkins_config.get("token"),
        "cause": "Triggered by QA-Board",
        "params": {
            "task": task,
        },
        # Without a token (QABOARD_TOKEN, `qa auth login`), the server only starts the jobs of the project's qaboard.yaml
        "project": project_name(),
        "commit": commit_id,
    }
    r = requests.post(f"{api_prefix}/jenkins/build/trigger/", json=data, headers=api_headers, verify=api_verify, timeout=api_timeout)
    try:
        r.raise_for_status()
        if r.json().get('error'):
            r.json()
            raise ValueError
    except Exception:
        secho(str(r.headers), fg='red', dim=True)
        secho(r.text, fg='red')
        secho(f"[ERROR] Could not start the Jenkins job running on Windows {task}", fg='red', bold=True)
        sys.exit(1)
    job_url = f"{r.json()['web_url']}console" if 'web_url' in r.json() else r.json()['url']
    secho(f"[TRIGGER] A Jenkins job is now running on Windows. To check the status (and possible errors!):", fg='blue', bold=True)
    secho(f"          {job_url}", fg='blue')
    return r.json()




def build_status(build_info):
  import requests
  from requests.adapters import HTTPAdapter, Retry

  # Adding callback function on each retry attempt using requests/urllib3
  # https://stackoverflow.com/questions/51188661/adding-callback-function-on-each-retry-attempt-using-requests-urllib3
  class CallbackRetry(Retry):
      def __init__(self, *args, **kwargs):
          self._callback = kwargs.pop('callback', None)
          super(CallbackRetry, self).__init__(*args, **kwargs)
      def new(self, **kw):
          kw['callback'] = self._callback
          return super(CallbackRetry, self).new(**kw)
      def increment(self, method, url, *args, **kwargs):
          if self._callback:
            self._callback(url)
          return super(CallbackRetry, self).increment(method, url, *args, **kwargs)



  session = requests.Session()
  adapter = HTTPAdapter(
    # https://urllib3.readthedocs.io/en/latest/reference/urllib3.util.html#urllib3.util.Retry.
    max_retries=CallbackRetry(
      connect=5, read=5, status=5, total=10,
      status_forcelist=[500, 502, 503, 504],
      backoff_factor=1,
      # by default won't retry non-idempotent requests like POST
      # but it's not an issue for us, we retry everything
      allowed_methods=None,
      callback=lambda url: secho(f'Retrying {url}', fg='yellow'),
    )
  )
  session.mount('https://', adapter)
  session.mount('http://', adapter)
  r = session.post(f"{api_prefix}/jenkins/build/", json=build_info, headers=api_headers, verify=api_verify, timeout=api_timeout)
  try:
      r.raise_for_status()
      if r.json().get('error'):
          print(r.json())
          raise ValueError
  except Exception:
      secho(str(r.headers), fg='red', dim=True)
      secho(r.text, fg='red')
      secho("[ERROR] The Jenkins job failed", fg='red', bold=True)
      sys.exit(1)
  return r.json()['status']


def _poll_jenkins_status(build_info: Dict[str, Any], timeout_seconds: Optional[float] = None, interval_seconds: Optional[float] = None) -> str:
  """Wait for a Jenkins build to finish, and return its final status.
  Timeout / interval defaults to 2h / 30s, overridable with env vars, and explicit parameters take precedence."""
  timeout, interval = resolve_poll_settings(timeout_seconds, interval_seconds)
  max_tries = math.ceil(timeout / interval)

  status = build_status(build_info)
  tries = 0
  while status in ACTIVE_BUILD_STATUSES and tries < max_tries:
    secho(f"status: {status}", dim=True)
    time.sleep(interval)
    status = build_status(build_info)
    tries += 1
  secho(f"Jenkins job finished with status: {status}")
  return status


def poll_jenkins_status(build_info: Dict[str, Any], timeout_seconds: Optional[float] = None, interval_seconds: Optional[float] = None) -> bool:
  """Wait for a Jenkins build to finish. Returns whether its final status is 'success'.
  You must pass `build_info`, which is returned by `JenkinsWindowsRunner.start()`, so we can identify your jenkins job."""
  return _poll_jenkins_status(build_info, timeout_seconds, interval_seconds) == 'success'


def wait_for_build(build_info, should_print_log=True):
  status = _poll_jenkins_status(build_info)
  if should_print_log:
    log_url = f"{build_info['web_url']}consoleText" if 'web_url' in build_info else build_info['url']
    print_log(log_url)
  if status != 'success':
    secho(f'[ERROR] There was an issue while waiting for the end of: {build_info["web_url"] if "web_url" in build_info else build_info["url"]}', fg='red')
    secho(f'        The job is marked as: {status}', fg='red')
    raise Exception


def print_log(log_url):
    import requests
    try:
        r = requests.get(log_url, timeout=api_timeout)
        result = r.text
        secho(f"JENKINS LOG:", fg='blue', bold=True)
        print(result)
    except Exception:
        secho(f"[WARNING] Could not retrieve jenkins job log!", fg='yellow')


class JenkinsWindowsRunner(BaseRunner):
  type = "windows"
  platform = "windows"

  def __init__(self, run_context : RunContext):
    self.run_context = run_context


  def start(self, blocking=True, log_path=None, should_print_log=True) -> Dict:
    # To allow the jenkins job to write we need permissions to be wide open
    self.run_context.output_dir.mkdir(exist_ok=True, parents=True)
    try: # can't be done reliably at SIRC
      self.run_context.output_dir.chmod(0o777)
    except Exception:
      pass

    # Can't use commands with more than 256 characters, so we use a script to save space
    command = self.run_context.command
    assert command

    # external callers may pass a duck-typed context without those attributes
    job_options = getattr(self.run_context, 'job_options', None)
    context_env = getattr(self.run_context, 'env', None) or {}

    if not log_path:
      log_path = self.run_context.output_dir / 'log.txt'

    # https://docs.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/out-file?view=powershell-7.1
    # https://stackoverflow.com/questions/50912801/output-multiple-command-results-to-a-single-txt-file
    command = f"& {{{command}}} | Tee-Object -FilePath {linux_to_windows_path(log_path)}"

    # not needed after PowerShell 7
    # https://stackoverflow.com/questions/2416662/what-are-the-powershell-equivalents-of-bashs-and-operators
    command = re.sub(r"(.*) \|\| (.*)", r"\1; if (-not $?) { \2 }", command)
    command = re.sub(r"(.*) && (.*)", r"\1; if ($?) { \2 }", command)

    from ..config import user
    script = "\n".join([
      # TODO: use this? job_options.get('user', user)
      f'cd "{linux_to_windows(os.getcwd())}"',
      f"$Env:QA_USER = '{user}'",
      *build_powershell_env(context_env),
      # https://stackoverflow.com/questions/40098771/changing-powershells-default-output-encoding-to-utf-8
      "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
      f"$ErrorActionPreference = \"{get_error_action(job_options)}\"",
      command,
      'exit $lastExitCode',
    ])
    script_path = self.run_context.output_dir / 'run.ps1'
    with script_path.open('w', newline='\r\n') as f:
      f.write(script)
    bat_script_path = (self.run_context.output_dir / 'run.bat').resolve()
    with bat_script_path.open('w', newline='\r\n') as f:
      f.write(f'powershell  -ExecutionPolicy Bypass "{linux_to_windows_path(script_path)}"')
    build_info = trigger_run(task=f'{linux_to_windows_path(bat_script_path)}')
    print(f"Jenkins: {build_info}")

    if blocking:
      wait_for_build(build_info, should_print_log)

    return build_info



  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True):
    build_infos = [job.start(blocking=False) for job in jobs]
    if blocking:
      for build_info in build_infos:
        wait_for_build(build_info)


  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
    return NotImplementedError


  @classmethod
  def doctor(cls, job_options: Dict[str, Any], test_job: bool = False) -> Iterable[Check]:
    """
    The Jenkins job is configured and exists, and the Windows hosts get Windows paths. QA-Board starts the builds
    with its own Jenkins credentials (JENKINS_AUTH): only a test build (test_job) checks them.
    """
    import requests
    from urllib.parse import urlsplit
    from ..checks import OK, WARNING, ERROR
    from ..doctor import docs, describe_error, mask_url_password, TIMEOUT
    from ..compat import mappings
    page = docs('jenkins-integration')
    snippet = ("runners:\n  default: local   # the runner is named windows: qa batch --runner windows <batch>\n  jenkins:\n"
               "    build_url: https://jenkins.example.com/job/my-team/job/WindowsExecutor\n    token: \"<the job's 'Trigger builds remotely' token>\"")
    # Like get_jenkins_config: with one of the environment variables, qaboard.yaml's settings are ignored
    env = {key: os.environ[name] for key, name in (('build_url', 'QA_RUNNERS_JENKINS_BUILD_URL'), ('token', 'QA_RUNNERS_JENKINS_TOKEN')) if name in os.environ}
    settings = env if env else {key: job_options[key] for key in ('build_url', 'token') if job_options.get(key)}
    source = "QA_RUNNERS_JENKINS_BUILD_URL" if env else "runners.jenkins in qaboard.yaml"
    build_url = settings.get('build_url')
    if not build_url:
      ignored = " QA_RUNNERS_JENKINS_TOKEN is set without QA_RUNNERS_JENKINS_BUILD_URL: then qa ignores qaboard.yaml." if env else ''
      yield Check("Jenkins job", ERROR, f"No Jenkins job to send the runs to: runners.jenkins.build_url isn't set.{ignored}",
                  fix=f"In qaboard.yaml:\n{snippet}\nOr set QA_RUNNERS_JENKINS_BUILD_URL and QA_RUNNERS_JENKINS_TOKEN.\nDocs: {page}")
      return
    # build_url may have credentials (user:token@)
    shown_url = mask_url_password(str(build_url))
    parts = urlsplit(str(build_url))
    if parts.scheme not in ('http', 'https') or not parts.hostname:
      yield Check("Jenkins job", ERROR, f"build_url isn't a Jenkins job's URL: {shown_url} (from {source})", fix=f"{snippet}\nDocs: {page}")
      return
    yield Check("Jenkins job", OK, f"{shown_url} (from {source})")
    if not settings.get('token'):
      yield Check("Jenkins token", WARNING, "No token for the job's \"Trigger builds remotely\": QA-Board uses its own (JENKINS_BUILD_TOKEN), if its admins set one.",
                  fix=f"Give the job's token in runners.jenkins.token (or QA_RUNNERS_JENKINS_TOKEN).\nDocs: {page}#creating-a-build-job-that-qa-will-use")

    # qa prints the builds' logs from there
    try:
      r = requests.get(f"{str(build_url).rstrip('/')}/api/json", timeout=TIMEOUT)
      if r.status_code == 404:
        yield Check("Jenkins", ERROR, f"Jenkins answered 404 for {shown_url}: there is no such job.",
                    fix="Copy the job's URL from Jenkins. Jobs in folders look like https://jenkins.example.com/job/folder/job/name")
      elif r.status_code in (200, 401, 403):
        yield Check("Jenkins", OK, f"{parts.hostname} answers" + (" (it needs credentials: QA-Board uses its own)" if r.status_code != 200 else ''))
      else:
        yield Check("Jenkins", WARNING, f"Jenkins answered {r.status_code} for {shown_url}.", fix=f"Check that you can open {shown_url} in your browser.")
    except requests.RequestException as e:
      yield Check("Jenkins", WARNING, f"Can't reach {parts.hostname} from here ({describe_error(e)}): QA-Board starts the builds, but qa prints their logs from there.",
                  fix=f"Check that you can open {shown_url} from this machine (proxy, VPN...).")

    # Without a token, QA-Board only starts the jobs listed in the project's qaboard.yaml
    from ..api import qa_token
    if env and env.get('build_url') and env['build_url'] != job_options.get('build_url') and not qa_token:
      yield Check("Jenkins permissions", WARNING, "QA_RUNNERS_JENKINS_BUILD_URL isn't the job in qaboard.yaml: without a token, QA-Board only starts the jobs listed there.",
                  fix=f"Sign in: qa auth login (in CI: set QABOARD_TOKEN), or put the job in runners.jenkins.build_url.\nDocs: {page}")

    # The runs' commands and logs use Windows paths
    cwd = str(job_options.get('cwd') or os.getcwd())
    if os.name != 'nt':
      windows_cwd = linux_to_windows(cwd)
      if not any(cwd.startswith(linux) for _, linux in mappings) and windows_cwd == cwd.replace('/', '\\'):
        yield Check("Windows paths", WARNING, f"qa doesn't know the Windows path of {cwd}: the Windows hosts would get {windows_cwd}.",
                    fix=("Run qa batch from a shared drive the Windows hosts see, and ask your QA-Board admins for its path mapping:\n"
                         "QABOARD_PATH_MAPPINGS is a JSON list of [Windows prefix, Linux prefix], e.g.\n"
                         "  export QABOARD_PATH_MAPPINGS='[[\"\\\\\\\\server\\\\share\", \"/mnt/share\"]]'\n"
                         "Your organization's site package can set it."))
      else:
        yield Check("Windows paths", OK, f"{cwd} is {windows_cwd} on Windows")

    if test_job:
      yield from cls.doctor_test_job(job_options)


  @classmethod
  def doctor_test_job(cls, job_options: Dict[str, Any]) -> Iterable[Check]:
    """Starts a build that says where it runs, as who, if it sees the batch's folder and `qa`. Waits 10 minutes at most."""
    from ..checks import OK, WARNING, ERROR
    from ..doctor import docs, make_test_dir, remove_test_dir
    name = "Jenkins test build"
    try:
      test_dir, existing = make_test_dir(job_options)
    except OSError as e:
      yield Check(name, ERROR, f"Can't create the test build's folder: {e}", fix="Fix the storage first (see above).")
      return
    try: # the build writes there
      test_dir.chmod(0o777)
    except OSError:
      pass
    result = test_dir / 'result.txt'
    keep = False
    try:
      windows_result = linux_to_windows_path(result)
      with (test_dir / 'run.bat').open('w', newline='\r\n') as f:
        f.write("\n".join([
          "@echo off",
          f'echo user: %USERNAME%> "{windows_result}"',
          f'echo host: %COMPUTERNAME%>> "{windows_result}"',
          f'where qa >nul 2>&1 && (echo qa: found>> "{windows_result}") || (echo qa: not found>> "{windows_result}")',
        ]))
      try:
        build_info = trigger_run(task=str(linux_to_windows_path(test_dir / 'run.bat')))
      except SystemExit:
        yield Check(name, ERROR, "QA-Board couldn't start the test build: see why above.",
                    fix=f"QA-Board starts builds with its Jenkins credentials (JENKINS_AUTH): if they are refused, tell your QA-Board admins.\nDocs: {docs('jenkins-integration')}")
        return
      url = build_info.get('web_url') or build_info.get('url')
      try:
        status = _poll_jenkins_status(build_info, timeout_seconds=600, interval_seconds=10)
      except SystemExit:
        status = 'unknown'
      if status in ACTIVE_BUILD_STATUSES:
        # qa can't stop Jenkins builds: we keep its folder, so that it doesn't fail on a missing folder
        keep = True
        yield Check(name, WARNING, f"The test build is still {status} after 10 minutes: {url}",
                    fix=f"Stop it in Jenkins if it's stuck: {url}\nThen delete its folder: rm -r {test_dir}")
        return
      if status != 'success':
        yield Check(name, ERROR, f"The test build ended as {status}: {url}", fix=f"See its console: {url}console" if url else "See the build's console in Jenkins.")
        return
      if not result.exists():
        yield Check(name, ERROR, f"The test build ran, but {result} isn't there: the Windows host doesn't see {test_dir} as {linux_to_windows_path(test_dir)}.",
                    fix=f"The build's command must mount the shared drives (net use \\\\server\\share), and QABOARD_PATH_MAPPINGS must map them.\nSee the build's console: {url}console")
        return
      found = dict(line.strip().split(': ', 1) for line in result.read_text(errors='replace').splitlines() if ': ' in line)
      where = f"on {found.get('host', '?')} as {found.get('user', '?')}"
      if found.get('qa') != 'found':
        yield Check(name, ERROR, f"A test build ran {where}, but `qa` isn't on its PATH: the runs would fail.",
                    fix="Install qaboard on the Windows hosts (pip install qaboard), for the user that runs the builds.")
        return
      yield Check(name, OK, f"A test build ran {where}, and found qa")
    finally:
      if not keep:
        remove_test_dir(test_dir, existing)
