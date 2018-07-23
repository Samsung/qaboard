"""
Utilities to communicate with SIRC's LSF cluster.

If you run into issues with LSF
- Search for IBM LSF's documentation online
- Be aware our IT overwrites LSF utilities (eg bsub...) with custom wrappers.
  Read them as they change environment variables.  
"""
import os
import sys
import subprocess
from pathlib import Path

import click

from .config import config, on_windows


# We avoid hosts that run on old processors lacking AVX instructions (pre-Sandy Bridge)
# We could avoid those that lack AVX2, and someday we'll care about AVX512...
# All possible selectable CPU types can be read at /lsf_top/conf/lsf.cluster.lsf
old_cpu_architectures = ["IBMX5667", "IBMX5570", "IBMX5690"]
lsf_select = " && ".join([f"!(model=={arch})" for arch in old_cpu_architectures])

class Priority:
    LOW, NORMAL, HIGH = range(3)


class Job:
    """Wraps LSF jobs for convenience."""

    def __init__(self, name, command="", log_dir=Path().resolve(), priority=2000):
        self.name = str(name).replace(" ", "-")
        self.command = command
        self.log_file = log_dir / "log.txt"
        self.project = config["project"]["name"]
        self.priority = priority  # max: 4000, LSF-default: 2000

    def send(
        self, dependencies=None, interactive=False, mail_to=config["lsf"]["email"]
    ):
        """Sends a job to the LSF queue and returns the results of the subprocess call that sent the command to LSF.
    The `dependencies` parameter specifies jobs that must be exited (any error code is OK) before this one.
    If you write a tool using this function, please don't use the default `mail_to` :)
    """
        if on_windows:
            click.secho(
                "Error: Sending jobs to LSF from Windows was not implemented",
                fg="red",
                err=True,
            )
            click.secho(
                "It could be done: 1. create a tar.gz-ball, 2. send it via scp, send the LSF jobs via SSH.\n"
                "Talk to @arthurf for details, or create a merge request!",
                dim=True,
                err=True,
            )
            exit(1)

        if dependencies:
            dependencies_expression = " && ".join(
                [f"ended({job.name})" for job in dependencies]
            )
            dependencies_flag = f'-w "{dependencies_expression}"'
        else:
            dependencies_flag = ""

        # Below is a non-functionnal attemp as running LSF jobs as any user
        # Currently it fails because of quoting issues with `&& umask ..`
        # - Using a heredoc should do the trick
        # - We should also remove the lenghty SSH banner

        # We try to run as the user that pushed to Gitlab
        # Note: currently not set because we are on an old Gitlab version
        # Note: Jenkins sets GIT_AUTHOR_EMAIL / GIT_COMMITER_EMAIL / NAME
        bsub_as_user = os.environ.get("GITLAB_USER_LOGIN", None)
        # Only arthurf can use bsub_su
        if not bsub_as_user or os.environ.get("USER") != "arthurf":
            bsub = "bsub"
        else:
            # we login as ispq to have permission to use bsub_su
            # we could simply add arthurf to the bsub_su_users group. Much better.
            bsub_su = "/raid/tools/vdi/lsf-scripts/bsub_su"
            key = "-i ~/.ssh/id_rsa_isqp"  # only readable by arthurf
            bsub = f"ssh -tt {key} ispq@planet31 {bsub_su} {bsub_as_user} umask 000 &&"

        queue = (
            config["lsf"]["queue"]
            if not interactive
            else config["lsf"]["fast_queue"]
        )
        q_command = " ".join(
            [
                bsub,
                # only necessary if we send the job through ssh
                f"-cwd {os.getcwd()}",
                # note: we don't request a pseudoterminal here -Is
                # on our current use-cases, -K should be enough
                "-I" if interactive else "",
                f"-P {self.project}",
                f"-q {queue}",
                f"-sp {self.priority}",
                f'-J "{self.name}"',
                f'-o "{self.log_file}"',
                f"-R '\"{lsf_select}\"'",
                f"-u{mail_to}" if mail_to else "",
                dependencies_flag,
                # Note: what follows might not be needed anymore
                # "DISPLAY=arthurf-vdi:3", # we should not be using displays anyway
                "LC_ALL=C.utf8 LANG=C.utf8",  # the click python package hates ascii
                "MPLBACKEND=agg",  # forces a non-interactive matplotlib backend
                self.command,
            ]
        )
        print(q_command)

        out = subprocess.run(
            q_command,
            shell=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        click.secho(out.stdout, err=True)
        click.secho(out.stderr, fg="red", err=True)
        return out


def running_lsf_job_names():
    """
  Return the names of the running LSF jobs for the current user (as a set)

  From Windows we return an empty set, but if you really want to, you should be able to find a way to connect to LSF.
  """
    if on_windows:
        click.secho(
            "Warning: on Windows we don't check for running LSF jobs'",
            fg="yellow",
            err=True,
        )
        return set()

    cmd = " ".join(["bjobs -u", os.environ["USER"], "-noheader -o 'job_name:100'"])
    out = subprocess.run(cmd, stdout=subprocess.PIPE, shell=True, encoding="utf-8")
    if out.stdout:
        lines = out.stdout.split("\n")
        # the output begins with *
        job_names = [l.strip()[1:] for l in lines]
        return set(job_names)
    else:
        return set()
