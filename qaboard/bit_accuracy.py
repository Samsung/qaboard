#!/usr/bin/env python
"""
Bit-accuracy test between 2 results folders
"""
import os
import json
import filecmp
import fnmatch
from pathlib import Path

import click
from click import secho

from .conventions import make_batch_conf_dir, output_dirs_for_input_part
from .iterators import iter_inputs
from .utils import PathType
from .config import commit_id, project, subproject, outputs_commit_root, outputs_commit, is_ci, default_platform, config
from .config import user, default_batches_files


def default_cmp(file_1, file_2):
    filecmp.cmp(str(file_1), str(file_2), shallow=False)

# In some cases you want to implement your own file comparaison.
# It can be useful if e.g. you want to allow a file-format change, but still fail in case of semantic changes
# To do this, write some/file.py implemented a "cmp(file_1, file_2)" function.
# It should return True if the files are "the same", False otherwise
# To use this file, set as environment variable QA_BITACCURACY_CMP=/your/file.py
custom_cmp = os.environ.get("QA_BITACCURACY_CMP")
if custom_cmp:
  try:
    import sys
    cmp_source = Path(custom_cmp).resolve()
    # https://docs.python.org/3/library/importlib.html#importing-a-source-file-directly
    import importlib.util
    spec = importlib.util.spec_from_file_location('custom-cmp', str(cmp_source))
    assert spec
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(cmp_source.parent))
    spec.loader.exec_module(module) # type: ignore
    cmp_func = module.cmp # type: ignore
  except Exception as e:
    import traceback
    exc_type, exc_value, exc_traceback = sys.exc_info()
    click.secho(f'ERROR: Error importing the custom cmp function.', fg='red', err=True, bold=True)
    click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', err=True)



def cmpfiles(dir_1=Path(), dir_2=Path(), patterns=None, ignore=None, cmp=default_cmp):
  """Bit-accuracy test between two directories. We usually use cmpmanifest only...
  Almost like https://docs.python.org/3/library/filecmp.html
  """
  if not cmp:
    cmp = default_cmp

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
          is_same = cmp(file_1, file_2)
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



def is_bit_accurate(dir_new, dir_ref, ba_context, strict=False, reference_platform=None, manifest_name='manifest.outputs.json'):
    """Compares the results of the current output directory versus a reference"""
    output_dir_suffix = ba_context["output_dir_suffix"]
    rel_input_path = ba_context["rel_input_path"]

    from .config import config
    patterns = config.get("bit_accuracy", {}).get("patterns", [])
    if not (isinstance(patterns, list) or isinstance(patterns, tuple)):
      patterns = [patterns]
    if not patterns:
      patterns = ['*']

    ignore = config.get("bit_accuracy", {}).get("ignore", [])
    if not (isinstance(ignore, list) or isinstance(ignore, tuple)):
      ignore = [ignore]
    ignore.append('manifest.inputs.json') # compared when setting manifest_name
    ignore.append('run.json')             # qa-board data, not relevant
    ignore.append('log.txt')              # contains timestamps
    ignore.append('log.lsf.txt')          # contains timestamps
    ignore.append('metrics.json')         # contains measured run time
    ignore.append('.nfs000*')             # NFS temporary files

    missing_runs = False

    # FIXME: the platform named used to be part of the output dir,
    #       but not anymore, so this code is broken..!
    #       We'd need a smart refactoring, and pass RunContexts instead of output directories...
    #       then it would be simple to compare to runs with any attribute changed.
    if reference_platform:
      from .config import platform
      dir_ref = Path(str(dir_ref).replace(platform, reference_platform))

    # print('dir_new', dir_new) # (dir_new / "manifest.outputs.json").resolve())
    # print('dir_ref', dir_ref) # (dir_ref / "manifest.outputs.json").resolve())
    if not dir_ref.exists():
      click.secho(f"ERROR: No reference for '{rel_input_path}'", fg='red')
      missing_runs = True
    if not dir_new.exists():
      click.secho(f"ERROR: Missing run for '{rel_input_path}'", fg='red')
      missing_runs = True


    if (dir_new / manifest_name).exists() and (dir_ref / manifest_name).exists() and not custom_cmp:
      comparison = cmpmanifests(
        manifest_path_1 = dir_new / manifest_name,
        manifest_path_2 = dir_ref / manifest_name,
        patterns=patterns,
        ignore=ignore,
      )
    else:
      comparison = cmpfiles(
        dir_1=dir_new,
        dir_2=dir_ref,
        patterns=patterns,
        ignore=ignore,
        cmp=cmp_func,
      )
      # print(dir_1)
      # print(dir_ref)
      # print(comparison)

    if missing_runs:
      return False
    bit_accurate = True
    if strict:
      if comparison['only_in_1']:
        click.secho(f'{rel_input_path} {manifest_name}', fg='red', bold=True, err=True)
        click.secho(f'{dir_new}', fg='red', err=True, dim=True)        
        click.secho(f"ERROR: ({len(comparison['only_in_1'])}) file(s) are not present in the reference run:", fg='red')
        for p in comparison['only_in_1']:
          click.secho(f'➖ {p}', fg='red', dim=True)
        bit_accurate = False
      if comparison['only_in_2']:
        click.secho(f'{rel_input_path} {manifest_name}', fg='red', bold=True, err=True)
        click.secho(f'{dir_new}', fg='red', err=True, dim=True)
        click.secho(f"ERROR: {len(comparison['only_in_2'])} file(s) existing in the reference run are not present:", fg='red')
        for p in comparison['only_in_2']:
          click.secho(f'➕  {p}', fg='red', dim=True)
        # print(comparisons)
        # exit(0)
        bit_accurate = False

    # print(comparisons['mismatch'])
    input_path_string = rel_input_path if custom_cmp else f'{rel_input_path} {manifest_name}' 
    nothing_was_compared = not (len(comparison['match']) + len(comparison['mismatch']) + len(comparison['errors']) )
    if nothing_was_compared and bit_accurate:
      click.echo(click.style(f'🤔  {input_path_string}', fg='yellow') + click.style(' 0 files compared', fg='yellow', dim=True), err=True)

    if comparison['errors']:
      bit_accurate = False
      click.secho("ERROR: While trying to read those files:", fg='red', bold=True)
      click.secho(f'{dir_new}', fg='red', err=True, dim=True)
      for p in comparison['errors']:
        click.secho(f"⚠️  {p}", fg='red')

    if comparison['mismatch']:
      bit_accurate = False
      click.secho(f'{input_path_string}', fg='red', bold=True, err=True)
      click.secho(f'{dir_new}', fg='red', err=True, dim=True)
      click.secho(f"ERROR: Mismatch for:", fg='red')
      for p in comparison['mismatch']:
        click.secho(f'❌  {p}', fg='red', dim=True)

    if bit_accurate and not nothing_was_compared:
      click.secho(f"✔️  {input_path_string}", fg='green', err=True)
    return bit_accurate



@click.command()
@click.pass_context
@click.option('--batch', '-b', 'batches', required=True, multiple=True, help="Only check bit-accuracy for this batch of inputs+configs+database.")
@click.option('--batches-file', 'batches_files', type=PathType(),  default=default_batches_files, multiple=True, help="YAML file listing batches of inputs+config+database selected from the database.")
@click.option('--strict', is_flag=True, help="By default only files existing in current/ref runs are checked. This files ensure we fail if some files exist in one run and not the other.")
def check_bit_accuracy_manifest(ctx, batches, batches_files, strict):
    """
    Checks the bit accuracy of the results in the current output directory
    versus the latest commit on origin/develop.
    """
    commit_dir = outputs_commit if (is_ci or ctx.obj['share']) else Path()
    click.secho(f'Current directory  : {commit_dir}', fg='cyan', bold=True, err=True)
    all_bit_accurate = True
    nb_compared = 0
    missing_runs = 0
    for run_context in iter_inputs(batches, batches_files, ctx.obj['database'], ctx.obj['configurations'], default_platform, {}, config, ctx.obj['inputs_settings']):
      inputs_manifest_exists =  (run_context.database / run_context.rel_input_path / "manifest.inputs.json").exists()
      outputs_manifest_exists = (run_context.database / run_context.rel_input_path / "manifest.outputs.json").exists()
      if not inputs_manifest_exists:
        click.secho(f"[WARNING] no input manifest for {run_context.database / run_context.rel_input_path}", fg='yellow')
      if not outputs_manifest_exists:
        click.secho(f"[WARNING] no output manifest for {run_context.database / run_context.rel_input_path}", fg='yellow')
        if not inputs_manifest_exists: continue
      nb_compared += 1
      if run_context.input_path.is_file():
        click.secho('ERROR: check_bit_accuracy_manifest only works for inputs that are folders', fg='red', err=True)
        # otherwise the manifest is at input_path.parent/manifest.json in the database and input_path.stem/manifest.json in the results
        exit(1)

      batch_conf_dir = make_batch_conf_dir(Path(), ctx.obj['batch_label'], ctx.obj["platform"], run_context.configurations, ctx.obj['extra_parameters'], ctx.obj['share'])
      output_dir_suffix = output_dirs_for_input_part(run_context.rel_input_path, run_context.database, config)
      batch_suffixes = batch_conf_dir / output_dir_suffix
      ba_context = {"output_dir_suffix": output_dir_suffix, "rel_input_path": run_context.rel_input_path}
      if user in commit_dir.parts:
        commit_dir_ = Path(str(commit_dir).replace(user, '*'))
        start, *end = commit_dir_.parts
        start, end = Path(start), str(Path(*end))
        commit_dirs = start.glob(end)
        commit_dirs = [d for d in commit_dirs if (d / batch_suffixes).exists()]
        try:
          assert commit_dirs
        except:
          click.secho(f"ERROR: Missing run: {run_context.rel_input_path}", fg='red')
          click.secho(f"       nothing at {commit_dir_ / batch_conf_dir / run_context.rel_input_path}", fg='red')
          missing_runs += 1
        for commit_dir_ in commit_dirs:
          if inputs_manifest_exists:
            input_is_bit_accurate = is_bit_accurate(commit_dir_ / batch_conf_dir / output_dir_suffix, run_context.database / run_context.rel_input_path, ba_context, strict=strict, manifest_name='manifest.inputs.json')
            all_bit_accurate = all_bit_accurate and input_is_bit_accurate
          if outputs_manifest_exists:
            input_is_bit_accurate = is_bit_accurate(commit_dir_ / batch_conf_dir / output_dir_suffix, run_context.database / run_context.rel_input_path, ba_context, strict=strict)
            all_bit_accurate = all_bit_accurate and input_is_bit_accurate
      else:
        if inputs_manifest_exists:
          input_is_bit_accurate = is_bit_accurate(commit_dir / batch_conf_dir / output_dir_suffix, run_context.database / run_context.rel_input_path, ba_context, strict=strict, manifest_name='manifest.inputs.json')
          all_bit_accurate = all_bit_accurate and input_is_bit_accurate
        if outputs_manifest_exists:
          input_is_bit_accurate = is_bit_accurate(commit_dir / batch_conf_dir / output_dir_suffix, run_context.database / run_context.rel_input_path, ba_context, strict=strict)
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
    Checks the bit accuracy of the results in the current output directory
    versus the latest commit on origin/develop.
    """
    from .config import is_in_git_repo, commit_branch, is_ci, outputs_project_root, repo_root
    from .gitlab import lastest_successful_ci_commit
    from .api import qaboard_url
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

    ba_contexts = []
    if not batches: # backward-compat for DVS, can likely be removed at the next refactoring
      output_dirs = list(p.parent.relative_to(commit_dir) for p in (commit_dir / subproject / 'output').rglob('manifest.outputs.json'))
      for output_dir in output_dirs:
        run_path = commit_dir / output_dir / "run.json"
        if not run_path.exists():
          secho(f"ERROR: Corrupted output directory. Missing 'run.json' file", fg="red", bold=True)
          secho(f"       We expected one in {run_path.parent}", fg="red")
          exit(1)
        run_info = json.loads(run_path.read_text())
        ba_contexts.append({
          "rel_input_path": run_info["input_path"],
          "output_dir_suffix": output_dir,
        })
    else:
      for run_context in iter_inputs(batches, batches_files, ctx.obj['database'], ctx.obj['configurations'], default_platform, {}, config, ctx.obj['inputs_settings']):
        batch_conf_dir = make_batch_conf_dir(subproject, ctx.obj['batch_label'], ctx.obj["platform"], run_context.configurations, ctx.obj["extra_parameters"], ctx.obj['share'])
        if batch_conf_dir.is_absolute():
          try:
            batch_conf_dir = batch_conf_dir.relative_to(Path().resolve())
          except:
            print("TODO: fix this...")
            pass
        output_directory = batch_conf_dir / output_dirs_for_input_part(run_context.rel_input_path, run_context.database, config)
        ba_contexts.append({
          "rel_input_path": run_context.rel_input_path,
          "output_dir_suffix": output_directory,
        })


    for reference_commit in reference_commits:
      # if the reference commit is pending or failed, we wait or maybe pick a parent
      reference_commit = lastest_successful_ci_commit(reference_commit) # TODO: don't do this if passed a commit hash
      click.secho(f'Current directory  : {commit_dir}', fg='cyan', bold=True, err=True)
      reference_rootproject_ci_dir = outputs_project_root / get_commit_dirs(reference_commit, repo_root)
      if user in reference_rootproject_ci_dir.parts:
        reference_rootproject_ci_dir_ = Path(str(reference_rootproject_ci_dir).replace(user, '*'))
        start, *end = reference_rootproject_ci_dir_.parts
        start, end = Path(start), str(Path(*end))
        reference_rootproject_ci_dirs = list(start.glob(end))
        all_bit_accurate = True
        missing_run = True
        click.secho(f"Reference directories: {reference_rootproject_ci_dirs}", fg='cyan', bold=True, err=True)
        for ba_context in ba_contexts:
          for reference_rootproject_ci_dir in reference_rootproject_ci_dirs:
            dir_ref = reference_rootproject_ci_dir / ba_context["output_dir_suffix"]
            if dir_ref.exists():
              missing_run = False
              all_bit_accurate = is_bit_accurate(commit_dir / ba_context["output_dir_suffix"], dir_ref, ba_context, strict=strict, reference_platform=reference_platform) and all_bit_accurate
              all_bit_accurate = is_bit_accurate(commit_dir / ba_context["output_dir_suffix"], dir_ref, ba_context, strict=strict, reference_platform=reference_platform, manifest_name='manifest.inputs.json') and all_bit_accurate
          if missing_run:
            click.secho(f"ERROR: No reference for '{ba_context['rel_input_path']}'", fg='red')
            all_bit_accurate = False
      else:
        click.secho(f"Reference directory: {reference_rootproject_ci_dir}", fg='cyan', bold=True, err=True)
        all_bit_accurate = True
        for ba_context in ba_contexts:
          all_bit_accurate = is_bit_accurate(commit_dir / ba_context["output_dir_suffix"], reference_rootproject_ci_dir / ba_context["output_dir_suffix"], ba_context, strict=strict, reference_platform=reference_platform) and all_bit_accurate
          all_bit_accurate = is_bit_accurate(commit_dir / ba_context["output_dir_suffix"], reference_rootproject_ci_dir / ba_context["output_dir_suffix"], ba_context, strict=strict, reference_platform=reference_platform, manifest_name='manifest.inputs.json') and all_bit_accurate
    if not all_bit_accurate:
      click.secho(f"\nERROR: results are not bit-accurate to {reference_commits}.", bg='red', bold=True)
      if is_ci:
        click.secho(f"\nTo investigate, go to", fg='red', underline=True)
        for reference_commit in reference_commits:
          click.secho(f"{qaboard_url}/{project.as_posix()}/commit/{commit_id}?reference={reference_commit}&selected_views=bit_accuracy", fg='red')
      exit(1)
