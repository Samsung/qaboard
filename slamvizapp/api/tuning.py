"""
APIs related to parameter tuning
"""
import os
import subprocess
import json
import datetime
from pathlib import Path

from flask import request, jsonify
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import app, db_session
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
        if project_id == "dvs/psp_swip":
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
    data = request.get_json()

    try:
        ci_commit = CiCommit.query.filter(
            CiCommit.project_id == project_id, CiCommit.id.startswith(hexsha)
        ).one()
    except NoResultFound:
        return jsonify("Sorry, the commit id was not found"), 404

    if "qatools_config" not in ci_commit.project.information and not project_id == "dvs/psp_swip":
        return jsonify("Please configure `qatools first`"), 404

    now = datetime.datetime.now()
    ci_commit.time_of_last_batch = now.astimezone()
    batch = ci_commit.get_or_create_batch(data['batch_label'])
    db_session.add(ci_commit)
    db_session.commit()

    groups_path = get_groups_path(shared_data_directory / project_id)
    # We store in this directory the scripts used to run this new batch, as well as the logs
    # We may instead want to use the folder where this batch's results are stored
    # Or even store the metadata in the database itself...
    prev_mask = os.umask(000)
    if not batch.output_dir.exists(): batch.output_dir.mkdir(exist_ok=True, parents=True)
    os.umask(prev_mask)

    overwrite = "--overwrite" if data["overwrite"] == "on" else ""
    if project_id=="dvs/psp_swip":
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
        do_optimize = False
    else:
        config = ci_commit.project.information["qatools_config"]
        working_directory = ci_commit.commit_dir

        # This will make us do automated tuning, versus a single manual batch
        do_optimize = data['tuning_search']['search_type'] == 'optimize'
        if do_optimize:
            # we write somewhere the optimzation search configuration
            # it needs to be accessed from LSF so we can't use temporary files...
            config_path = batch.output_dir / 'optim-config.yaml'
            config_option = f"--config-file '{config_path}'"
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
                f"--groups-file '{groups_path}'",
                f"--group '{data['selected_group']}'",
                config_option,
                f"{overwrite} --no-wait" if not do_optimize else '',
                "\n",
            ]
        )
    print(working_directory)
    # print(batch_command)


    # To avoid issues with quoting, we write a script to run the batch,
    # and execute it with bsub/LSF
    # We could also play with heredocs-within-heredocs, but it is painful, and this way we get logs
    # openstf is our Android device farm
    use_openstf = data["android_device"].lower() == "openstf"
    qa_batch_script = "".join(
        [
            "#!/bin/bash\n",
            "set -xe\n\n",
            f'cd "{working_directory}";\n\n',
            # f'env | sort\n',
            # qa uses click, which hates non-utf8 locales
            'export LC_ALL=en_US.utf8;\n',
            'export LANG=en_US.utf8;\n\n',
            # we avoid DISPLAY issues with matplotlib, since we're headless here
            'export MPLBACKEND=agg;\n',
            # bsub_su is owned by root, this leads to the PATH not being what we would expect
            # https://unix.stackexchange.com/questions/115129/why-does-root-not-have-usr-local-in-path
            # "export PATH=$PATH:/usr/local/bin;\n",
            f"export RESERVED_ANDROID_DEVICE='{data['android_device']}';\n" if not use_openstf else "",
            # https://unix.stackexchange.com/questions/115129/why-does-root-not-have-usr-local-in-path
            # options specific to android
            f"export RESERVED_ANDROID_DEVICE='{data['android_device']}';\n" if not use_openstf else "",
            f"export OPENSTF_STORAGE_QUOTA=12;\n" if not use_openstf else "",
            # Make sure qatools doesn't complain about not being in a git repository,
            f"\nexport CI_COMMIT_SHA='{ci_commit.gitcommit.hexsha}';\n",
            # Make sure qatools knows where to save results
            f"export {'SAMSUNG_CI_COMMIT_DIR' if project_id=='dvs/psp_swip' else 'QATOOLS_CI_COMMIT_DIR'}='{ci_commit.commit_dir}';\n\n",
            batch_command,
        ]
    )
    print(qa_batch_script)
    qa_batch_path = batch.output_dir / f"qa_batch.sh"
    with qa_batch_path.open("w") as f:
        f.write(qa_batch_script)

    user = data.get("user", "arthurf")
    queue = "alg_q" if project_id=="dvs/psp_swip" else ci_commit.project.information["qatools_config"]["lsf"]["fast_queue"]
    start_script = "".join(
        [
            "#!/bin/bash\n",
            "set -xe\n\n",
            f'bsub_su {user} -q {queue} ',
            '-W 24:00 ' if do_optimize else '-sp 4000 ', # highest priority for manual runs
            f'-o "{batch.output_dir}/log.txt" << "EOF"\n',
            f'\tssh -q {user}@{user}-vdi \'bash "{qa_batch_path}"\'',
            '\nEOF'
        ]
    )
    print(start_script)


    start_path = batch.output_dir / f"start.sh"
    with start_path.open("w") as f:
        f.write(start_script)

    # Wraps and execute the script that starts the batch
    cmd = " ".join(
        [
            # there is only C.utf8 on our container, but it is not available on LSF
            "LC_ALL=en_US.utf8 LANG=en_US.utf8",
            "ssh",
            # quiet to avoid the welcome banner
            "-q",
            # ask, and force a TTY, otherwise bsub->su will complain
            "-tt",
            # make sure we OK the server key during the first-connection
            "-o StrictHostKeyChecking=no",
            # ispq is the only user that can use bsub_su, an alias for sudo -i -u {0} {1:}.
            "-i /home/arthurf/.ssh/ispq.id_rsa",
            "ispq@ispq-vdi",
            f'\'bash "{start_path}"\'',
        ]
    )
    print(cmd)

    try:
        out = subprocess.run(cmd, shell=True, encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        out.check_returncode()
        print(out.stdout)
    except:
        return jsonify({"error": str(out.stdout), "cmd": str(cmd)}), 500
    return jsonify({"cmd": str(cmd), "stdout": str(out.stdout)})
