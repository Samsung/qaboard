"""SIRC-specific hooks for QABoard."""
import os
import shlex

import click


def fix_permissions(path):
    """SIRC-specific: SSH to VDI and chmod shared NFS paths."""
    from getpass import getuser
    from qaboard.compat import windows_to_linux_path

    click.secho("... Fixing linux file permissions", err=True)
    try:
        # Windows does not set file permissions correctly on the shared storage,
        # it does not respect umask 0: files are not world-writable.
        # Trying to each_file.chmod(0o777) does not work either
        # The only option is to make the call from linux.
        # We could save a list of paths and chmod them with their parent directories...
        # but to make things faster to code, we just "ssh linux chmod everything"
        # We can assume SSH to be present on Windows10

        # Check if Git for Windows SSH exists and use it instead of PATH ssh
        # It helps as ACLs prevent network path from being used as keys with the builtin ssh
        git_ssh_path = r"C:\Program Files\Git\usr\bin\ssh.exe"
        if os.name == 'nt' and os.path.exists(git_ssh_path):
            ssh_cmd = git_ssh_path
        else:
            ssh_cmd = "ssh"

        user = getuser()
        ssh = f"{shlex.quote(ssh_cmd)} -i \\\\netapp\\raid\\users\\{user}\\.ssh\\id_rsa -oStrictHostKeyChecking=no"
        hostname = f"{user}-vdi" if user != "sircdevops" else "qa"

        def windowsize(path):
            return windows_to_linux_path(path).as_posix()

        # usually we use this function for artifact folders, but if the parent dir
        # was also created it will have permissions too restrictive too,
        # and it will break other commits!
        chmod = f'{ssh} {user}@{hostname} \'chmod -R 777 "{windowsize(path)}"; chmod 777 "{windowsize(path.parent)}"\''
        click.secho(chmod, err=True)
        os.system(chmod)
    except Exception as e:
        click.secho(f'WARNING: {e}', err=True)
