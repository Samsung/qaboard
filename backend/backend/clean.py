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
import datetime

import click
from click import secho
from sqlalchemy import func, and_, asc, or_

from .database import db_session, Session
from .models import Project, CiCommit, Batch, Output


now = datetime.datetime.utcnow()



@click.command()
@click.option('--project', 'project_ids', help="Regular expressions to match projects", multiple=True)
@click.option('--before', help="Overwrites what's defined in the project config. 1month, 3days..")
@click.option('--can-delete-reference-branch', is_flag=True, help="Allows deleting results on the reference branch (e.g. master/develop). The latest commit will be kept.")
@click.option('--dryrun', is_flag=True)
@click.option('--verbose', is_flag=True)
def clean(project_ids, before, can_delete_reference_branch, dryrun, verbose):
    if before and not project_ids:
        secho('[ERROR] when using --before you need to use --project', fg='red')
        exit(1)

    projects = db_session.query(Project)
    for project in projects:
        if project_ids and not any([re.match(project_id, project.id) for project_id in project_ids]):
            continue
        secho(project.id, fg='blue', bold=True)
        if not project.repo:
            secho(f'[WARNING] Could not clone/read the git repo for {project.id}', fg='yellow')
            # return
            continue

        gc_config = project.data.get("qatools_config", {}).get("storage", {}).get('garbage', {})
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
            secho(f"@{commit.project_id}  {commit.branch}  {commit.hexsha} {commit.authored_datetime}", fg='cyan')
            outputs = (db_session.query(Output).join(Batch).filter(Batch.ci_commit_id == commit.id))

            nb_outputs = 0
            nb_outputs_deleted = 0
            for o in outputs:
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
                o.update_manifest()

            gc_config_artifacts = gc_config.get('artifacts', {})
            if gc_config_artifacts.get('delete') == True:
                secho(f"  Deleting artifacts", fg='cyan', dim=True)
                commit.delete(keep=gc_config_artifacts.get('keep', []), dryrun=dryrun)

            if not dryrun:
              if nb_outputs_deleted:
                db_session.add(commit)
              if not nb_outputs:
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
    clean()
