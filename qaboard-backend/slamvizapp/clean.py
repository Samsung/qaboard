#!/usr/bin/env python
"""
Remove expired outputs and artifacts from storage.


```yaml
# qatools.yaml
storage:
  garbage:
    after: 2weeks

# TODO:
    # outputs:
    #   after: 2weeks
    # artifacts:
    #   after: 1year
    # by default, the default reference branch, active commits and milestone are not deleted
    # except:
    #   when_older: 2weeks
    #   except:
    # artifacts:


cleanup:
  except:
    - branch: develop
  when:
  - older: 2w  
  artifacts:
  outputs:
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

# def clean_project(project):


@click.command()
@click.option('--project', 'project_id')
@click.option('--dryrun', is_flag=True)
@click.option('--verbose', is_flag=True)
def clean(project_id, dryrun, verbose):
    projects = db_session.query(Project).all()
    for project in projects:
        if project_id and project.id != project_id:
            continue
        if project.id == 'LSC/Calibration':
            continue # ask Rivka later when the policies are more flexible

        secho(project.id, bold=True)

        gc_config = project.data.get("qatools_config", {}).get("storage", {}).get('garbage', {})
        old_treshold = now - parse_time(gc_config.get('after', '1month'))
        secho(f"deleting data older than {old_treshold}", dim=True)

        # protect milestones defined via qatools.yaml
        project_config = project.data.get("qatools_config", {}).get("project", {})
        protected_refs = [
            project_config.get("reference_branch", "master"),
            *project_config.get("milestones", []),
        ]
        protected_refs = [*protected_refs, *[f'origin/{r}' for r in protected_refs]]
        secho(f"protected: {protected_refs}", dim=True)

        # protect milestones defined via the web application
        # project_commit_milestones = [m['commit'] for m in project.data.get("milestones", {}).values()]
        # secho(f"protected: {project_commit_milestones}", dim=True)

        # .filter(CiCommit.id.notin_(project_commit_milestones))
        commits = (
            db_session.query(CiCommit)
            .filter(CiCommit.project == project)
            .filter(CiCommit.deleted == False)
            .filter(CiCommit.branch.notin_(protected_refs))
            .filter(or_(
                bool(CiCommit.latest_output_datetime) and CiCommit.latest_output_datetime < old_treshold,
                not CiCommit.latest_output_datetime   and CiCommit.authored_datetime < old_treshold,
            ))
            .all()
        )

        # max_date = max(*[c.authored_datetime for c in list(commits)])
        # print(max_date)

        for commit in commits:
            secho(str(commit), fg='cyan')
            # break
            # continue
            outputs = (db_session.query(Output).join(Batch).filter(Batch.ci_commit == commit))
            for o in outputs:
              if o.deleted: continue
              print(o)
              try:
                o.delete(dryrun=dryrun)
                if not dryrun: db_session.add(o)
              except Exception as e:
                print(e)
              # o.delete(ignore=['*.json', '*.txt'])
            # commit.delete(dryrun=dryrun)
            if not dryrun:
              db_session.add(commit)
              db_session.commit()
          # secho(str(commit.deleted), fg='cyan')
            # branches.add(commit.branch)
            # secho(f"deleting artifacts", fg='cyan', dim=True)
            # secho(f"deleting outputs", fg='cyan', dim=True)
            # break
        # print(branches)
        # print(max_date)
        # break
        # continue




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
        groupdict['days'] = groupdict['days'] + 365 * float(intgroupdict['years']) 
        del groupdict['years']
    time_params = {name: float(param) for name, param in groupdict.items() if param}
    return datetime.timedelta(**time_params)


if __name__ == '__main__':
    clean()
