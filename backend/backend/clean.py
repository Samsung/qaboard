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
      keep:     # optionnal...
      - binary  #
```

Notes:
- If you change those settings, old artifacts don't get deleted.
- When runs use a commit that was deleted, or you upload manifests for a deleted commit, it is marked undeleted.
```

"""
import re
import sys
import json
import datetime
import subprocess
from pathlib import Path

import click
from click import secho
from sqlalchemy import func, and_, asc, or_, not_

from .database import db_session, Session
from .fs_utils import rmtree
from .models import Project, CiCommit, Batch, Output


now = datetime.datetime.utcnow()


# TODO: remove __all__ the output folders for deleted results +3months
# TODO: remove all files in artifacts by fixing permission issues

@click.command()
@click.option('--clean-untracked-artifacts', is_flag=True, help="Delete untracked artifacts")
@click.option('--artifacts-root', 'artifacts_roots', multiple=True, required=True, help="Where to look for artifacts")
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
            '/stage/algo_data/ci/CDE-Users/HW_ALG/commits',
            '/algo/CIS_artifacts/CDE-Users/HW_ALG',
            '/algo/PSP_2x_artifacts/CDE-Users/HW_ALG',
            '/algo/KITT_ISP_artifacts/CDE-Users/HW_ALG',
            # '/stage/algo_data/ci/CDE-Users/HW_ALG',
        ]
    for artifacts_root in artifacts_roots:
        artifacts_root = Path(artifacts_root)
        def iter_hashsha_dir():
            # artifacts_root = Path('/stage/algo_data/ci/CDE-Users/HW_ALG/commits')
            # for directory in artifacts_root.iterdir():
            #     hexsha = directory.name.split('__')[-1]
            #     yield hexsha, directory
            # return?
            for hash2 in artifacts_root.iterdir():
                if len(hash2.name) != 2:
                    continue
                for hash16 in hash2.iterdir():
                    hexsha = hash2.name + hash16.name
                    yield hexsha, hash16

        for hexsha, artifact_dir in iter_hashsha_dir():
            commit = hwalg.repo.commit(hexsha)
            try:
                created_datetime = commit.authored_datetime
            except: # force pushes, rebases... some commits won't be fetched
                ctime = artifact_dir.stat().st_ctime
                created_datetime = datetime.datetime.fromtimestamp(ctime).astimezone()
            is_old = created_datetime < now.astimezone() - parse_time('3weeks')
            if is_old and not any([c.startswith(commit.hexsha) for c in milestone_commits]):
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
                # return



@click.command()
@click.option('--project', 'project_ids', help="Regular expressions to match projects", multiple=True)
@click.option('--before', help="Overwrites what's defined in the project config. 1month, 3days..")
@click.option('--can-delete-reference-branch', is_flag=True, help="Allows deleting results on the reference branch (e.g. master/develop). The latest commit will be kept.")
@click.option('--can-delete-outputs/--cannot-delete-outputs', is_flag=True, default=True, help="Allows deleting artifacts.")
@click.option('--can-delete-artifacts', is_flag=True, help="Allows deleting artifacts.")
@click.option('--dryrun', is_flag=True)
@click.option('--verbose', is_flag=True)
def clean(project_ids, before, can_delete_reference_branch, can_delete_outputs, can_delete_artifacts, dryrun, verbose):
    if before and not project_ids:
        secho('[ERROR] when using --before you need to use --project', fg='red')
        exit(1)

    projects = db_session.query(Project) #.filter(Project.id == 'CDE-Users/HW_ALG/CIS')
    for project in projects:
        if project.data.get("legacy"):
            continue
        if project_ids and not any([re.match(project_id, project.id) for project_id in project_ids]):
            continue
        secho(project.id, fg='blue', bold=True)
        if not project.repo:
            secho(f'[WARNING] Could not clone/read the git repo for {project.id}', fg='yellow')
            # return
            continue

        try:
            gc_config = project.data.get("qatools_config", {}).get("storage", {}).get('garbage', {})
        except: # e.g. storage is defined as a single string
            gc_config = {}
        can_delete_reference_branch = can_delete_reference_branch or gc_config.get('can_delete_reference_branch')
        before = gc_config.get('after', '1month') if not before else before
        old_treshold = now - parse_time(before)
        secho(f"deleting data older than {old_treshold}", dim=True)

        commits = (
            db_session.query(CiCommit)
            .filter(CiCommit.project == project)
            .filter(CiCommit.deleted == False)
            # we could check those rare occurences from python-land...
            .filter(CiCommit.hexsha.notin_(project.milestone_commits))
            .filter(or_(
                bool(CiCommit.latest_output_datetime) and CiCommit.latest_output_datetime < old_treshold,
                not CiCommit.latest_output_datetime   and CiCommit.authored_datetime < old_treshold,
            ))
            .order_by(CiCommit.authored_datetime.desc())
            
        )
        if not can_delete_reference_branch:
            commits = commits.filter(CiCommit.branch.notin_(project.protected_refs))

        for commit in commits.all():
            # if '/algo/' not in str(commit.artifacts_dir):
            #     continue
            # print(commit.artifacts_dir)
            # cis_dir = str(self.artifacts_dir).replace("KITT_ISP", "CIS")
            # continue
            secho(f"@{commit.project_id}  {commit.branch}  {commit.hexsha} {commit.authored_datetime}", fg='cyan')
            outputs = (db_session.query(Output).join(Batch).filter(Batch.ci_commit_id == commit.id))

            nb_outputs = 0
            nb_outputs_deleted = 0
            for o in outputs:
              if not can_delete_outputs:
                  continue
              nb_outputs += 1
              if o.deleted:
                  continue
              nb_outputs_deleted += 1
              print(" ", o)
              try:
                o.delete(dryrun=dryrun)  # ignore=['*.json', '*.txt'],
                if not dryrun:
                    db_session.add(o)
              except Exception as e:
                print(e)
                # raise e
                try:
                    o.update_manifest()
                except:
                    pass
            gc_config_artifacts = gc_config.get('artifacts', {})
            deleted_artifacts = False
            if gc_config_artifacts.get('delete') == True or can_delete_artifacts:
                secho(f"  Deleting artifacts", fg='cyan', dim=True)
                try:
                    commit.delete(keep=gc_config_artifacts.get('keep', []), dryrun=dryrun)
                    deleted_artifacts = True
                except Exception as e:
                    print(e)
                    continue
            if not dryrun:
              if nb_outputs_deleted or deleted_artifacts:
                db_session.add(commit)
              if not nb_outputs and deleted_artifacts and can_delete_outputs:
                print(f"DELETE {commit}")
                db_session.delete(commit)
              db_session.commit()



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
