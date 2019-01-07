#!/usr/bin/env python
"""
Bit-accuracy test between 2 results folders
"""
import sys
from pathlib import Path
import filecmp

import click
import git

from .config import config, commit_branch, ci_dir, leaf_relative_to_root, is_ci, commit_ci_dir



def compare_folders(dir_1=Path(), dir_2=Path(), patterns=None):
    """Bit-accuracy test between two directories"""
    compared_results = False
    different_files = []
    for pattern in patterns:
        for file_1 in dir_1.rglob(f"{pattern}"):
            # we avoid comparing stdout logs, they contain timestamps...
            if file_1.name == 'log.txt': continue
            rel_file_path = file_1.relative_to(dir_1)
            file_2 = dir_2 / rel_file_path
            if file_2.is_file():
                compared_results = True
                if not filecmp.cmp(str(file_1), str(file_2)):
                    different_files.append(str(rel_file_path))
    assert not different_files, "ERROR: different files\n" + "\n".join(different_files)
    assert (
        compared_results
    ), "at least 1 results file should be compared. Looks like something went wrong."
    return True


def assert_bit_accurate_to(reference_commit):
    """Throws if the results of the current output directory are not bit-accurate to the reference commit"""
    reference_folder = f'{reference_commit.authored_date}__{reference_commit.committer.name}__{reference_commit.hexsha[:8]}'
    reference_output_directory = ci_dir / "commits" / reference_folder / "output"
    if leaf_relative_to_root:
        reference_output_directory = reference_output_directory / leaf_relative_to_root

    if is_ci:
      output_directory = commit_ci_dir / "output"
    else:
      output_directory = Path() / "output"
    
    print(f"Current output directory  : {output_directory}")
    print(f"Reference output directory: {reference_output_directory}")
    return compare_folders(
        dir_1=reference_output_directory,
        dir_2=output_directory,
        patterns=config["bit_accuracy"]["patterns"],
    )
