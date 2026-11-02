"""
APIs related to parameter tuning
"""
import re
import os
import sys
import json
import uuid
import signal
import fnmatch
import datetime
import itertools
import shutil
import subprocess
from glob import glob
from copy import deepcopy
from shlex import quote
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, List, Any

import yaml
from flask import request, jsonify, g
from sqlalchemy.orm.exc import NoResultFound

from qaboard.utils import merge
from qaboard.iterators import iter_inputs, resolve_aliases, recording_missing_inputs, BATCH_FILE_SETTINGS
from qaboard.conventions import deserialize_config, location_from_spec

from backend import app, db_session
from ..models import CiCommit, Project
from ..config import qaboard_data_shared_dir
from ..shell_utils import safe_user_name, lsf_bridge_command
from ..storage import check_storage_path, UnsafePathError
from ..submissions import record_submission, MAX_SUBMISSIONS, user_batch_dir, submission_dir # noqa: F401
from ..artifacts import ArtifactsUnavailable
from ..notifications.batches import request_batch_notification, cancel_batch_notification
from .auth import login_required, require_project_access, is_authorized_user, forbidden_project


def get_groups_path(project_id, name="extra-batches", create=True):
    """
    Return the path of the file where we save the groups of tests we defined for a project.
    Creates it if it does not exist yet (unless `create` is False).
    """
    name = str(name)
    if not re.match(r'^[\w.@-]+$', name) or name.startswith('.'):
        raise ValueError(f"Invalid group file name: {name!r}")
    root = qaboard_data_shared_dir.resolve()
    path = (root / project_id / f"{name}.yml").resolve()
    if not path.is_relative_to(root):
        raise ValueError(f"Invalid project: {project_id!r}")
    if create and not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w") as f:
            f.write("""# Docs:\n# https://samsung.github.io/qaboard/docs/batches-running-on-multiple-inputs""")
    return path



@app.route("/api/v1/tests/groups", methods=["GET", "POST"])
def groups():
    """
    Return or update the groups of tests we defined for a project.
    TODO: We could just make it part of the database, why bother with files...
          It could be saved as test as project.data.test_groups
          We would *just* need to write the migration, and it would save 30 lines of code.
    """
    project_id = request.args["project"]
    name = request.args["name"]
    if not is_authorized_user(None, project_id):
        return forbidden_project(project_id)
    try:
        # reading doesn't create the file
        groups_path = get_groups_path(project_id, name=name, create=request.method == "POST")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if request.method == "POST":
        return login_required(lambda path: require_project_access(None, project_id) or update_groups(path))(groups_path)
    else:
        if not groups_path.exists():
            return "# Docs:\n# https://samsung.github.io/qaboard/docs/batches-running-on-multiple-inputs"
        try:
            with groups_path.open("r") as f:
                return f.read()
        except:
            return (
                jsonify(
                    {"error": f"Could not open or read {groups_path}"}
                ),
                500,
            )


def update_groups(groups_path):
    data = request.get_json()
    try:
      yaml.load(data["groups"], Loader=yaml.SafeLoader)
    except Exception as e:
      return jsonify(str(e)), 400
    with groups_path.open("w") as f:
        f.write(data["groups"])
    return jsonify("OK")


def commit_interpolation_vars(project):
  """Fills {project} and {subproject} in a commit's qaboard.yaml, like `qa` does."""
  return {"project": Path(project.id), "subproject": Path(project.id_relative)}


def commit_qaboard_config(ci_commit):
  """The commit's qaboard.yaml, or the project's if `qa` never told us about the commit's."""
  return ci_commit.data.get('qatools_config') or ci_commit.project.data.get('qatools_config', {})


def _is_file(path):
  try:
    return path.is_file(), None
  except OSError as e:
    return False, str(e)


def commit_batches_files(ci_commit, config):
  """
  The batch files listed in a commit's qaboard.yaml (`inputs.batches`), as saved in its artifacts.
  They are in the same order as for `qa batch`: when several define a batch, the last one wins.
  Returns [{"source": "commit", "path": as in qaboard.yaml, "location": Path or None, "exists": bool, "error"?: str}]
  """
  root = ci_commit.repo_artifacts_dir
  config_inputs = config.get('inputs') or {}
  # "batches" is prefered, "groups" is for backward compatibility
  specs = config_inputs.get('groups', config_inputs.get('batches')) or []
  if not isinstance(specs, (list, tuple)):
    specs = [specs]
  files = []
  for spec in specs:
    try:
      path = location_from_spec(spec, commit_interpolation_vars(ci_commit.project))
    except Exception as e:
      files.append({"source": "commit", "path": str(spec), "location": None, "exists": False, "error": f"Could not understand this path: {e}"})
      continue
    if '*' in str(path):
      # Patterns are relative to the root qaboard.yaml, like for `qa batch`.
      # We don't chdir like it does: other requests run in parallel.
      matches = sorted(glob(str(path), root_dir=root)) if root.is_dir() else []
      if not matches:
        files.append({"source": "commit", "path": str(path), "location": root / path, "exists": False})
      for match in matches:
        exists, error = _is_file(root / match)
        files.append({"source": "commit", "path": match, "location": root / match, "exists": exists, **({"error": error} if error else {})})
    else:
      exists, error = _is_file(root / path)
      files.append({"source": "commit", "path": str(path), "location": root / path, "exists": exists, **({"error": error} if error else {})})
  return files


def read_batches_file(batches_file):
  """
  Returns the batches defined in a file, or None if it can't be read.
  Sets the file's status: ok, empty, missing or invalid (with an error).
  """
  if batches_file.get("error"):
    batches_file["status"] = "invalid"
    return None
  if not batches_file["exists"]:
    batches_file["status"] = "missing"
    return None
  try:
    with batches_file["location"].open() as f:
      batches = yaml.load(f, Loader=yaml.SafeLoader)
  except Exception as e:
    batches_file["status"] = "invalid"
    batches_file["error"] = str(e)
    return None
  if batches is None:
    batches_file["status"] = "empty"
    return {}
  if not isinstance(batches, dict):
    batches_file["status"] = "invalid"
    batches_file["error"] = f"Expected batch names and their definitions, got a {type(batches).__name__}"
    return None
  batches_file["status"] = "ok"
  return batches


def batch_definitions(files_batches):
  """
  Where each batch is defined, and the aliases, from [(file, batches)].
  Returns ({batch: [the paths of the files defining it, in order]}, aliases).
  Like for `qa batch`, the last file defining a batch wins.
  """
  defined: Dict[str, List[str]] = {}
  aliases: Dict[str, Any] = {}
  for batches_file, batches in files_batches:
    if not batches:
      continue
    file_aliases = batches.get('aliases', batches.get('groups', {})) or {}
    if isinstance(file_aliases, dict):
      aliases.update(file_aliases)
    names = [n for n in batches if isinstance(n, str) and not n.startswith('.') and n not in BATCH_FILE_SETTINGS]
    batches_file["batches"] = len(names)
    for name in names:
      defined.setdefault(name, []).append(batches_file["path"])
  return defined, aliases


def definitions_of(batches, defined):
  """
  Where the batches are defined, from batch_definitions(). `batches` can be patterns, like `qa batch --batch 'night-*'`.
  Returns ([{"name", "files"}], the batches that are not defined).
  """
  definitions, undefined = [], []
  for batch in batches:
    matches = [batch] if batch in defined else [n for n in defined if fnmatch.fnmatch(n, batch)]
    definitions.extend({"name": m, "files": defined[m]} for m in matches)
    if not matches:
      undefined.append(batch)
  return definitions, undefined


def batches_warnings(name, files, defined, aliases, tests, missing_inputs, artifacts_dir=None):
  """Explains, in sentences, what may be wrong with the batch files, or why a batch has no tests."""
  warnings = []
  commit_files = [f for f in files if f["source"] == "commit"]
  if artifacts_dir is not None and not artifacts_dir.is_dir():
    warnings.append(f"This commit's artifacts folder does not exist: `{artifacts_dir}`. Run `qa save-artifacts` on this commit (the CI usually does it).")
  else:
    not_saved = [f"`{f['path']}`" for f in commit_files if f["status"] == "missing"]
    if not_saved:
      warnings.append(
        f"Not in this commit's artifacts (`{artifacts_dir}`): {', '.join(not_saved)}. "
        "Check the names in `inputs.batches`, and run `qa save-artifacts` on this commit: it saves the files listed in `inputs.batches`."
      )
  for f in files:
    if f["status"] == "invalid":
      warnings.append(f"Could not read `{f['path']}`: {f['error']}")

  definitions, undefined = definitions_of(resolve_aliases([name], aliases), defined)
  # Names that are not batches are used as input paths, like with `qa batch`
  used_as_paths = any(getattr(t, 'batch', None) is None for t in tests)
  if undefined and not used_as_paths:
    read = [f"`{f['path']}`" for f in files if f["status"] in ("ok", "empty")]
    where = f"the batch files QA-Board could read: {', '.join(read)}" if read else "any batch file: QA-Board could not read any"
    if artifacts_dir is not None and not commit_files:
      where += ". This commit's qaboard.yaml has no `inputs.batches`"
    warnings.append(f"{' and '.join(f'`{b}`' for b in undefined)} {'is' if len(undefined) == 1 else 'are'} not defined in {where}.")

  if missing_inputs:
    shown = [f"`{m['input']}` under `{m['database']}`" + (f" (`{', '.join(m['globs'])}`)" if m.get('globs') else '') for m in missing_inputs[:5]]
    more = f", and {len(missing_inputs) - 5} more" if len(missing_inputs) > 5 else ""
    warnings.append(f"Inputs not found by the QA-Board server: {'; '.join(shown)}{more}.")
    for database in sorted({m['database'] for m in missing_inputs}):
      if not Path(database).is_dir():
        warnings.append(f"The QA-Board server can't see the database `{database}`: it is not mounted on the server, or not readable by it.")
  return warnings, definitions


def missing_inputs_from_logs(logs):
  """The inputs `qa batch` warned it didn't find, like recording_missing_inputs()."""
  pattern = r'No inputs found (?:for the batch|matching) "(.*?)".*? under "?(.*?)"?\.?$'
  return [{"input": m.group(1), "database": m.group(2)} for m in re.finditer(pattern, logs, re.MULTILINE)]


# Below nginx's uwsgi_read_timeout (300s): users get our message, not a 504 from the proxy
LIST_TESTS_TIMEOUT = 240

def run_with_timeout(cmd, cwd, timeout):
  """
  Like subprocess.run(capture_output=True, timeout=...), but on timeout it kills what the command started too
  (e.g. `qa` started by bash): they would keep running, and keep the pipes open.
  """
  with subprocess.Popen(cmd, cwd=cwd, encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True) as process:
    try:
      stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
      try:
        os.killpg(process.pid, signal.SIGKILL)
      except ProcessLookupError:
        pass
      process.communicate()
      raise
  return subprocess.CompletedProcess(cmd, process.returncode, stdout, stderr)


def mkdir_for_everyone(path):
  """
  Creates a folder and its missing parents, writable by all users: runs started as the users write in them.
  We don't change the umask: it's the process', so it would apply to what other threads create meanwhile.
  """
  missing = [p for p in [path, *path.parents] if not p.exists()]
  path.mkdir(parents=True, exist_ok=True)
  for p in missing:
    p.chmod(0o777)


def commit_database(database, ci_commit=None):
    """
    The inputs database of a commit's runs. A relative one (`inputs.database: inputs` in qaboard.yaml: inputs in the
    project) is relative to the commit's artifacts: the batches started from QA-Board run there, and like `qa`,
    from the root qaboard.yaml's folder.
    """
    database = Path(database)
    if ci_commit is None or database.is_absolute():
        return database
    return ci_commit.repo_artifacts_dir / database


@app.route("/api/v1/tests/group", methods=["POST"])
@login_required
def get_group():
    """
    Lists the tests in a batch, as `qa batch` would on a commit.
    Besides the tests, explains what was used to find them: the batch files ("files") and their status,
    where the batch is defined ("definitions"), and what may be wrong ("warnings").
    """
    name = request.args.get("name")
    if not name:
        return jsonify({"tests": []})

    project_id = request.args["project"]
    # it may run `qa batch --list` in the commit's artifacts
    if forbidden := require_project_access(None, project_id):
        return forbidden
    project = Project.get_or_create(session=db_session, id=project_id)
    data = request.get_json()
    try:
        groups = list(data["groups"])
    except Exception as e:
        return jsonify({"error": f"Invalid groups: {e}"}), 400

    # the files shared with the project, and the user's
    try:
        files = [{"source": "qaboard", "path": f"{group}.yml", "location": get_groups_path(project_id, name=group), "exists": True} for group in groups]
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    warnings = []
    ci_commit = None
    artifacts_dir = None
    commit_id = request.args.get("commit")
    if commit_id:
      try:
          ci_commit = CiCommit.query.filter(
              CiCommit.project_id == project_id,
              CiCommit.hexsha.startswith(commit_id),
          ).one()
      except NoResultFound:
          return jsonify("Sorry, the commit id was not found"), 404
      if not ci_commit.data.get("qatools_config"):
          warnings.append("QA-Board doesn't have this commit's qaboard.yaml: `qa` never told it, so it uses the project's.")
      qatools_config = deepcopy(commit_qaboard_config(ci_commit))
      artifacts_dir = ci_commit.repo_artifacts_dir
      # custom files have priority over the commit's
      files = [*commit_batches_files(ci_commit, qatools_config), *files]
    else:
      qatools_config = deepcopy(project.data.get("qatools_config", {}))

    files_batches = [(f, read_batches_file(f)) for f in files]
    defined, aliases = batch_definitions(files_batches)
    batches_paths = [f["location"] for f, batches in files_batches if batches is not None]
    print(f"[tests/group] {project_id} {commit_id} {name}: {[(f['path'], f['status']) for f in files]}", file=sys.stderr)

    def as_in_qaboard_yaml(message):
        """Errors name batch files by their path in the artifacts: show them as users wrote them."""
        for f in files:
            if f["location"]:
                message = message.replace(str(f["location"]), f["path"])
        return message

    def response(tests, missing_inputs, **extra):
        batch_warnings, definitions = batches_warnings(name, files, defined, aliases, tests, missing_inputs, artifacts_dir)
        all_warnings = [*warnings, *batch_warnings]
        for warning in all_warnings:
            print(f"[tests/group] WARNING: {warning}", file=sys.stderr)
        return jsonify({
            "tests": [{"input_path": str(t.rel_input_path), "configurations": t.configurations} for t in tests],
            "files": [{
                "source": f["source"],
                "path": f["path"],
                "location": str(f["location"]) if f["location"] else None,
                "status": f["status"],
                **{k: f[k] for k in ("error", "batches") if k in f},
            } for f in files],
            "definitions": definitions,
            "artifacts_dir": str(artifacts_dir) if artifacts_dir else None,
            "warnings": all_warnings,
            **extra,
        })

    has_custom_iter_inputs = False
    entrypoint = (qatools_config.get('project') or {}).get('entrypoint')
    if ci_commit and entrypoint:
        # TODO: make it more robust in case of "from iters import *"
        qatools_config['project']['entrypoint'] = ci_commit.repo_artifacts_dir / entrypoint
        if qatools_config['project']['entrypoint'].exists():
            with qatools_config['project']['entrypoint'].open() as f:
                entrypoint_source = f.read()
            has_custom_iter_inputs = re.search(r'^\s*(def iter_inputs\(|from .* import.* iter_inputs)', entrypoint_source, re.MULTILINE)
    if has_custom_iter_inputs:
        cwd = ci_commit.artifacts_dir
        # We run code from this folder, which comes from unauthenticated API calls
        try:
            check_storage_path(cwd)
        except UnsafePathError as e:
            return jsonify({"error": str(e)}), 400
        parent_including_cwd = [*list(reversed(list(cwd.parents))), cwd]
        envrcs = [f'source {quote(str(p / ".envrc"))}\n' for p in parent_including_cwd if (p / '.envrc').exists()]
        cmd = ' '.join([
            'qa',
            'batch',
            *list(itertools.chain.from_iterable((('--batches-file', quote(str(f))) for f in batches_paths))),
            '--list',
            '--batch=' + quote(name),
        ])
        cmd = '\n'.join([*envrcs, cmd])
        print(cmd)
        try:
            process = run_with_timeout(['bash', '-c', cmd], cwd=cwd, timeout=LIST_TESTS_TIMEOUT)
        except subprocess.TimeoutExpired:
            return jsonify({"error": f"Listing the tests with the project's code took more than {LIST_TESTS_TIMEOUT}s: QA-Board stopped it.", "cmd": str(cmd)}), 504
        except OSError as e:
            # e.g. the artifacts folder doesn't exist
            return jsonify({"error": f"Could not list the tests with the project's code: {e}", "cmd": str(cmd)}), 500
        print(process.stderr)
        try:
            process.check_returncode()
            runs = json.loads(process.stdout)
        except Exception:
            # `qa` ends with "Error: <message>" for errors it understands
            errors = re.findall(r'^Error: (.*)$', process.stderr, re.MULTILINE)
            error = errors[-1] if errors else (process.stderr[-5000:] or process.stdout[-5000:])
            return jsonify({"error": as_in_qaboard_yaml(error), "cmd": str(cmd)}), 500
        tests = [SimpleNamespace(rel_input_path=r.get("rel_input_path", r.get("input_path")), configurations=r.get("configurations", []), batch=r.get("batch")) for r in runs]
        return response(tests, missing_inputs_from_logs(process.stderr))

    # We don't need to separate the two cases, but
    # doing so might let us avoid a fork and qa startup...
    # like in qaboard/config.py
    config_inputs = qatools_config.get('inputs', {})
    config_inputs_types = config_inputs.get('types', {})
    default_input_type = config_inputs_types.get('default', 'default')
    from qaboard.conventions import get_settings
    try:
        input_settings = get_settings(default_input_type, qatools_config)
        # like in qaboard/qa.py
        from qaboard.config import get_default_configuration, get_default_database
        default_configuration = get_default_configuration(input_settings)
        default_configurations = deserialize_config(default_configuration)
        default_database = commit_database(get_default_database(input_settings, commit_interpolation_vars(project)), ci_commit)
        with recording_missing_inputs() as missing:
            tests = list(
                iter_inputs(
                    [name],                  # batches
                    batches_paths,           # batches_files,
                    default_database,        # database
                    default_configurations,  # default_configuration
                    'linux',                 # platform
                    {"type": 'lsf'},         # default_job_configuration
                    qatools_config,
                    default_inputs_settings=input_settings,
                )
            )
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        return response([], [], error=as_in_qaboard_yaml(str(e)) or f"{type(e).__name__} while listing the tests, see the server's logs")
    return response(tests, missing)


def _generate_batch_script(ci_commit, user, working_directory, command_id, batch_command, data):
    """Generate the qa_batch.sh script (shared across all runners)."""
    parent_including_cwd = [*list(reversed(list(working_directory.parents))), working_directory]
    envrcs = [f'source {quote(str(p / ".envrc"))}\n' for p in parent_including_cwd if (p / '.envrc').exists()]

    default_user = os.environ.get('QABOARD_DEFAULT_USER', 'qaboard')
    outputs_dir_prefix = str(ci_commit.outputs_dir).replace(f'/outputs/{default_user}/', f'/outputs/{user}/')
    script = "".join([
        "#!/bin/bash\n",
        # Helps users understand why they see no runs
        'trap \'echo "[qaboard] qa batch exited with code $?"\' EXIT\n',
        'export LC_ALL=en_US.utf8;\n',
        'export LANG=en_US.utf8;\n\n',
        'export MPLBACKEND=agg;\n',
        ('\n'.join(envrcs) + '\n') if envrcs else "",
        "set -xe\n\n",
        f'cd {quote(str(working_directory))};\n\n',
        f"\nexport CI=true;\n",
        f"\nexport GIT_COMMIT={quote(ci_commit.hexsha)};\n",
        # the runs are the logged-in user's
        f"export QA_USER={quote(user)};\n",

        f"export QABOARD_TUNING=true;\n\n",
        f"export QA_OUTPUTS_COMMIT={quote(outputs_dir_prefix)};\n\n",
        f"export QATOOLS_CI_COMMIT_DIR={quote(str(ci_commit.outputs_dir))};\n\n",
        f"export QA_BATCH_COMMAND_ID={quote(command_id)};\n",
        # this `qa batch` is the first: the runs of the commands it starts (e.g. pipeline steps) are its runs
        "unset QA_BATCH_ROOT_COMMAND_ID;\n\n",
        f"{batch_command};\n\n",
    ])
    return script


def _run_script(qa_batch_path, log_dir):
    """Run a bash script, appending its output to log_dir/log.txt"""
    cmd = ['bash', str(qa_batch_path)]
    print(cmd)
    with (Path(log_dir) / 'log.txt').open('a') as log:
        out = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT)
    out.check_returncode()


def _dispatch_local(qa_batch_path, log_dir):
    """Run batch script locally via subprocess."""
    _run_script(qa_batch_path, log_dir)


def _dispatch_celery(qa_batch_path, log_dir):
    """Run batch script via celery worker. Injects broker URL into script."""
    # if it's not set, `qa` uses qaboard/runners/celeryconfig.py's default (qaboard.yaml's runners.celery wins anyway)
    broker_url = os.environ.get('CELERY_BROKER_URL')
    qaboard_host = os.environ.get('QABOARD_HOST', 'localhost')
    qaboard_protocol = os.environ.get('QABOARD_PROTOCOL', 'http')

    celery_env = "".join([
        f"export QABOARD_PROTOCOL={quote(qaboard_protocol)}\n",
        f"export QABOARD_HOST={quote(qaboard_host)}\n",
        f"export CELERY_BROKER_URL={quote(broker_url)}\n" if broker_url else "",
        f"export no_proxy={quote(f'{qaboard_host},proxy,rabbitmq,qaboard')}\n",
    ])
    with qa_batch_path.open("r") as f:
        content = f.read()
    content = content.replace("#!/bin/bash\n", f"#!/bin/bash\n{celery_env}", 1)
    with qa_batch_path.open("w") as f:
        f.write(content)
    _run_script(qa_batch_path, log_dir)


def parse_bsub_job_id(output: str):
    """Returns the job ID from bsub's output: "Job <1234> is submitted to queue <normal>." """
    match = re.search(r'Job <(\d+)> is submitted', output or '')
    return match.group(1) if match else None


def _dispatch_lsf(qa_batch_path, log_dir, user, ci_commit, do_optimize):
    """
    Run batch script via LSF job submission (SSH + bsub).
    Returns {"lsf_job_id", "queue"}. The job writes its output in log_dir/log.txt, and LSF its report in log_dir/log.lsf.txt.
    """
    # TODO: We use a bridge server to submit - ideally we should use
    #       some LSF API to do it, but their docs/auth are terrible. 
    qatools_config = ci_commit.project.data.get("qatools_config", {})
    lsf_config = qatools_config.get('runners', qatools_config).get("lsf", {})
    default_queue = lsf_config.get('queue', 'default')
    queue = lsf_config.get('long_queue', 'default') if do_optimize else default_queue

    # The command given to bsub is parsed again by a shell on the execution host, so it's quoted twice
    job_command = f'bash {quote(str(qa_batch_path))} &>> {quote(f"{log_dir}/log.txt")}'
    start_script = "\n".join([
        "#!/bin/bash",
        "set -xe",
        "",
        f'mkdir -p {quote(str(log_dir))}',
        f'bsub -q {quote(str(queue))} -o {quote(f"{log_dir}/log.lsf.txt")} -sp 4000 {quote(job_command)}',
    ])
    print(start_script)

    start_path = log_dir / "start.sh"
    with start_path.open("w") as f:
        f.write(start_script)

    # raises if the user or path are not safe to use in the LSF bridge
    cmd = lsf_bridge_command(user, start_path)
    print(cmd)
    out = subprocess.run(cmd, shell=True, encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(out.stdout)
    if out.returncode != 0:
        # Users see this log in QA-Board
        with (log_dir / 'log.txt').open('a') as log:
            log.write(f"ERROR: Could not submit the job to LSF (exit code {out.returncode}):\n{out.stdout}\n")
    out.check_returncode()
    return {"lsf_job_id": parse_bsub_job_id(out.stdout), "queue": queue}


def find_commit(project_id, hexsha):
    return (CiCommit.query
            .filter(CiCommit.project_id == project_id, CiCommit.hexsha.startswith(hexsha))
            .order_by(CiCommit.id)
            .first())


def load_batches(ci_commit, project_id, groups):
    """
    Merges the batches defined in the commit's batches files and in the custom groups, to check them.
    Returns (merged_batches, errors, defined, files): `defined` says which files define each batch, see batch_definitions(),
    and `files` are the files we could read, in the order `qa batch` should read them.
    """
    errors = []
    # the commit's files as in its qaboard.yaml, the custom groups as users see them in QA-Board
    files = [f for f in commit_batches_files(ci_commit, commit_qaboard_config(ci_commit)) if f["exists"]]
    for group in groups:
        try:
            files.append({"source": "qaboard", "path": f"{group}.yml", "location": get_groups_path(project_id, name=group), "exists": True})
        except ValueError as e:
            errors.append(str(e))
    merged_batches: Dict[str, Any] = {}
    files_batches = []
    for batches_file in files:
        batches = read_batches_file(batches_file)
        if batches is None:
            errors.append(f"Could not read the batches in {batches_file['path']}: {batches_file.get('error', 'it should define a mapping of batches')}")
            continue
        files_batches.append((batches_file, batches))
        merged_batches = merge(batches, merged_batches)
    merged_batches['aliases'] = merged_batches.get('aliases', merged_batches.get('groups', {})) or {} # backward-compat
    defined, _ = batch_definitions(files_batches)
    return merged_batches, errors, defined, [f for f, _ in files_batches]


def pipeline_batches(batches, merged_batches):
    # FIXME:  handle pipelines. replace with a generic solution.
    for b in list(batches):
        batch_context = merged_batches.get(b, {}) or {}
        if not isinstance(batch_context, dict) or batch_context.get('type', " ") != 'pipeline':
            continue
        for key in batch_context.keys():
            if key.lower() in ['configuration', 'configurations', 'configs']:
                for step in batch_context.get(key, []) or []:
                    if isinstance(step, dict) and 'batch' in step.keys():
                        step_config = step.get('batch')
                        if isinstance(step_config, str): batches.append(step_config)
                        elif isinstance(step_config, list): batches = batches + [b for b in step_config if isinstance(b, str)]
                        batches = list(resolve_aliases(batches, merged_batches['aliases']))
    return batches


def copy_batches_files(files, log_dir):
    """
    Copies the batch files to the submission's folder, to know later what ran, and to run it again.
    `qa batch` reads the copies like the files on a commit: in the same order, with their file-level defaults.
    They keep their paths, e.g. batches/commit/qa/tests.yaml or batches/qaboard/alice.yml, so that errors name them.
    Returns the paths of the copies.
    """
    copies = []
    for batches_file in files:
        # the paths come from qaboard.yaml: they can be absolute, or go up
        parts = [part for part in Path(batches_file["path"]).parts if part not in ("/", "..", ".")]
        copy = Path(log_dir) / "batches" / batches_file["source"] / Path(*parts)
        if copy in copies:
            copy = copy.with_name(f"{len(copies)}-{copy.name}")
        copy.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(batches_file["location"], copy)
        copies.append(copy)
    return copies


def check_tuning_search(tuning_search) -> list:
    if not isinstance(tuning_search, dict):
        return ["The tuning parameters are missing."]
    search_type = tuning_search.get('search_type', 'grid')
    parameter_search = tuning_search.get('parameter_search')
    if search_type == 'optimize':
        try:
            optim_config = yaml.load(parameter_search or '', Loader=yaml.SafeLoader)
        except Exception as e:
            return [f"The automated tuning configuration is not valid YAML: {e}"]
        if not isinstance(optim_config, dict):
            return ["The automated tuning configuration should be a YAML mapping, with an `objective`, an `evaluations` budget and a `search_space`."]
        # the same checks as `qa optimize`, with the same messages
        from qaboard.optimization import check_config
        return check_config(optim_config)
    if search_type not in ('grid', 'sampler'):
        return [f"Unknown search type: {search_type}"]
    if parameter_search is None:
        return []
    params = parameter_search if isinstance(parameter_search, list) else [parameter_search]
    if not all(isinstance(p, dict) for p in params):
        return ["The tuning parameters should be a mapping of parameters to the values to try, or a list of them."]
    return []


def check_tuning_request(ci_commit, data):
    """
    Checks a request to run a batch from QA-Board, before we start anything.
    Returns {errors, warnings, artifacts, batches, definitions, batches_files}: with errors we don't start.
    `definitions` says in which files the batches that would run are defined: [{"name", "files"}].
    """
    from .commit import commit_artifacts_info
    errors, warnings = [], []
    data = data or {}
    project_config = ci_commit.project.data.get("qatools_config")
    config = ci_commit.data.get("qatools_config") or project_config
    if not config:
        errors.append("QA-Board doesn't know this project's configuration: run `qa save-artifacts` or `qa batch` on this commit, with qaboard.yaml.")
        config = {}

    label = str(data.get('batch_label') or '').strip()
    if not label:
        errors.append("Give a name to the batch.")
    elif label in ('default',) and data.get('tuning_search', {}).get('search_type') == 'optimize':
        warnings.append("Automated tuning creates one batch per iteration: give it a more specific name than \"default\".")

    platforms = config.get('inputs', {}).get('platforms') if isinstance(config.get('inputs'), dict) else None
    if isinstance(platforms, list):
        # the web app shows them as {name, label}
        platforms = [str(p.get('name')) if isinstance(p, dict) else str(p) for p in platforms]
        if data.get('platform') and platforms and str(data['platform']) not in platforms:
            errors.append(f"Unknown platform {data['platform']!r}. Available in qaboard.yaml: {', '.join(platforms)}")

    errors.extend(check_tuning_search(data.get('tuning_search')))

    artifacts = commit_artifacts_info(ci_commit)
    if not artifacts["ok"]:
        problems = " ".join(artifacts.get("problems", []))
        if artifacts.get("recreate") and not artifacts.get("recreate_errors"):
            warnings.append(f"The artifacts are missing: {problems} When you start, QA-Board will first ask {artifacts['recreate']} to recreate them.")
        else:
            warnings.append(f"The artifacts are missing: {problems} When you start, QA-Board will try to restore them from the source code, but not build outputs (e.g. binaries).")
    # e.g. files listed in the manifests are missing: the runs may not need them
    warnings.extend(f"{w} Runs that need them will fail." for w in artifacts.get("warnings", []))
    for error in artifacts.get("recreate_errors", []):
        warnings.append(f"qaboard.yaml: {error}")

    entrypoint = config.get('project', {}).get('entrypoint') if isinstance(config.get('project'), dict) else None
    if entrypoint and artifacts["ok"] and not (ci_commit.repo_artifacts_dir / entrypoint).exists():
        warnings.append(f"The project's entrypoint ({entrypoint}) is not in the artifacts: runs will likely fail. Check `artifacts` in qaboard.yaml.")

    batches, definitions, batches_files = [], [], []
    selected_group = str(data.get('selected_group') or '').strip()
    groups = data.get('groups') or []
    if not isinstance(groups, list):
        errors.append("`groups` should be a list.")
        groups = []
    if not selected_group:
        errors.append("Select the batch of inputs to run on.")
    else:
        merged_batches, batches_errors, defined, batches_files = load_batches(ci_commit, ci_commit.project_id, groups)
        warnings.extend(batches_errors)
        batches = list(resolve_aliases(selected_group, merged_batches['aliases']))
        batches = pipeline_batches(batches, merged_batches)
        definitions, _ = definitions_of(batches, defined)
        # `qa batch` also accepts wildcards (batch-*), and input paths (semi-deprecated)
        unknown = [b for b in batches if b not in defined and not fnmatch.filter(defined, b)]
        as_inputs = [b for b in unknown if '/' in b or '.' in b]
        unknown = [b for b in unknown if b not in as_inputs]
        if as_inputs:
            warnings.append(f"Not defined as batches, so they will be used as input paths: {', '.join(as_inputs)}")
        if unknown and not artifacts["ok"]:
            # the batches files are in the artifacts: starting restores them first, then checks again
            warnings.append(f"Can't check the batch {', '.join(unknown)} until the artifacts are back.")
        elif unknown:
            names = sorted(defined)
            hint = f" Defined: {', '.join(names[:20])}{'...' if len(names) > 20 else ''}" if names else " No batches are defined: check `inputs.batches` in qaboard.yaml, and that the batches files are in the artifacts."
            errors.append(f"Unknown batch{'es' if len(unknown) > 1 else ''}: {', '.join(unknown)}.{hint}")
    return {
        "errors": errors,
        "warnings": warnings,
        "artifacts": artifacts,
        "batches": batches,
        "definitions": definitions,
        "batches_files": batches_files,
    }


@app.route("/api/v1/commit/<hexsha>/batch/check", methods=["POST"], strict_slashes=False)
@login_required
def check_tuning(hexsha):
    """Validates a request to start a batch, without starting it. Returns {errors, warnings, artifacts}."""
    project_id = request.args["project"]
    ci_commit = find_commit(project_id, hexsha)
    if not ci_commit:
        return jsonify({"error": f"Commit {hexsha} was not found in {project_id}", "errors": [f"Commit {hexsha} was not found in {project_id}"], "warnings": []}), 404
    check = check_tuning_request(ci_commit, request.get_json())
    return jsonify({k: v for k, v in check.items() if k in ("errors", "warnings", "artifacts", "batches", "definitions")})


@app.route("/api/v1/commit/<hexsha>/batch", methods=["POST"], strict_slashes=False)
@login_required
def start_tuning(hexsha):
    """
    Request that we run extra tests for a given project.
    """
    project_id = request.args["project"]
    data = request.get_json()

    if forbidden := require_project_access(None, project_id):
        return forbidden
    # We run as the logged-in user, ignoring data['user']
    try:
        user = safe_user_name(g.user['user_name'])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    ci_commit = find_commit(project_id, hexsha)
    if not ci_commit:
        return jsonify({"error": f"Commit {hexsha} was not found in {project_id}"}), 404

    check = check_tuning_request(ci_commit, data)
    restored_message = None
    if not check["artifacts"]["ok"]:
        # We never run from missing artifacts: e.g. without its qaboard.yaml, a subproject's runs would be saved in the parent project
        try:
            restored = ci_commit.ensure_artifacts(user=g.user)
        except ArtifactsUnavailable as e:
            db_session.add(ci_commit)
            db_session.commit()
            return jsonify(e.to_dict()), 409
        db_session.add(ci_commit)
        db_session.commit()
        # the batches files come from the artifacts
        restored_message = restored["message"] if restored else None
        check = check_tuning_request(ci_commit, data)
    if check["errors"]:
        return jsonify({"error": " ".join(check["errors"]), "errors": check["errors"], "warnings": check["warnings"]}), 400

    # Now that we updated the last_output_datetime, the artifacts won't be deleted again until a little while
    ci_commit.latest_output_datetime = datetime.datetime.now(datetime.timezone.utc)
    batch = ci_commit.get_or_create_batch(data['batch_label'])
    db_session.add(ci_commit)
    db_session.commit()

    # We store in this directory the scripts used to run this new batch, as well as the logs
    # We may instead want to use the folder where this batch's results are stored
    # Or even store the metadata in the database itself...

    # FIXME: if the output directory includes "{user}", we will use the current user (qaboard)
    # but it's likely better to use the user that requested the tuning
    batch_dir = user_batch_dir(batch.batch_dir, user)
    # We write scripts in the batch's folder, and run code from the artifacts folder
    try:
        check_storage_path(batch_dir)
        check_storage_path(ci_commit.artifacts_dir)
    except UnsafePathError as e:
        return jsonify({"error": str(e)}), 400
    if not batch.batch_dir_override:
        batch.batch_dir_override = str(batch_dir)
        db_session.add(batch)
        db_session.commit()

    mkdir_for_everyone(batch_dir)

    command_id = str(uuid.uuid4())
    # Each batch started from QA-Board has its own scripts and logs
    created_at = datetime.datetime.utcnow()
    log_dir = submission_dir(batch_dir, created_at, command_id)
    mkdir_for_everyone(log_dir)
    batches_files = copy_batches_files(check["batches_files"], log_dir)

    working_directory = ci_commit.artifacts_dir
    print(working_directory)

    # This will make us do automated tuning, versus a single manual batch
    do_optimize = data['tuning_search']['search_type'] == 'optimize'
    if do_optimize:
        # we write somewhere the optimization search configuration
        # it needs to be accessed from LSF so we can't use temporary files...
        config_path = batch_dir / 'optim-config.yaml'
        # qa optimize saves the search there as it goes, and resumes from it when the experiment starts again
        checkpoint_path = batch_dir / 'optuna-journal.log'
        config_option = f"--config-file {quote(str(config_path))} --checkpoint {quote(str(checkpoint_path))}"
        with config_path.open("w") as f:
            f.write(data['tuning_search']['parameter_search'])
    else:
        config_option = f"--tuning-search {quote(json.dumps(data['tuning_search']))}"

    overwrite = "--action-on-existing run" if data["overwrite"] in ("on", True) else "--action-on-existing sync"
    batch_command = " ".join([
        "qa",
        f"--platform {quote(str(data['platform']))}" if "platform" in data else "",
        f"--label {quote(str(data['batch_label']))}",
        "optimize" if do_optimize else "batch",
        *(f"--batches-file {quote(str(path))}" for path in batches_files),
        f"--batch {quote(str(data['selected_group']))}",
        # f"--runner=local", # uncomment if testing from Samsung SIRC where LSF is the default
        config_option,
        f"{overwrite} --no-wait" if not do_optimize else '',
    ])
    print(batch_command)

    qa_batch_script = _generate_batch_script(ci_commit, user, working_directory, command_id, batch_command, data)
    print(qa_batch_script)
    qa_batch_path = log_dir / "qa_batch.sh"
    with qa_batch_path.open("w") as f:
        f.write(qa_batch_script)

    runner = os.environ.get('QABOARD_TUNING_RUNNER', 'local')
    submission = {
        "id": command_id,
        "created_at": created_at.isoformat() + 'Z',
        "user": user,
        "runner": runner,
        "command": batch_command,
        "log_dir": str(log_dir),
        # where the batches are defined: the command reads copies of the batch files
        "batch": data['selected_group'],
        "definitions": check["definitions"],
        # local/celery: we wait for `qa batch` (it uses --no-wait), LSF: `qa batch` is an LSF job
        "status": "submitting",
    }
    record_submission(batch, submission)
    db_session.add(batch)
    db_session.commit()

    # Before we start: with the local runner, runs can end before the dispatch returns
    notification = notify_when_done(data, command_id, ci_commit, batch, user, do_optimize)

    try:
        if runner == 'lsf':
            submission.update(_dispatch_lsf(qa_batch_path, log_dir, user, ci_commit, do_optimize))
            submission["status"] = "submitted"
        elif runner == 'celery':
            _dispatch_celery(qa_batch_path, log_dir)
            submission.update({"status": "done", "exit_code": 0})
        else:
            _dispatch_local(qa_batch_path, log_dir)
            submission.update({"status": "done", "exit_code": 0})
    except Exception as e:
        submission["status"] = "failed"
        if isinstance(e, subprocess.CalledProcessError):
            submission["exit_code"] = e.returncode
        else:
            submission["error"] = str(e)
    # `qa batch` may have updated the batch meanwhile
    db_session.refresh(batch)
    record_submission(batch, submission)
    db_session.add(batch)
    db_session.commit()

    if submission["status"] == "failed":
        cancel_batch_notification(db_session, command_id, "The batch failed to start")
        error_log = (log_dir / 'log.txt').read_text() if (log_dir / 'log.txt').exists() else submission.get("error", "Failed to start batch")
        return jsonify({"error": error_log, "cmd": runner, "submission": submission}), 500
    return jsonify({"cmd": runner, "stdout": "OK", "submission": submission, "warning": restored_message, "notification": notification})


def notify_when_done(data, command_id, ci_commit, batch, user, do_optimize):
    """
    We email users when the batch's runs end (for now everyone gets them, clients can send notify: false).
    Returns what the web app tells users: {"channel", "recipient"} or {"error"}, or None without email.
    """
    if data.get('notify', 'email') not in ('email', True):
        return None
    if do_optimize:
        # not supported yet: its iterations are separate batches, between them no runs are pending
        return None
    notification, error = request_batch_notification(
        db_session, command_id, ci_commit, batch, user,
        email=g.user.get('email'),
        data={
            "source": "webapp",
            "label": data['batch_label'],
            "selected_group": data.get('selected_group'),
            "platform": data.get('platform'),
        },
    )
    if error:
        return {"error": error}
    return {"channel": "email", "recipient": notification.recipient}
