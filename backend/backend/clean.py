#!/usr/bin/env python
"""
Remove old outputs and artifacts from storage.
By default, we keep the results of:
- the reference branch's latest commit, and the branches, tags and commits listed in qaboard.yaml's `project.milestones`,
- the batches saved as milestones in the web app: only those batches, not the commit's other batches.

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
from .durations import parse_time


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



def collect_garbage(select_project, report, before=None, default_after='1month', can_delete_reference_branch=False,
                    can_delete_outputs=True, can_delete_artifacts=False, dryrun=False, verbose=False):
  """
  Deletes the old outputs and artifacts of the projects for which `select_project(project_id)` is true.
  `before` overrides qaboard.yaml's `storage.garbage.after`, `default_after` is for projects that don't set it.
  What happens, and the errors, go to `report` (backend/jobs/report.py): the console, or a job in the database.
  """
  now = datetime.datetime.utcnow()  # not the module's: workers run for days
  if dryrun:
    report.log('DRYRUN: nothing will be deleted', level='warning')

  # the job may resume after an interruption
  finished = set(report.progress.get('projects_finished') or [])
  projects = [p for p in db_session.query(Project).order_by(Project.id).all() if select_project(p.id) and not p.data.get("legacy")]
  report.set(projects_total=len(projects))
  for project in projects:
    if project.id in finished:
      continue
    if report.should_stop():
      return
    report.set(current_project=project.id)
    report.log(project.id, level='title')
    if not project.repo:
      # we need git to know which commits are milestones
      report.error('git', f'Could not clone/read the git repo for {project.id}, skipping it', project_id=project.id)
      report.add(projects_skipped=1)
      continue

    try:
      gc_config = project.data.get("qatools_config", {}).get("storage", {}).get('garbage', {}) or {}
    except: # e.g. storage is defined as a single string
      gc_config = {}
    # each project has its own settings: don't reuse the previous project's
    project_can_delete_reference_branch = can_delete_reference_branch or gc_config.get('can_delete_reference_branch')
    project_before = before if before else gc_config.get('after', default_after)
    try:
      # an empty value would mean "delete everything"
      if not isinstance(project_before, str) or not project_before.strip():
        raise ValueError(f"expected a duration like 1month or 2weeks, got {project_before!r}")
      old_treshold = now - parse_time(project_before.strip())
    except Exception as e:
      report.error('config', f'{project.id}: storage.garbage.after: {e}', project_id=project.id)
      continue
    gc_config_artifacts = gc_config.get('artifacts', {}) or {}
    project_can_delete_artifacts = gc_config_artifacts.get('delete') == True or can_delete_artifacts
    report.log(f"deleting data older than {old_treshold}{', with artifacts' if project_can_delete_artifacts else ''}", level='debug')

    protected_commits = project.protected_ref_commits
    milestone_batches = project.milestone_batches
    report.log(f"keeping {len(protected_commits)} commits protected in qaboard.yaml, and {len(milestone_batches)} milestone batches", level='debug')
    commits = (
        db_session.query(CiCommit)
        .filter(CiCommit.project == project)
        .filter(CiCommit.deleted == False)
        # commits without outputs are judged by their date
        .filter(func.coalesce(CiCommit.latest_output_datetime, CiCommit.authored_datetime) < old_treshold)
        .order_by(CiCommit.authored_datetime.desc())
    )
    if protected_commits:
        commits = commits.filter(CiCommit.hexsha.notin_(protected_commits))
    if not project_can_delete_reference_branch:
        protected_refs = project.protected_refs
        commits = commits.filter(CiCommit.branch.notin_([*protected_refs, *[f'origin/{r}' for r in protected_refs]]))

    for commit in commits.all():
        if report.should_stop():
          if dryrun:
            db_session.rollback()
          return
        report.log(f"@{commit.project_id}  {commit.branch}  {commit.hexsha} {commit.authored_datetime}", level='debug' if not verbose else 'info')
        outputs = (db_session.query(Output).join(Batch).filter(Batch.ci_commit_id == commit.id))
        # We keep the batches that are milestones, and what they need to be redone or compared: the artifacts
        kept_batches = milestone_batches.of_commit(project.id, commit.hexsha)
        if kept_batches:
            report.log(f"  keeping the milestone batches: {', '.join(sorted(kept_batches))}", level='warning')
            outputs = outputs.filter(Batch.label.notin_(kept_batches))

        nb_outputs = 0
        nb_outputs_deleted = 0
        if can_delete_outputs:
            for o in outputs:
                nb_outputs += 1
                if o.deleted:
                    continue
                if verbose:
                    report.log(f"  {o}")
                try:
                    o.delete(dryrun=dryrun)
                    nb_outputs_deleted += 1
                except Exception as e:
                    report.exception(e, path=getattr(o, 'output_dir_override', None), project_id=project.id, batch_id=o.batch_id, output_id=o.id)
                    if not dryrun:
                        try:
                            o.update_manifest()
                        except:
                            pass
        report.add(outputs=nb_outputs_deleted)

        deleted_artifacts = False
        summary = {"nb_deleted": 0, "errors": []}
        if project_can_delete_artifacts and not kept_batches:
            report.log("  Deleting artifacts", level='debug')
            # Files that the other subprojects still use are kept
            keep = gc_config_artifacts.get('keep', []) or []
            try:
                summary = commit.delete(keep=[keep] if isinstance(keep, str) else keep, dryrun=dryrun, session=db_session, by="garbage collection")
            except Exception as e:
                # e.g. an unreadable folder: don't stop the cleanup of the other commits
                summary = {"nb_deleted": 0, "errors": [f"could not delete the artifacts of {commit.hexsha[:8]}: {e}"]}
            for error in summary["errors"]:
                kind = 'permission' if 'Permission denied' in error or 'Errno 13' in error else 'other'
                report.error(kind, error, project_id=project.id)
            # we keep the commit if something went wrong, so that we try again next time
            deleted_artifacts = not summary["errors"]
            report.add(artifacts=1, artifacts_files=summary["nb_deleted"])
        if nb_outputs_deleted or summary["nb_deleted"]:
            report.add(commits=1)
        if not dryrun:
            db_session.add(commit)
            if not nb_outputs and deleted_artifacts and can_delete_outputs and not kept_batches:
                report.log(f"DELETE {commit}", level='debug')
                db_session.delete(commit)
            # the artifacts' state must be saved as soon as possible: if we crash later, we must not lose that they were deleted
            commit_id = commit.id
            db_session.commit()
            if nb_outputs_deleted:
                from .storage_usage import refresh_soon
                refresh_soon(commit_ids=[commit_id])

    if dryrun:
        db_session.rollback()
    else:
        db_session.commit()
    finished.add(project.id)
    report.set(projects_finished=sorted(finished), projects_done=len(finished))
  report.set(current_project=None)

  totals = report.progress
  report.log(
    f"{'[DRYRUN] would have deleted' if dryrun else 'Deleted'}: {totals.get('outputs', 0)} outputs and the artifacts of {totals.get('artifacts', 0)} commits ({totals.get('artifacts_files', 0)} files), in {totals.get('commits', 0)} commits. {report.nb_errors} errors.",
    level='success' if not report.nb_errors else 'warning',
  )


@click.command()
@click.option('--project', 'project_ids', help="Regular expressions to match projects", multiple=True)
@click.option('--before', help="Overwrites what's defined in the project config. 1month, 3days..")
@click.option('--can-delete-reference-branch', is_flag=True, help="Allows deleting results on the reference branch (e.g. master/develop). The latest commit will be kept.")
@click.option('--can-delete-outputs/--cannot-delete-outputs', is_flag=True, default=True, help="Allows deleting outputs.")
@click.option('--can-delete-artifacts', is_flag=True, help="Allows deleting artifacts, even if the project's qaboard.yaml doesn't ask for it.")
@click.option('--dryrun', is_flag=True, help="Only print what would be deleted: nothing is deleted or changed in the database.")
@click.option('--verbose', is_flag=True)
def clean(project_ids, before, can_delete_reference_branch, can_delete_outputs, can_delete_artifacts, dryrun, verbose):
    """
    Deletes old outputs and artifacts. Admins can also schedule it from the web app (Admin > Storage),
    with logs and errors there.
    """
    if before and not project_ids:
        secho('[ERROR] when using --before you need to use --project', fg='red')
        exit(1)
    from .jobs.report import ConsoleReporter
    collect_garbage(
        lambda project_id: not project_ids or any(re.match(p, project_id) for p in project_ids),
        ConsoleReporter(),
        before=before,
        can_delete_reference_branch=can_delete_reference_branch,
        can_delete_outputs=can_delete_outputs,
        can_delete_artifacts=can_delete_artifacts,
        dryrun=dryrun,
        verbose=verbose,
    )



if __name__ == '__main__':
    if '--clean-untracked-artifacts' in sys.argv:
        clean_untracked_hwalg_artifacts()
    else:
        clean()
