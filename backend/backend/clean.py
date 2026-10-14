#!/usr/bin/env python
"""
Remove old outputs and artifacts from storage.
By default, the default reference branch, active commits and milestone are not deleted

The default configuration is:
```yaml
# qaboard.yaml
storage:
  garbage:
    after: 1month
    # supports human-readable values: `2weeks`, `1year`, `3months`...
```


**Artifacts** are not deleted by default, you have to specify:

```yaml
storage:
  garbage:
    after: 1month
    artifacts:
      delete: true
      keep:     # optional...
      - binary  #
```

Notes:
- If you change those settings, old artifacts don't get deleted.
- When runs use a commit that was deleted, or you upload manifests for a deleted commit, it is marked undeleted.
"""
import re
import sys
import json
import glob
import datetime
from pathlib import Path

import click
from click import secho
from sqlalchemy import func, or_, not_

from .database import db_session
from .models import Project, CiCommit, Batch, Output


now = datetime.datetime.utcnow()


def mark_artifacts_deleted(hexsha, project_prefix, deleted_dir, by):
    """Marks as deleted the artifacts of a commit in the projects of a repository whose artifacts were in a folder we deleted."""
    db_session.expunge_all() # don't save the helper CiCommit objects
    commits = (db_session.query(CiCommit)
               .filter(CiCommit.hexsha.startswith(hexsha))
               .filter(or_(CiCommit.project_id == project_prefix, CiCommit.project_id.startswith(f"{project_prefix}/"))))
    for commit in commits:
        try:
            if not Path(commit.artifacts_dir).resolve().is_relative_to(Path(deleted_dir).resolve()):
                continue # stored in another artifacts root
        except Exception as e:
            print(f"WARNING: {commit}: {e}")
            continue
        commit.deleted = True
        commit.data = {**(commit.data or {}), 'artifacts_deleted': {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "by": by}}
        db_session.add(commit)
    db_session.commit()


# TODO: remove __all__ the output folders for deleted results +3months
# TODO: remove all files in artifacts by fixing permission issues

@click.command()
@click.option('--clean-untracked-artifacts', is_flag=True, help="Delete untracked artifacts")
@click.option('--artifacts-root', 'artifacts_roots', multiple=True, help="Where to look for artifacts")
@click.option('--use-cache', is_flag=True, help="Cache protected commits from milestones")
def clean_untracked_hwalg_artifacts(clean_untracked_artifacts, artifacts_roots, use_cache):
    """
    WARNING: don't run this unless you know what you are doing
    """
    from .git_utils import git_pull
    cache_path = Path('cache.milestones.json')
    if cache_path.exists() and use_cache:
        secho("WARNING: Using CACHED MILESTONES commits", fg='yellow')
        milestone_commits = set(json.loads(cache_path.read_text()))
    else:
        milestone_commits = set()
        projects = (db_session
                    .query(Project)
                    .filter(Project.id.startswith('CDE-Users/HW_ALG'))
                    .filter(not_(Project.id.startswith('CDE-Users/HW_ALG/ALG_GEN')))
        )
        for project in projects:
            print(project)
            milestone_commits.update(set(project.milestone_commits))
        with cache_path.open('w') as f:
            json.dump(list(milestone_commits), f)
    secho(f"Protecting {len(milestone_commits)} commits", fg='blue')

    hwalg = db_session.query(Project).filter(Project.id == 'CDE-Users/HW_ALG').one()
    git_pull(hwalg.repo)

    if not artifacts_roots:
        artifacts_roots = [
            # '/stage/algo_data/ci/CDE-Users/HW_ALG/commits',
            '/algo/CIS_artifacts/CDE-Users/HW_ALG',
            '/algo/PSP_2x_artifacts/CDE-Users/HW_ALG',
            '/algo/KITT_ISP_artifacts/CDE-Users/HW_ALG',
            # '/stage/algo_data/ci/CDE-Users/HW_ALG',
        ]
    for artifacts_root in artifacts_roots:
        artifacts_root = Path(artifacts_root)
        def iter_hashsha_dir():
            for hash2 in artifacts_root.iterdir():
                if len(hash2.name) != 2:
                    continue
                for hash16 in hash2.iterdir():
                    hexsha = hash2.name + hash16.name
                    yield hexsha, hash16

        for hexsha, artifact_dir in iter_hashsha_dir():
            try:
                commit = hwalg.repo.commit(hexsha)
                hexsha = commit.hexsha
            except: # force pushes, rebases... some commits won't be fetched
                commit = None
            try:
                created_datetime = commit.authored_datetime
            except:
                ctime = artifact_dir.stat().st_ctime
                created_datetime = datetime.datetime.fromtimestamp(ctime).astimezone()
            is_old = created_datetime < now.astimezone() - parse_time('3weeks')
            if is_old and not any([c.startswith(hexsha) for c in milestone_commits]):
                print('DELETE', artifact_dir, created_datetime)
                ci_commit = CiCommit(
                    hexsha=hexsha,
                    project=hwalg,
                )
                try:
                    nb_manifests_dir = 0
                    for qatools_path in artifact_dir.rglob('manifests'):
                        nb_manifests_dir += 1
                        ci_commit.commit_dir_override = qatools_path.parent
                        print(ci_commit.commit_dir_override)
                        ci_commit.delete()
                    if not nb_manifests_dir:
                        ci_commit.commit_dir_override = artifact_dir
                        print(ci_commit.commit_dir_override)
                        ci_commit.delete()
                except Exception as e: # empty parent folders will be deleted, including the folder we iterate in...
                    # __pycache__ can be owned by a different user that the one that created the folder...
                    print(e)
                # ci_commit is only a helper, not the commits QA-Board knows: tell them their artifacts are gone
                mark_artifacts_deleted(hexsha, 'CDE-Users/HW_ALG', artifact_dir, by="clean_untracked_hwalg_artifacts")
                # return



@click.command()
@click.option('--outputs-root', 'outputs_roots', multiple=True, help="Where to look for outputs")
@click.option('--use-cache', is_flag=True, help="Cache protected commits from milestones")
@click.option('--user', required=True, help="The user name to delete the quota for")
def clean_untracked_hwalg_outputs(outputs_roots, user, use_cache):
    """
    WARNING: don't run this unless you know what you are doing
    """
    from .git_utils import git_pull
    cache_path = Path('cache.milestones.json')
    if cache_path.exists() and use_cache:
        secho("WARNING: Using CACHED MILESTONES commits", fg='yellow')
        milestone_commits = set(json.loads(cache_path.read_text()))
    else:
        milestone_commits = set()
        projects = (db_session
                    .query(Project)
                    .filter(Project.id.startswith('CDE-Users/HW_ALG'))
                    .filter(not_(Project.id.startswith('CDE-Users/HW_ALG/ALG_GEN')))
        )
        for project in projects:
            print(project)
            milestone_commits.update(set(project.milestone_commits))
        with cache_path.open('w') as f:
            json.dump(list(milestone_commits), f)

    secho(f"Protecting {len(milestone_commits)} commits", fg='blue')
    hwalg = db_session.query(Project).filter(Project.id == 'CDE-Users/HW_ALG').one()
    git_pull(hwalg.repo)
    if not outputs_roots:
        outputs_roots = [
            f"/algo/CIS/outputs/{user}/CDE-Users/HW_ALG",
            f"/algo/PSP_2x/outputs/{user}/CDE-Users/HW_ALG",
            f"/algo/KITT_ISP/outputs/{user}/CDE-Users/HW_ALG",
        ]

    outputs_roots = [glob.glob(outputs_root) for outputs_root in outputs_roots]
    outputs_roots = [item for sublist in outputs_roots for item in sublist] # flatten list
    for outputs_root in outputs_roots:
        outputs_root = Path(outputs_root)
        def iter_hashsha_dir():
            for hash2 in outputs_root.iterdir():
                if len(hash2.name) != 2:
                    continue
                for hash16 in hash2.iterdir():
                    hexsha = hash2.name + hash16.name
                    yield hexsha, hash16

        for hexsha, output_dir in iter_hashsha_dir():
            try:
                commit = hwalg.repo.commit(hexsha)
                hexsha = commit.hexsha
            except: # force pushes, rebases... some commits won't be fetched
                commit = None
                print(f"commit {hexsha} doesn't exist in DB")
            try:
                created_datetime = commit.authored_datetime
            except:
                ctime = output_dir.stat().st_ctime
                created_datetime = datetime.datetime.fromtimestamp(ctime).astimezone()

            is_old = created_datetime < now.astimezone() - parse_time('3weeks')
            if is_old and not any([c.startswith(hexsha) for c in milestone_commits]):
                print('DELETE', output_dir, created_datetime)
                ci_commit = CiCommit(
                    hexsha=hexsha,
                    project=hwalg,
                )
                try:
                    nb_manifests_dir = 0
                    for qatools_path in output_dir.rglob('manifests'):
                        nb_manifests_dir += 1
                        ci_commit.commit_dir_override = qatools_path.parent
                        print(ci_commit.commit_dir_override)
                        ci_commit.delete()
                    if not nb_manifests_dir:
                        ci_commit.commit_dir_override = output_dir
                        print(ci_commit.commit_dir_override)
                        ci_commit.delete()
                except Exception as e: # empty parent folders will be deleted, including the folder we iterate in...
                    # __pycache__ can be owned by a different user that the one that created the folder...
                    print(e)
                # return



@click.command()
@click.option('--project', 'project_ids', help="Regular expressions to match projects", multiple=True)
@click.option('--before', help="Overwrites what's defined in the project config. 1month, 3days..")
@click.option('--can-delete-reference-branch', is_flag=True, help="Allows deleting results on the reference branch (e.g. master/develop). The latest commit will be kept.")
@click.option('--can-delete-outputs/--cannot-delete-outputs', is_flag=True, default=True, help="Allows deleting outputs.")
@click.option('--can-delete-artifacts', is_flag=True, help="Allows deleting artifacts, even if the project's qaboard.yaml doesn't ask for it.")
@click.option('--dryrun', is_flag=True, help="Only print what would be deleted: nothing is deleted or changed in the database.")
@click.option('--verbose', is_flag=True)
def clean(project_ids, before, can_delete_reference_branch, can_delete_outputs, can_delete_artifacts, dryrun, verbose):
    if before and not project_ids:
        secho('[ERROR] when using --before you need to use --project', fg='red')
        exit(1)
    if dryrun:
        secho('DRYRUN: nothing will be deleted', fg='yellow', bold=True)

    totals = {"commits": 0, "outputs": 0, "artifacts": 0, "artifacts_files": 0, "errors": 0}
    projects = db_session.query(Project).all()
    for project in projects:
        if project.data.get("legacy"):
            continue
        if project_ids and not any([re.match(project_id, project.id) for project_id in project_ids]):
            continue
        secho(project.id, fg='blue', bold=True)
        if not project.repo:
            # we need git to know which commits are milestones
            secho(f'[WARNING] Could not clone/read the git repo for {project.id}, skipping it', fg='yellow')
            continue

        try:
            gc_config = project.data.get("qatools_config", {}).get("storage", {}).get('garbage', {}) or {}
        except: # e.g. storage is defined as a single string
            gc_config = {}
        # each project has its own settings: don't reuse the previous project's
        project_can_delete_reference_branch = can_delete_reference_branch or gc_config.get('can_delete_reference_branch')
        project_before = before if before else gc_config.get('after', '1month')
        try:
            # an empty value would mean "delete everything"
            if not isinstance(project_before, str) or not project_before.strip():
                raise ValueError(f"expected a duration like 1month or 2weeks, got {project_before!r}")
            old_treshold = now - parse_time(project_before.strip())
        except Exception as e:
            secho(f'[ERROR] storage.garbage.after: {e}', fg='red')
            totals["errors"] += 1
            continue
        gc_config_artifacts = gc_config.get('artifacts', {}) or {}
        project_can_delete_artifacts = gc_config_artifacts.get('delete') == True or can_delete_artifacts
        secho(f"deleting data older than {old_treshold}{', with artifacts' if project_can_delete_artifacts else ''}", dim=True)

        milestone_commits = project.milestone_commits
        commits = (
            db_session.query(CiCommit)
            .filter(CiCommit.project == project)
            .filter(CiCommit.deleted == False)
            # commits without outputs are judged by their date
            .filter(func.coalesce(CiCommit.latest_output_datetime, CiCommit.authored_datetime) < old_treshold)
            .order_by(CiCommit.authored_datetime.desc())
        )
        if milestone_commits:
            commits = commits.filter(CiCommit.hexsha.notin_(milestone_commits))
        if not project_can_delete_reference_branch:
            protected_refs = project.protected_refs
            commits = commits.filter(CiCommit.branch.notin_([*protected_refs, *[f'origin/{r}' for r in protected_refs]]))

        for commit in commits.all():
            secho(f"@{commit.project_id}  {commit.branch}  {commit.hexsha} {commit.authored_datetime}", fg='cyan')
            outputs = (db_session.query(Output).join(Batch).filter(Batch.ci_commit_id == commit.id))

            nb_outputs = 0
            nb_outputs_deleted = 0
            if can_delete_outputs:
                for o in outputs:
                    nb_outputs += 1
                    if o.deleted:
                        continue
                    if verbose:
                        print(" ", o)
                    try:
                        o.delete(dryrun=dryrun)
                        nb_outputs_deleted += 1
                    except Exception as e:
                        print(f"  ERROR: {o}: {e}")
                        totals["errors"] += 1
                        if not dryrun:
                            try:
                                o.update_manifest()
                            except:
                                pass
            totals["outputs"] += nb_outputs_deleted

            deleted_artifacts = False
            if project_can_delete_artifacts:
                secho(f"  Deleting artifacts", fg='cyan', dim=True)
                # Files that the other subprojects still use are kept
                keep = gc_config_artifacts.get('keep', []) or []
                try:
                    summary = commit.delete(keep=[keep] if isinstance(keep, str) else keep, dryrun=dryrun, session=db_session, by="garbage collection")
                except Exception as e:
                    # e.g. an unreadable folder: don't stop the cleanup of the other commits
                    secho(f"  ERROR: could not delete the artifacts: {e}", fg='red')
                    summary = {"nb_deleted": 0, "errors": [str(e)]}
                # we keep the commit if something went wrong, so that we try again next time
                deleted_artifacts = not summary["errors"]
                totals["artifacts"] += 1
                totals["artifacts_files"] += summary["nb_deleted"]
                totals["errors"] += len(summary["errors"])
            if nb_outputs_deleted or (project_can_delete_artifacts and summary["nb_deleted"]):
                totals["commits"] += 1
            if not dryrun:
                db_session.add(commit)
                if not nb_outputs and deleted_artifacts and can_delete_outputs:
                    print(f"DELETE {commit}")
                    db_session.delete(commit)
                # the artifacts' state must be saved as soon as possible: if we crash later, we must not lose that they were deleted
                db_session.commit()

        if dryrun:
            db_session.rollback()
        else:
            db_session.commit()

    secho(
        f"{'[DRYRUN] would have deleted' if dryrun else 'Deleted'}: {totals['outputs']} outputs and the artifacts of {totals['artifacts']} commits ({totals['artifacts_files']} files), in {totals['commits']} commits. {totals['errors']} errors.",
        fg='green' if not totals['errors'] else 'yellow', bold=True,
    )



delta_re = re.compile(r'^((?P<years>[\.\d]+?)y(ear)?s?)? *((?P<months>[\.\d]+?)m(onth)?s?)? *((?P<weeks>[\.\d]+?)w(eek)?s?)? *((?P<days>[\.\d]+?)d(ay)?s?)? *((?P<hours>[\.\d]+?)h(our)?s?)? *((?P<minutes>[\.\d]+?)min(ute)?s?)? *((?P<seconds>[\.\d]+?)s(econd)?s?)?$')
def parse_time(time_str):
    """
    Parse a time string e.g. (2h13m) into a timedelta object.
    Modified from virhilo's answer at https://stackoverflow.com/a/4628148/851699
    :param time_str: A string identifying a duration.  (eg. 2h13m)
    :return datetime.timedelta
    """
    parts = delta_re.match(time_str)
    assert parts is not None, f"Could not parse any time information from '{time_str}'.  Examples of valid strings: '1y', '2months 20d', '8h', '2d8h5min20s', '2min4s'"
    groupdict = parts.groupdict()
    if not groupdict.get('days'):
        groupdict['days'] = 0
    else:
        groupdict['days'] = float(groupdict['days'])
    if groupdict.get('weeks'):
        groupdict['days'] = groupdict['days'] + 7 * float(groupdict['weeks'])
        del groupdict['weeks']
    if groupdict.get('months'):
        groupdict['days'] = groupdict['days'] + 31 * float(groupdict['months'])
        del groupdict['months']
    if groupdict.get('years'):
        groupdict['days'] = groupdict['days'] + 365 * float(groupdict['years'])
        del groupdict['years']
    time_params = {name: float(param) for name, param in groupdict.items() if param}
    return datetime.timedelta(**time_params)


if __name__ == '__main__':
    if '--clean-untracked-artifacts' in sys.argv:
        clean_untracked_hwalg_artifacts()
    else:
        clean()
