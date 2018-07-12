#!/usr/bin/env python
"""
Bit-accuracy test between 2 results folders
"""
import sys
from pathlib import Path
import filecmp

import click
import git

from .config import config, commit_branch
from .utils import commit_dir_name


@click.command()
@click.option(
    "--reference-branch",
    default=f"origin/{config['project']['reference_branch']}",
)
def test_bit_accuracy(reference_branch):
    """
  Checks the bit accuracy of the results in the current ouput directory
  versus the latest commit on origin/develop.
  """
    if config["project"]["type"] != "git":
        click.secho(
            "Bit-accuracy tests are only supported for git-based projects", err=True
        )
        exit(1)

    if commit_branch not in [reference_branch, f"origin/{reference_branch}"]:
        assert assert_bit_accurate_to(
            latest_commit(reference_branch)
        ), "ERRROR: the bit-accuracy test has failed"

    # bit-accuracy on the reference branch is check on the commit's parents
    else:
        all_bit_accurate = True
        for commit_ref in reference_commit().parents:
            if not assert_bit_accurate_to(commit_ref):
                all_bit_accurate = False
        assert all_bit_accurate, "ERRROR: the bit-accuracy test has failed"


def latest_commit(branch):
    """Returns the latest commit on a branch."""
    if config["project"]["type"] != "git":
        click.secho(
            "Bit-accuracy tests are only support for git-based projects", err=True
        )
        exit(1)

    # FIXME: couldn't we just use the project's git repo URL from the configuration?
    # Here we find a local copy of the repo and use it to iterate through commits
    # TODO: we should use the branch slug.... but it will work for develop/master/release...
    repo_name = config["project"]["name"].split("/")[-1]
    # Who makes sure this exists? This is very fragile....
    repo_path = ci_root / "branches" / branch / repo_name
    repo = git.Repo(str(repo_path))
    return list(repo.iter_commits(branch, max_count=1))[0]


def compare_folders(dir_1=Path(), dir_2=Path(), patterns=None):
    """Bit-accuracy test between two directories"""
    compared_results = False
    different_files = []
    for pattern in patterns:
        for file_1 in dir_1.rglob(f"{pattern}"):
            compared_results = True
            rel_file_path = file_1.relative_to(dir_1)
            file_2 = dir_2 / rel_file_path
            if file_2.is_file():
                if not filecmp.cmp(str(file_1), str(file_2)):
                    different_files.append(str(rel_file_path))
    assert not different_files, "ERROR: different files\n" + "\n".join(different_files)
    assert (
        compared_results
    ), "at least 1 results file should be compared. Looks like something went wrong."
    return True


def assert_bit_accurate_to(reference_commit):
    """Throws if the results of the current output directory are not bit-accurate to the reference commit"""
    reference_folder = commit_dir_name(reference_commit)
    reference_output_directory = ci_root / "commits" / reference_folder / "output"
    output_directory = Path() / "output"
    print(f"Current output directory  : {output_directory}")
    print(f"Reference output directory: {reference_output_directory}")
    return compare_folders(
        dir_1=output_directory,
        dir_2=reference_output_directory,
        patterns=config["bit_accuracy"]["patterns"],
    )


if __name__ == "__main__":
    test_bit_accuracy()
