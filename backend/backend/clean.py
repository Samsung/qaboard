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

        # protect milestones defined via qaboard.yaml
        project_config = project.data.get("qatools_config", {}).get("project", {})
        protected_refs = [
            project_config.get("reference_branch", "master"),
            *project_config.get("milestones", []),
        ]
        # users can write commits as milestones...
        def get_commit(repo, commit):
            try:
                return repo.commit(r)
            except:
                return None
        protected_commit_milestones = [project.repo.commit(r).hexsha for r in protected_refs if get_commit(project.repo, r)]
        secho(f"  protected commit milestones: {protected_commit_milestones}", dim=True)

        protected_refs = [*protected_refs, *[f'origin/{r}' for r in protected_refs]]
        secho(f"  protected branches: {protected_refs}", dim=True)
        # commits store as "branch" the first branch they were seen with. So they are never listed with tags.
        # we need to ask git for info on the milestones refs: what commit does it correspond to?
        repo_tags = [t.tag.tag for t in project.repo.tags if t.tag]
        protected_tags_commits = [project.repo.tags[m].commit.hexsha for m in protected_refs if m in repo_tags]
        secho(f"  protected commits from tags: {protected_tags_commits}", dim=True)       

        # protect milestones defined via the web application
        project_webapp_milestone_commits = [m['commit'] for m in project.data.get("milestones", {}).values()]
        secho(f"  protected commits from webapp: {project_webapp_milestone_commits}", dim=True)

        commits = (
            db_session.query(CiCommit)
            .filter(CiCommit.project == project)
            .filter(CiCommit.deleted == False)
            .filter(CiCommit.branch.notin_(protected_refs))
            .filter(CiCommit.hexsha.notin_(protected_commit_milestones))
            .filter(CiCommit.hexsha.notin_(protected_tags_commits))
            .filter(CiCommit.hexsha.notin_(project_webapp_milestone_commits))
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
            outputs = (db_session.query(Output).join(Batch).filter(Batch.ci_commit == commit))
            # secho(f"  Deleting outputs", fg='cyan', dim=True)
            for o in outputs:
              if o.deleted: continue
              print(" ", o)
              try:
                o.delete(dryrun=dryrun)  # ignore=['*.json', '*.txt'],
                if not dryrun: db_session.add(o)
              except Exception as e:
                print(e)

            gc_config_artifacts = gc_config.get('artifacts', {})
            if gc_config_artifacts.get('delete') == True:
                secho(f"  Deleting artifacts", fg='cyan', dim=True)
                commit.delete(keep=gc_config_artifacts.get('keep', []), dryrun=dryrun)

            if not dryrun:
              db_session.add(commit)
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
        groupdict['days'] = groupdict['days'] + 365 * float(intgroupdict['years']) 
        del groupdict['years']
    time_params = {name: float(param) for name, param in groupdict.items() if param}
    return datetime.timedelta(**time_params)


if __name__ == '__main__':
    clean()
