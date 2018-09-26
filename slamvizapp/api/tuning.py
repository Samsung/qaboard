"""
APIs related to parameter tuning
"""
import subprocess
import json
import datetime
from pathlib import Path

from flask import request, jsonify
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import app, repos, db_session
from ..models import CiCommit, Project
from ..utils import iter_recordings
from ..config import shared_data_directory


def get_groups_path(project_id):
    """
    Return the path of the file where we save the groups of tests we defined for a project.
    Creates it if it does not exist yet.
    """
    path = shared_data_directory / project_id / "extra-batches.yml"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w") as f:
            f.write(
                """
                # you can define groups of tests using this syntax:
                # http://gitlab-srv/common-infrastructure/qatools/blob/master/qatools/sample_project/qatools/input_groups.yaml"""
            )
    return path


@app.route("/api/v1/tests/groups", methods=["GET", "POST"])
def groups():
    """
    Return or update the groups of tests we defined for a project.
    TODO: We could just make it part of the database, why bother with files...
          It could be saved as test as project.informations.test_groups
          We would *just* need to write the migration, and it would save 30 lines of code.
    """
    project_id = request.args.get("project", "dvs/psp_swip")
    groups_path = get_groups_path(project_id)
    if request.method == "POST":
        data = request.get_json()
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


@app.route("/api/v1/tests/group")
def get_group():
    project_id = request.args.get("project", "dvs/psp_swip")
    project = Project.get_or_create(session=db_session, id=project_id)
    groups_path = get_groups_path(project_id)
    try:
        # FIXME: use qatools for those projects, and remove this code
        # that does the same (but with a different signature, and doesn't parse per-test config)
        is_legacy_project = project_id in ["dvs/psp_swip", "tof/swip_tof"]
        if is_legacy_project:
            tests = list(
                iter_recordings(
                    [request.args.get("name", "")],
                    groups_path,
                    project.database,
                )
            )
        else:
            import qatools.utils

            test = [request.args.get("name", "")]
            tests = list(
                qatools.utils.iter_recordings(
                    [request.args.get("name", "")],
                    groups_path,
                    project.database,
                    project.information["qatools_config"]["inputs"]["configuration"],
                    project.information["qatools_config"],
                )
            )
        return jsonify({"number_of_tests": len(tests)})
    except:
        return jsonify({"number_of_tests": 0})


@app.route("/api/v1/commit/<hexsha>/batch", methods=["POST"])
@app.route("/api/v1/commit/<hexsha>/batch", methods=["POST"])
def add_batch(hexsha):
    """
    Request that we run extra tests for a given project.
    """
    project_id = request.args.get("project", "dvs/psp_swip")
    project_dir = shared_data_directory / project_id

    now = datetime.datetime.now()
    # We store in this directory the scripts used to run this new batch, as well as the logs
    # We may instead want to use the folder where this batch's results are stored
    # Or even store the metadata in the database itself...
    batch_dir = project_dir / ci_commit.gitcommit.hexsha / now.isoformat()
    if not batch_dir.exists(): batch_dir.mkdir(exist_ok=True, parents=True)

    try:
        commit = repos[project_id].commit(hexsha)
        ci_commit = CiCommit.query.filter(
            CiCommit.project_id == project_id, CiCommit.id.startswith(hexsha)
        ).one()
    except NoResultFound:
        return jsonify("Sorry, the commit id was not found"), 404

    is_legacy_project = project_id in ["dvs/psp_swip", "tof/swip_tof"]
    if "qatools_config" not in ci_commit.project.information and not is_legacy_project:
        return jsonify("Please configure `qatools first`"), 404

    groups_path = get_groups_path(project_dir)

    ci_commit.time_of_last_batch = now.astimezone()
    db_session.add(ci_commit)
    db_session.commit()

    data = request.get_json()

    overwrite = "--overwrite" if data["overwrite"] == "on" else ""
    if is_legacy_project:
        batch_command = " ".join(
            [
                "python tools/performance-evaluation/run.py",
                f"--platform '{data['platform']}'" if "platform" in data else "",
                f"--configuration '{data['configuration']}'"
                if "configuration" in data
                else "",
                f"--batch-label '{data['batch_label']}'",
                "batch",
                f"--recording-groups-file {groups_path}",
                f"--recording-group '{data['selected_group']}'",
                f"--tuning-search '{json.dumps(data['tuning_search'])}'",
                f"{overwrite}",
                f"--no-wait",
                "\n",
            ]
        )
        working_directory = (
            ci_commit.project.ci_directory
            / project_id
            / "branches"
            / "develop"
            / project_id.split("/")[1]
        )
    else:
        config = ci_commit.project.information["qatools_config"]
        working_directory = ci_commit.commit_dir

        # This will make us do automated tuning, versus a single manual batch
        do_optimize = data['tuning_search']['search_type'] == 'optimize'
        if do_optimize:
            # we write somewhere the optimzation search configuration
            # it needs to be accessed from LSF so we can't use temporary files...
            config_path = batch_dir / 'optim-config.yaml'
            config_option = f"--config-file {config_path}"
            with config_path.open("w") as f:
                f.write(data['tuning_search']['parameter_search'])
        else:
            config_option = f"--tuning-search '{json.dumps(data['tuning_search'])}'"

        batch_command = " ".join(
            [
                "qa",
                f"--platform '{data['platform']}'" if "platform" in data else "",
                f"--configuration '{data['configuration']}'" if "configuration" in data else "",
                f"--batch-label '{data['batch_label']}'",
                "optimize" if do_optimize else "batch",
                f"--groups-file {groups_path}",
                f"--group '{data['selected_group']}'",
                config_option,
                f"{overwrite} --no-wait" if not do_optimize else '',
                "\n",
            ]
        )
    print(working_directory)
    print(batch_command)


    # To avoid issues with quoting, we write a script to run the batch,
    # and execute it with bsub/LSF 
    # We could also play with heredocs-within-heredocs, but it is painful, and this way we get logs
    queue = "alg_q" if is_legacy_project else ci_commit.project.information["qatools_config"]["lsf"]["fast_queue"]
    # openstf is our Android device farm
    use_openstf = data["android_device"].lower() == "openstf"
    batch_script = "".join(
        [
            "#!/bin/bash\n",
            f'bsub_su {data.get("user", "arthurf")} -q {queue} -sp 4000 ',  # highest priority
            f"-o {project_dir}/lsf.log ",
            "<< EOF\n" f'  cd "{working_directory}";\n',
            # options specific to android
            f"  export RESERVED_ANDROID_DEVICE='{data['android_device']}';\n" if not use_openstf else "",
            f"  export OPENSTF_STORAGE_QUOTA=12;\n" if not use_openstf else "",
            # Make sure qatools doesn't complain about not being in a git repository,
            f"  export CI_COMMIT_SHA='{ci_commit.gitcommit.hexsha}';\n",
            # Make sure qatools knows where to save results
            f"  export {'SAMSUNG_CI_COMMIT_DIR' if is_legacy_project else 'QATOOLS_CI_COMMIT_DIR'}='{ci_commit.commit_dir}';\n  ",
            batch_command,
            "EOF",
        ]
    )
    print(batch_script)

    script_path = batch_dir / f"run.sh"
    with script_path.open("w") as f:
        f.write(batch_script)

    # Wraps and execute the script that starts the batch
    cmd = " ".join(
        [
            "ssh",
            # quiet to avoid the welcome banner
            "-q",
            # ask, and force a TTY, otherwise bsub->su will complain
            "-tt",
            # make sure we OK the server key during the first-connection
            "-o StrictHostKeyChecking=no",
            # ispq is the only user that can use bsub_su, an alias for su {0} {1:}.
            "-i /home/arthurf/.ssh/ispq.id_rsa",
            "ispq@planet31",
            f'bash "{script_path}"',
        ]
    )
    print(cmd)

    try:
        out = subprocess.run(cmd, shell=True, encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out.check_returncode()
    except subprocess.CalledProcessError:
        return jsonify({"error": f"{out.stdout}\n{out.stderr}"}), 500
    return jsonify({"script": str(script_path)})
