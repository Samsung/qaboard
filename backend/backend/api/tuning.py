"""
APIs related to parameter tuning
"""
import re
import os
import sys
import json
import uuid
import getpass
import datetime
import itertools
import subprocess
from pathlib import Path
from typing import Dict, Any

import yaml
from flask import request, jsonify
from sqlalchemy.orm.exc import NoResultFound

from qaboard.utils import merge
from qaboard.iterators import iter_inputs, resolve_aliases
from qaboard.conventions import deserialize_config, batches_files

from backend import app, db_session
from ..models import CiCommit, Project
from ..config import qaboard_data_shared_dir


def get_groups_path(project_id, name="extra-batches"):
    """
    Return the path of the file where we save the groups of tests we defined for a project.
    Creates it if it does not exist yet.
    """
    path = qaboard_data_shared_dir / project_id / f"{name}.yml"
    if not path.exists():
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
    groups_path = get_groups_path(project_id, name=name)
    if request.method == "POST":
        data = request.get_json()
        try:
          yaml.load(data["groups"], Loader=yaml.SafeLoader)
        except Exception as e:
          return jsonify(str(e)), 400
        with groups_path.open("w") as f:
            f.write(data["groups"])
        return jsonify("OK")
    else:
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


def get_commit_batches_paths(project, commit_id):
  batches_paths = []
  try:
    ci_commit = CiCommit.query.filter(
        CiCommit.project_id == project.id, CiCommit.hexsha.startswith(commit_id)
    ).one()
    commit_config = ci_commit.data.get('qatools_config', {})
    commit_group_files = batches_files(commit_config, None, Path(project.id), Path(project.id_relative), ci_commit.repo_artifacts_dir)
    print(commit_group_files, file=sys.stderr)

    # custom groups have priority over the commit's groups
    for group_file in commit_group_files:
      if (ci_commit.repo_artifacts_dir / group_file).exists():
        batches_paths.insert(0, ci_commit.repo_artifacts_dir / group_file)
    return batches_paths
  except NoResultFound:
    return []


@app.route("/api/v1/tests/group", methods=["POST"])
def get_group():
    if not request.args["name"]:
        return jsonify({"tests": []})

    project_id = request.args["project"]
    project = Project.get_or_create(session=db_session, id=project_id)
    data = request.get_json()
    try:
        groups = list(data["groups"])
    except Exception as e:
        return jsonify(str(e)), 400

    message = None
    batches_paths = [get_groups_path(project_id, name=group) for group in groups]
    commit_id = request.args.get("commit")
    if commit_id:
      commit_batches_paths = get_commit_batches_paths(project, commit_id)
      if not commit_batches_paths:
        message = "<p>Could not load the <code>inputs.batches</code> files defined in <em>qaboard.yaml</em>.</p><p>For tuning to work, <code>qa save-artifacts</code> needs to be called.</p>"
      batches_paths = [*commit_batches_paths, *batches_paths]
      try:
          ci_commit = CiCommit.query.filter(
              CiCommit.project_id == project_id,
              CiCommit.hexsha.startswith(commit_id),
          ).one()
      except NoResultFound:
          return jsonify("Sorry, the commit id was not found"), 404
      qatools_config = ci_commit.data.get("qatools_config", {})
    else:
      qatools_config = project.data.get("qatools_config", {})


    has_custom_iter_inputs = False
    # TODO: make it more robust in case of "from iters import *"
    qatools_config['project']['entrypoint'] = ci_commit.repo_artifacts_dir / qatools_config['project']['entrypoint']
    if qatools_config['project']['entrypoint'].exists():
        with qatools_config['project']['entrypoint'].open() as f:
            entrypoint_source = f.read()
        has_custom_iter_inputs = re.search(r'^\s*(def iter_inputs\(|from .* import.* iter_inputs)', entrypoint_source, re.MULTILINE)
    # prpject fallback?
    if has_custom_iter_inputs:
        cwd = ci_commit.artifacts_dir
        parent_including_cwd = [*list(reversed(list(cwd.parents))), cwd]
        envrcs = [f'source "{p}/.envrc"\n' for p in parent_including_cwd if (p / '.envrc').exists()]
        cmd = ' '.join([
            'qa',
            'batch',
            *list(itertools.chain.from_iterable((('--batches-file', f'"{f}"') for f in batches_paths))),
            '--list',
            request.args["name"],
        ])
        cmd = '\n'.join([*envrcs, cmd])
        print(cmd)
        try:
            process = subprocess.run(
                ['bash', '-c', cmd],
                cwd=cwd,
                encoding="utf-8",
                capture_output=True,
            )
            # print(cmd)
            # print(process.stdout)
            print(process.stderr)
            process.check_returncode()
        except:
            return jsonify({"error": str(process.stdout), "cmd": str(cmd)}), 500
        return jsonify({"tests": json.loads(process.stdout), "message": message})

    # We don't need to seperate the two cases, but
    # doing so might let us avoid a fork and qa startup...
    # like in qaboard/config.py
    config_inputs = qatools_config.get('inputs', {})
    config_inputs_types = config_inputs.get('types', {})
    default_input_type = config_inputs_types.get('default', 'default')
    from qaboard.conventions import get_settings
    input_settings = get_settings(default_input_type, qatools_config)
    # like in qaboard/qa.py
    from qaboard.config import get_default_configuration, get_default_database
    default_configuration = get_default_configuration(input_settings)
    default_configurations = deserialize_config(default_configuration)
    default_database = get_default_database(input_settings)
    # print('group', request.args["name"], batches_paths)
    try:
        tests = list(
            iter_inputs(
                [request.args["name"]], # batches
                batches_paths,           # batches_files,
                default_database,       # database
                default_configurations,  # default_configuration
                'lsf',                # platform
                {"type": 'lsf'},        # default_job_configuration
                qatools_config,
                default_inputs_settings=input_settings,
            )
        )
        return jsonify({
            "tests": [{"input_path": str(run_context.rel_input_path), "configurations": run_context.configurations} for run_context in tests],
            "message": message,
        })
    except Exception as e:
        print(f'Error: {e}')
        return jsonify({"tests": [], "error": str(e)})


@app.route("/api/v1/commit/<hexsha>/batch", methods=["POST"], strict_slashes=False)
def start_tuning(hexsha):
    """
    Request that we run extra tests for a given project.
    """
    project_id = request.args["project"]
    data = request.get_json()

    # TODO: use the logged-in user
    user = data['user']
    try:
        ci_commit = CiCommit.query.filter(
            CiCommit.project_id == project_id,
            CiCommit.hexsha.startswith(hexsha)
        ).one()
    except NoResultFound:
        return jsonify("Sorry, the commit id was not found"), 404

    if "qatools_config" not in ci_commit.project.data:
        return jsonify("Please create `qaboard.yaml`"), 404

    ci_commit.latest_output_datetime = datetime.datetime.now()
    ci_commit.latest_output_datetime = datetime.datetime.now()
    batch = ci_commit.get_or_create_batch(data['batch_label'])
    db_session.add(ci_commit)
    db_session.commit()

    if ci_commit.deleted:
        # Now that we updated the last_output_datetime, it won't be deleted again until a little while
        return jsonify("Artifacts for this commit were deleted! Re-run your CI pipeline, or `git checkout / build / qa --ci save-artifacts`"), 404
 
    try:
        groups = list(data["groups"])
    except Exception as e:
        return jsonify(str(e)), 400

    commit_batches_paths = get_commit_batches_paths(ci_commit.project, hexsha)
    batches_paths = [get_groups_path(project_id, name=group) for group in groups]
    batches_paths = [*commit_batches_paths, *batches_paths]
    merged_batches : Dict[str, Any] = {}
    for c in batches_paths:
        with c.open() as f:
            c_dict = yaml.load(f, Loader=yaml.SafeLoader)
        merged_batches = merge(c_dict, merged_batches)
    available_batches: Dict = {}
    batches = str(data['selected_group'])
    # TODO: filter the aliases, but it requires care in case of multiple levels of aliases...
    if merged_batches and isinstance(merged_batches, dict):
      available_batches['aliases'] = merged_batches.get('aliases', merged_batches.get('groups', {}))
    batch_aliases = available_batches.get('aliases', {})
    batches = list(resolve_aliases(batches, batch_aliases)) # type: ignore
    merged_batches = { key:value for (key,value) in merged_batches.items() if key in ['aliases', 'groups', 'database', *batches]}

    # We store in this directory the scripts used to run this new batch, as well as the logs
    # We may instead want to use the folder where this batch's results are stored
    # Or even store the metadata in the database itself...
    prev_mask = os.umask(000)

    batch_dir = batch.batch_dir
    # FIXME: if the output directory includes "{user}", we will use the current user (qaboard) to do the run
    # but it's likely better to use the user that requested the tuning... in depends on the job scheduler capabilities
    batch_dir = Path(str(batch_dir).replace('/outputs/qaboard/', f'/outputs/{user}/'))
    if not batch.batch_dir_override:
        batch.batch_dir_override = str(batch_dir)
        db_session.add(batch)
        db_session.commit()

    if not batch_dir.exists():
        batch_dir.mkdir(exist_ok=True, parents=True)
    os.umask(prev_mask)

    command_id = str(uuid.uuid4())
    merged_batches_path = f'{batch_dir}/batches-{command_id[:8]}.yaml'
    with Path(merged_batches_path).open('w') as f:
        f.write(yaml.dump(merged_batches))

    working_directory = ci_commit.artifacts_dir
    print(working_directory)

    # This will make us do automated tuning, versus a single manual batch
    do_optimize = data['tuning_search']['search_type'] == 'optimize'
    if do_optimize:
        # we write somewhere the optimzation search configuration
        # it needs to be accessed from LSF so we can't use temporary files...
        config_path = batch_dir / 'optim-config.yaml'
        config_option = f"--config-file '{config_path}'"
        with config_path.open("w") as f:
            f.write(data['tuning_search']['parameter_search'])
    else:
        config_option = f"--tuning-search '{json.dumps(data['tuning_search'])}'"

    overwrite = "--action-on-existing run" if data["overwrite"] in ("on", True) else "--action-on-existing sync"
    batch_command = " ".join([
        "qa",
        f"--platform '{data['platform']}'" if "platform" in data else "",
        f"--label '{data['batch_label']}'",
        "optimize" if do_optimize else "batch",
        f'--batches-file {merged_batches_path} '
        f"--batch '{data['selected_group']}'",
        # f"--runner=local", # uncomment if testing from Samsung SIRC where LSF is the default
        config_option,
        f"{overwrite} --no-wait" if not do_optimize else '',
    ])
    print(batch_command)

    # To avoid issues with quoting, we write a script to run the batch,
    # and execute it with bsub/LSF
    # We could also play with heredocs-within-heredocs, but it is painful, and this way we get logs
    # openstf is our Android device farm
    use_openstf = data["android_device"].lower() == "openstf"
    parent_including_cwd = [*list(reversed(list(working_directory.parents))), working_directory]
    envrcs = [f'source "{p}/.envrc"\n' for p in parent_including_cwd if (p / '.envrc').exists()]
    qa_batch_script = "\n".join([
        "#!/bin/bash",
        # qa uses click, which hates non-utf8 locales
        'export LC_ALL=C.UTF-8',
        'export LANG=C.UTF-8',
        "",
        # Avoid common DISPLAY issues with matplotlib, since we're headless here
        'export MPLBACKEND=agg',
        # Load all .envrc files relevant for the (sub)project
        ('\n'.join(envrcs) + '\n') if envrcs else "",
        "set -xe",
        f'cd "{working_directory}"',
        "",
        "",
        # Make sure QA-Board doesn't complain about not being in a git repository and knows where to save results
        f"export CI=true",
        f"export QABOARD_TUNING=true",
        f"export QA_BATCH_COMMAND_ID='{command_id}';\n\n",
        f"export GIT_COMMIt='{ci_commit.hexsha}'",
        # Make sure QA-Board doesn't complain about not being in a git repository and knows where to save results
        f"export QA_OUTPUTS_COMMIT='{str(ci_commit.commit_dir).replace('/outputs/qaboard/', f'/outputs/{user}/')}'",
        "",
        batch_command,
        "",
    ])
    print(qa_batch_script)
    qa_batch_path = batch_dir / f"qa_batch.sh"
    with qa_batch_path.open("w") as f:
        f.write(qa_batch_script)

    batch.output_dir.mkdir(parents=True, exist_ok=True)
    cmd = ['bash', '-c', f'"{qa_batch_path}" &>> "{batch.batch_dir}/log.txt"']
    print(cmd)
    try:
        out = subprocess.run(cmd, encoding='utf-8')
        out.check_returncode()
    except:
        return jsonify({"error": (batch.batch_dir/'log.txt').read_text(), "cmd": str(cmd)}), 500
    return jsonify({"cmd": str(cmd), "stdout": str(out.stdout)})
