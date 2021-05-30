#!/usr/bin/env python
"""
Bit-accuracy test between 2 results folders
"""
import json
import filecmp
import fnmatch
from pathlib import Path

import click

from .conventions import make_batch_conf_dir
from .iterators import iter_inputs
from .utils import PathType
from .config import commit_id, project, subproject, outputs_commit_root, outputs_commit, is_ci, default_platform, config
from .config import user, default_batches_files


def cmpfiles(dir_1=Path(), dir_2=Path(), patterns=None, ignore=None):
  """Bit-accuracy test between two directories. We usually use cmpmanifest only...
  Almost like https://docs.python.org/3/library/filecmp.html
  """
  if not patterns:
    patterns = ['*']
  if not ignore:
    ignore = []

  mismatch = set()  # not the same
  match = set()     # the same
  only_in_1 = set() # exists in dir_1 but not in dir_2
  only_in_2 = set() # exists in dir_2 but not in dir_1
  errors = set()    # or errors accessing

  for pattern in patterns:
    files_1 = list(dir_1.rglob(pattern))
    files_2 = list(dir_2.rglob(pattern))

    for file_2 in files_2:
      if not file_2.is_file(): continue
      if any(fnmatch.fnmatch(file_2.name, i) for i in ignore): continue
      rel_path = file_2.relative_to(dir_2)
      if not (dir_1 / rel_path).is_file():
        only_in_2.add(rel_path)

    for file_1 in files_1:
      if not file_1.is_file(): continue
      if any(fnmatch.fnmatch(file_1.name, i) for i in ignore): continue

      rel_path = file_1.relative_to(dir_1)
      file_2 = dir_2 / rel_path
      if file_2.is_file():
        try:
          is_same = filecmp.cmp(str(file_1), str(file_2), shallow=False)
          if not is_same:
            mismatch.add(rel_path)
          else:
            match.add(rel_path)
        except:
          errors.add(rel_path)
      else:
        only_in_1.add(rel_path)

  return {
    "mismatch": mismatch,
    "match": match,
    "only_in_1": only_in_1,
    "only_in_2": only_in_2,
    "errors": errors,
  }



def cmpmanifests(manifest_path_1, manifest_path_2, patterns=None, ignore=None):
  """Bit-accuracy test between two manifests.
  Their format is {filepath: {md5, size_st}}"""
  def parse_json(path):
    with path.open() as f:
      data = f.read()
      try:
        return json.loads(data)
      except Exception as e:
        print(data)
        raise Exception(f"{e} Could not parse as JSON: {path}")
  manifest_1 = parse_json(manifest_path_1)
  manifest_2 = parse_json(manifest_path_2)
  # print("manifest_1", manifest_1)
  # print("manifest_2", manifest_2)
  # print("manifest inter:", set(manifest_1.keys()) & set(manifest_2.keys()))

  if not patterns:
    patterns = ['*']
  if not ignore:
    ignore = []

  # print("patterns", patterns)

  mismatch = set()  # not the same
  match = set()     # the same
  only_in_1 = set() # exists in dir_1 but not in dir_1
  only_in_2 = set() # exists in dir_2 but not in dir_2
  errors = set()    # or errors accessing

  for pattern in patterns:
    pattern = f'*{pattern}'
    for file_2_str in manifest_2:
      if not fnmatch.fnmatch(file_2_str, pattern):
        continue
      if any(fnmatch.fnmatch(file_2_str, f"{i}*") for i in ignore):
        continue
      if file_2_str not in manifest_1:
        only_in_2.add(Path(file_2_str))

    for file_1_str, meta_1 in manifest_1.items():
      if not fnmatch.fnmatch(file_1_str, pattern):
        continue
      file_1 = Path(file_1_str)
      if any(fnmatch.fnmatch(file_1, f"{i}*") for i in ignore):
        continue
      if file_1_str in manifest_2:
        is_same = meta_1['md5'] == manifest_2[file_1_str]['md5']
        if not is_same:
          mismatch.add(file_1)
        else:
          match.add(file_1)
      else:
        only_in_1.add(file_1)

  return {
    "mismatch": mismatch,
    "match": match,
    "only_in_1": only_in_1,
    "only_in_2": only_in_2,
    "errors": errors,
  }



def is_bit_accurate(commit_rootproject_dir, reference_rootproject_dir, output_directories, strict=False, reference_platform=None):
    """Compares the results of the current output directory versus a reference"""    
    from .config import config
    patterns = config.get("bit_accuracy", {}).get("patterns", [])
    if not (isinstance(patterns, list) or isinstance(patterns, tuple)):
      patterns = [patterns]
    if not patterns:
      patterns = ['*']
    patterns.append('manifest.inputs.json')

    ignore = config.get("bit_accuracy", {}).get("ignore", [])
    if not (isinstance(ignore, list) or isinstance(ignore, tuple)):
      ignore = [ignore]
    ignore.append('run.json')     # qa-board data, not relevant
    ignore.append('log.txt')      # contains timestamps
    ignore.append('log.lsf.txt')  # contains timestamps
    ignore.append('metrics.json') # contains measured run time
    ignore.append('.nfs000*')     # NFS temporary files

    if not len(output_directories):
      click.secho("WARNING: nothing was compared", fg='yellow')
      return True

    missing_runs = False
    comparaisons = {'match': [], 'mismatch': [], 'errors': [], 'only_in_1': [], 'only_in_2': []}
    for output_directory in output_directories:
      # print('output_directory', output_directory)
      dir_1 = reference_rootproject_dir / output_directory
      dir_2 = commit_rootproject_dir / output_directory

      # FIXME: the platform named used to be part of the output dir,
      #       but not anymore, so this code is broken..!
      #       We'd need a smart refactoring, and pass RunContexts instead of output directories...
      #       then it would be simple to compare to runs with any attribute changed.
      if reference_platform:
        from .config import platform
        dir_2 = Path(str(dir_2).replace(platform, reference_platform))

      if not dir_2.exists():
        click.secho(f"ERROR: did not run {output_directory}", fg='red')
        missing_runs = True
      if (dir_1 / 'manifest.outputs.json').exists() and (dir_2 / 'manifest.outputs.json').exists():
        comparaison = cmpmanifests(
          manifest_path_1 = dir_1 / 'manifest.outputs.json',
          manifest_path_2 = dir_2 / 'manifest.outputs.json',
          patterns=patterns,
          ignore=ignore,
        )
      else:
        comparaison = cmpfiles(
          dir_1=dir_1,
          dir_2=dir_2,
          patterns=patterns,
          ignore=ignore,
        )
      for attr in ('match', 'mismatch', 'errors', 'only_in_1', 'only_in_2'):
        comparaisons[attr].extend(output_directory / p for p in comparaison[attr])

    if missing_runs:
      return False
    bit_accurate = True
    if strict:
      if comparaisons['only_in_1']:
        for o in output_directories:
          click.secho(str(o), fg='red', bold=True, err=True)
        click.secho(f"ERROR: ({len(comparaisons['only_in_1'])}) file(s) existing in the reference run are not present:", fg='red')
        for p in comparaisons['only_in_1']:
          click.secho(f'➖ {p}', fg='red', dim=True)
        bit_accurate = False
      if comparaisons['only_in_2']:
        for o in output_directories:
          click.secho(str(o), fg='red', bold=True, err=True)
        click.secho(f"ERROR: {len(comparaisons['only_in_2'])} file(s) are not present in the reference run:", fg='red')
        for p in comparaisons['only_in_2']:
          click.secho(f'➕ {p}', fg='red', dim=True)
        # print(comparaisons)
        # exit(0)
        bit_accurate = False

    # print(comparaisons['mismatch'])
    nothing_was_compared = not (len(comparaisons['match']) + len(comparaisons['mismatch']) + len(comparaisons['errors']) )
    if nothing_was_compared:
      for o in output_directories:
        click.echo(click.style(str(o), fg='yellow') + click.style(' (warning: no files were compared)', fg='yellow', dim=True), err=True)

    if comparaisons['errors']:
      bit_accurate = False
      click.secho("ERROR: while trying to read those files:", fg='red', bold=True)
      for p in comparaisons['error']:
        click.secho(f"⚠️ {p}", fg='red')

    if comparaisons['mismatch']:
      bit_accurate = False
      for o in output_directories:
        click.secho(str(o), fg='red', bold=True, err=True)
      click.secho(f"ERROR: mismatch for:", fg='red')
      for p in comparaisons['mismatch']:
        click.secho(f'❌ {p}', fg='red', dim=True)

    if bit_accurate and not nothing_was_compared:
      for o in output_directories:
        click.secho(str(o), fg='green', err=True)
    return bit_accurate



@click.command()
@click.pass_context
@click.option('--batch', '-b', 'batches', required=True, multiple=True, help="Only check bit-accuracy for this batch of inputs+configs+database.")
@click.option('--batches-file', 'batches_files', type=PathType(),  default=default_batches_files, multiple=True, help="YAML file listing batches of inputs+config+database selected from the database.")
@click.option('--strict', is_flag=True, help="By default only files existing in current/ref runs are checked. This files ensure we fail if some files exist in one run and not the other.")
def check_bit_accuracy_manifest(ctx, batches, batches_files, strict):
    """
  Checks the bit accuracy of the results in the current ouput directory
  versus the latest commit on origin/develop.
  """
    commit_dir = outputs_commit if (is_ci or ctx.obj['share']) else Path()
    click.secho(f'Current directory  : {commit_dir}', fg='cyan', bold=True, err=True)
    all_bit_accurate = True
    nb_compared = 0
    missing_runs = 0
    for run_context in iter_inputs(batches, batches_files, ctx.obj['database'], ctx.obj['configurations'], default_platform, {}, config, ctx.obj['inputs_settings']):
      if not (run_context.database / run_context.rel_input_path / "manifest.outputs.json").exists():
        click.secho(f"[WARNING] no manifest for {run_context.database / run_context.rel_input_path}", fg='yellow')
        continue
      nb_compared += 1
      if run_context.input_path.is_file():
        click.secho('ERROR: check_bit_accuracy_manifest only works for inputs that are folders', fg='red', err=True)
        # otherwise the manifest is at
        #   * input_path.parent / 'manifest.json' in the database
        #   * input_path.with_suffix('') / 'manifest.json' in the results
        # # reference_output_directory = run_context.input_path if run_context.input_path.is_folder() else run_context.input_path.parent
        exit(1)

      batch_conf_dir = make_batch_conf_dir(Path(), ctx.obj['batch_label'], ctx.obj["platform"], run_context.configurations, ctx.obj['extra_parameters'], ctx.obj['share'])
      if f"/{user}/" in str(commit_dir):
        commit_dir_ = Path(str(commit_dir).replace(user, '*'))
        start, *end = commit_dir_.parts
        start, end = Path(start), str(Path(*end))
        commit_dirs = start.glob(end)
        # FIXME: the output path is not created like this if rel_input_path is long or there are configs/tuning...
        commit_dirs = [d for d in commit_dirs if (d / batch_conf_dir / run_context.rel_input_path).exists()]
        try:
          assert commit_dirs
        except:
          click.secho(f"ERROR: Missing run: {run_context.rel_input_path}", fg='red')
          missing_runs += 1
        for commit_dir_ in commit_dirs:
          input_is_bit_accurate = is_bit_accurate(commit_dir_ / batch_conf_dir, run_context.database, [run_context.rel_input_path], strict=strict)
          all_bit_accurate = all_bit_accurate and input_is_bit_accurate
      else:
        input_is_bit_accurate = is_bit_accurate(commit_dir / batch_conf_dir, run_context.database, [run_context.rel_input_path], strict=strict)
        all_bit_accurate = all_bit_accurate and input_is_bit_accurate

    if missing_runs:
      click.secho(f"ERROR: {missing_runs} runs are missing!", bg='red', underline=True, bold=True)
      exit(1)
    if not all_bit_accurate:
      click.secho("\nError: you are not bit-accurate versus the manifest.", bg='red', underline=True, bold=True)
      click.secho("Reminder: the manifest lists the expected inputs/outputs for each test. It acts as an explicit gatekeeper against changes", fg='red', dim=True)
      if not run_context.database.is_absolute():
        click.secho("If that's what you wanted, update and commit all manifests.", fg='red')
        # click.secho("If that's what you wanted, update all manifests using:", fg='red')
        # click.secho("$ qa batch * --save-manifests-in-database", fg='red')
        # click.secho("$ git add        # your changes", fg='red')
        # click.secho("$ git commit     # now retry your CI", fg='red')
      else:
        click.secho("To update the manifests for all tests, run:", fg='red')
        click.secho("$ qa batch --save-manifests --batch *", fg='red')
      exit(1)

    if not nb_compared:
      click.secho("\nWARNING: Nothing was compared! It's not likely to be what you expected...", fg='yellow', underline=True, bold=True)



@click.command()
@click.pass_context
@click.option(
    "--reference",
    default=config.get('project', {}).get('reference_branch', 'master'),
    help="Branch, tag or commit used as reference."
)
@click.option('--batch', '-b', 'batches', multiple=True, help="Only check bit-accuracy for those batches of inputs+configs+database.")
@click.option('--batches-file', 'batches_files', type=PathType(),  default=default_batches_files, multiple=True, help="YAML file listing batches of inputs+config+database selected from the database.")
@click.option('--strict', is_flag=True, help="By default only files existing in current/ref runs are checked. This files ensure we fail if some files exist in one run and not the other.")
@click.option('--reference-platform', help="Compare against a difference platform.")
def check_bit_accuracy(ctx, reference, batches, batches_files, strict, reference_platform):
    """
  Checks the bit accuracy of the results in the current ouput directory
  versus the latest commit on origin/develop.
  """
    from .config import is_in_git_repo, commit_branch, is_ci, outputs_project_root, repo_root
    from .gitlab import lastest_successful_ci_commit
    from .conventions import get_commit_dirs
    from .git import latest_commit, git_parents

    if not is_in_git_repo:
      click.secho("You are not in a git repository, maybe in an artifacts folder. `check_bit_accuracy` is unavailable.", fg='yellow', dim=True)
      exit(1)


    if is_ci and commit_branch == reference:
      click.secho(f'We are on branch {reference}', fg='cyan', bold=True, err=True)
      click.secho(f"Comparing bit-accuracy against this commit's ({commit_id[:8]}) parents.", fg='cyan', bold=True, err=True)
      # It will work until we try to rebase merge requests.
      # We really should use Gitlab' API (or our database) to ask about previous pipelines on the branch
      reference_commits = git_parents(commit_id)
    else:
      # ideally we should do something smarter...
      # https://stackoverflow.com/questions/18222634/given-a-git-refname-can-i-detect-whether-its-a-hash-tag-or-branch
      if "origin" not in reference:
        origin_reference = f"origin/{reference}"
      origin_latest_commit = latest_commit(origin_reference)
      if origin_latest_commit != origin_reference: # it was a commit
        click.secho(f'Comparing bit-accuracy versus the latest remote commit of {origin_reference}', fg='cyan', bold=True, err=True)
        reference_commits = [origin_latest_commit]
      else:
        click.secho(f'Comparing bit-accuracy versus {reference}', fg='cyan', bold=True, err=True)
        reference_commits = [reference]
    click.secho(f"{commit_id[:8]} versus {reference_commits}.", fg='cyan', err=True)
    
    # This where the new results are located
    commit_dir = outputs_commit_root if (is_ci or ctx.obj['share']) else Path()

    if not batches:
      output_directories = list(p.parent.relative_to(commit_dir) for p in (commit_dir / subproject / 'output').rglob('manifest.outputs.json'))
    else:
      output_directories = []
      for run_context in iter_inputs(batches, batches_files, ctx.obj['database'], ctx.obj['configurations'], default_platform, {}, config, ctx.obj['inputs_settings']):
        batch_conf_dir = make_batch_conf_dir(subproject, ctx.obj['batch_label'], ctx.obj["platform"], run_context.configurations, ctx.obj["extra_parameters"], ctx.obj['share'])
        if batch_conf_dir.is_absolute():
          try:
            batch_conf_dir = batch_conf_dir.relative_to(Path().resolve())
          except:
            print("TODO: fix this...")
            pass
        input_path = run_context.rel_input_path
        output_directory = batch_conf_dir / input_path.with_suffix('')
        output_directories.append(output_directory)

    for reference_commit in reference_commits:
      # if the reference commit is pending or failed, we wait or maybe pick a parent
      reference_commit = lastest_successful_ci_commit(reference_commit)
      click.secho(f'Current directory  : {commit_dir}', fg='cyan', bold=True, err=True)
      reference_rootproject_ci_dir = outputs_project_root / get_commit_dirs(reference_commit, repo_root)
      if f"/{user}/" in str(reference_rootproject_ci_dir):
        reference_rootproject_ci_dir_ = Path(str(reference_rootproject_ci_dir).replace(user, '*'))
        start, *end = reference_rootproject_ci_dir_.parts
        start, end = Path(start), str(Path(*end))
        reference_rootproject_ci_dirs = start.glob(end)
        all_bit_accurate = True
        for reference_rootproject_ci_dir in reference_rootproject_ci_dirs:
          click.secho(f"Reference directory: {reference_rootproject_ci_dir}", fg='cyan', bold=True, err=True)
          for o in output_directories:
            all_bit_accurate = is_bit_accurate(commit_dir, reference_rootproject_ci_dir, [o], strict=strict, reference_platform=reference_platform) and all_bit_accurate
      else:
        click.secho(f"Reference directory: {reference_rootproject_ci_dir}", fg='cyan', bold=True, err=True)
        all_bit_accurate = True
        for o in output_directories:
          all_bit_accurate = is_bit_accurate(commit_dir, reference_rootproject_ci_dir, [o], strict=strict, reference_platform=reference_platform) and all_bit_accurate
    if not all_bit_accurate:
      click.secho(f"\nERROR: results are not bit-accurate to {reference_commits}.", bg='red', bold=True)
      if is_ci:
        click.secho(f"\nTo investigate, go to", fg='red', underline=True)
        for reference_commit in reference_commits:
          click.secho(f"https://qa/{project.as_posix()}/commit/{commit_id}?reference={reference_commit}&selected_views=bit_accuracy", fg='red')
      exit(1)
