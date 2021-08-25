"""
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
    build_url: http://jenmaster1:8080/job/ALGO/job/WindowsExecutor
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
import os
import re
import time
from typing import List, Dict, Any

from click import secho
import requests

from .base import BaseRunner
from .job import Job
from ..run import RunContext
from ..compat import linux_to_windows, linux_to_windows_path
from ..config import config

from ..api import api_prefix



def trigger_run(task: str) -> Dict:
    config_error = False
    if 'runners' not in config or 'jenkins' not in config['runners']:
      secho("ERROR: you must configure your Jenkins runner in qaboard.yaml", fg='red')
      config_error = True
    jenkins_config = config['runners']['jenkins']
    print(jenkins_config)
    if any([k not in jenkins_config for k in ('build_url', 'token')]):
      secho("ERROR: you must configure your Jenkins runner in qaboard.yaml with build_url/token", fg='red')
    if config_error:
      raise ValueError("Missing config in qaboard.yaml")
    data = {
        "build_url": jenkins_config["build_url"],
        "token": jenkins_config["token"],
        "cause": "qa run",
        "params": {
            "task": task,
        }
    }
    r = requests.post(f"{api_prefix}/jenkins/build/trigger/", json=data)
    try:
        r.raise_for_status()
        if r.json().get('error'):
            r.json()
            raise ValueError
    except:
        secho(str(r.headers), fg='red', dim=True)
        secho(r.text, fg='red')
        secho(f"[ERROR] Could not start the Jenkins job running on Windows {task}", fg='red', bold=True)
        exit(1)
    job_url = f"{r.json()['web_url']}console" if 'web_url' in r.json() else r.json()['url']
    secho(f"[TRIGGER] A Jenkins job is now running on Windows. To check the status (and possible errors!):", fg='blue', bold=True)
    secho(f"          {job_url}", fg='blue')
    return r.json()


def build_status(build_info):
  r = requests.post(f"{api_prefix}/jenkins/build/", json=build_info)
  try:
      r.raise_for_status()
      if r.json().get('error'):
          print(r.json())
          raise ValueError
  except:
      secho(str(r.headers), fg='red', dim=True)
      secho(r.text, fg='red')
      secho("[ERROR] The Jenkins job failed", fg='red', bold=True)
      exit(1)
  return r.json()['status']


def wait_for_build(build_info, should_print_log=True):
    sleep =       5 # s
    timeout = 15*60 # s 
    max_tries = timeout / sleep
    status = build_status(build_info)
    tries = 0
    while status in ["BLOCKED", "STUCK", "running"] and tries < max_tries: 
        tries += 1
        time.sleep(5) # seconds
        status = build_status(build_info)
        if status != "success":
            secho(status, dim=True)
    if should_print_log:
        log_url = f"{build_info['web_url']}consoleText" if 'web_url' in build_info else build_info['url']
        print_log(log_url)
    if status != 'success':
        secho(f'[ERROR] There was an issue while waiting for the end of: {build_info["web_url"] if "web_url" in build_info else build_info["url"]}', fg='red')
        secho(f'        The job is marked as: {status}', fg='red')
        raise Exception


def print_log(log_url):
    try:
        r = requests.get(log_url)
        result = r.text
        secho(f"JENKINS LOG:", fg='blue', bold=True)
        print(result)
    except:
        secho(f"[WARNING] Could not retrieve jenkins job log!", fg='yellow')


class JenkinsWindowsRunner(BaseRunner):
  type = "windows"
  platform = "windows"

  def __init__(self, run_context : RunContext):
    self.run_context = run_context


  def start(self, blocking=True, log_path=None, should_print_log=True) -> Dict:
    # To allow the jenkins job to write we need permissions to be wide open
    self.run_context.output_dir.mkdir(exist_ok=True, parents=True)
    self.run_context.output_dir.chmod(0o777)

    # Can't use commands with more than 256 characters, so we use a script to save space
    command = self.run_context.command
    assert command

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
      # TODO: use this? self.run_context.job_options.get('user', user)
      f'cd "{linux_to_windows(os.getcwd())}"',
      f"$Env:QA_USER = '{user}'",
      # https://stackoverflow.com/questions/40098771/changing-powershells-default-output-encoding-to-utf-8
      "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
      "$ErrorActionPreference = \"Stop\"",
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