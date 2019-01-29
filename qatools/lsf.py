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
    LOW, NORMAL, HIGH = 1000, 2000, 4000


class Job:
    """Wraps LSF jobs for convenience."""

    def __init__(self, name, command="", log_dir=Path().resolve(), priority=2000, max_threads=0, max_memory=0, sequential=False):
        self.name = str(name).replace(" ", "-").replace('"','')
        self.command = command
        self.log_file = log_dir / "log.txt"
        self.project = config["project"]["name"]
        self.priority = priority  # max: 4000, LSF-default: 2000
        self.max_threads = max_threads
        self.max_memory = max_memory #in MB
        self.sequential = sequential

    def send(
        self, dependencies=None, interactive=False
    ):
        """Sends a job to the LSF queue and returns the results of the subprocess call that sent the command to LSF.
    The `dependencies` parameter specifies jobs that must be exited (any error code is OK) before this one.
    """
        if on_windows or self.sequential:
            out = subprocess.run(
                self.command,
                shell=True,
                encoding="utf-8",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            click.secho(out.stdout)
            return out

        if dependencies:
            dependencies_expression = " && ".join(
                [f"ended({job.name})" for job in dependencies]
            )
            dependencies_flag = f'-w "{dependencies_expression}"'
        else:
            dependencies_flag = ""

        queue = (
            config["lsf"]["queue"]
            if not interactive
            else config["lsf"]["fast_queue"]
        )
        q_command = " ".join(
            [
                "bsub",
                # only necessary if we send the job through ssh
                # f'-cwd "{os.getcwd()}"',
                # note: we don't request a pseudoterminal here -Is
                # on our current use-cases, -K should be enough
                "-I" if interactive else "",
                f"-P {self.project}",
                f"-q {queue}",
                f"-sp {self.priority}",
                f'-J "{self.name}"',
                f'-o "{self.log_file}"',
                f"-R \"affinity[thread({self.max_threads})]\"" if self.max_threads > 0 else "",
                f"-R \"rusage[mem={self.max_memory}]\"" if self.max_memory > 0 else "",
                f"-R \"{lsf_select}\"",
                dependencies_flag,
                '<< EOF\n'
                # the click python package hates ascii locales, for good reasons
                "  LC_ALL=en_US.utf8 LANG=en_US.utf8",
                # forces a non-interactive matplotlib backend
                "MPLBACKEND=agg",
                self.command,
                "\nEOF",
            ]
        )
        # click.secho(q_command, dim=True)

        out = subprocess.run(
            q_command,
            shell=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        # click.secho(out.stdout)
        return out

def kill_jobs(jobs, on_lsf=False):
    command = " && ".join([
      f"bkill -J {job.name} 0" for job in jobs
    ])
    if on_lsf:
        killer = Job(f"killer", f'"{command}"', priority=Priority.HIGH)
        killer.send()
    else:
        out = subprocess.run(
            command,
            shell=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        click.secho(out.stdout)
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
