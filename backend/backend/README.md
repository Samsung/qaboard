## QA-Board's backend
Backend for `qaboard` built as a [flask](https://flask.pocoo.org) application. It handles all our HTTP needs.

## Overview
[sqlalchemy](http://docs.sqlalchemy.org/en/latest/orm/tutorial.html) maps our classes (defined in [/models](models/)) to database tables:
  * **Projects**
  * Versions of the code, called **CiCommits**
  * Each commit has **Batches** of related **Outputs**
  * Each output was run on a specific **TestInputs**

Flask helps us create an HTTP server. It exposes API endpoints defined in the [api/](api/) folder.
- `/api.py`: read/list data about projects/commits/outputs
- `webhooks.py`: listens for (i) push notification from gitlab (ii) new results sent by `qatools`.
- `tuning.py`: ask for new tuning runs, 

`database.py` manages how we access our database, and connect to the git repository via `gitpython`.

## Backups
```bash
# Take a look at:
# deployment/create-backup.sh

# Manually, you can just do...
# https://www.postgresql.org/docs/9.1/backup-dump.html
export LC_ALL=C.UTF-8
export LANG=C.UTF-8
# from a computer with the  same postgresql major version, run something like...
pg_dump --dbname=qaboard --username=ci --password -h localhost  > backup.07-01-2019.sql

```

# Recovery
```bash
> docker exec -it qaboard-production bash
export LC_ALL=C.UTF-8 LANG=C.UTF-8
ps -aux | grep '\(flask run\|sudo .*uwsgi\)' | grep -v grep | awk '{print $2}' | xargs -I{} sudo kill {}
auth='--username=ci --password -h localhost'
PGPASS=$HOME/.pgpass
auth='--username=ci --no-password -h localhost'

dropdb $auth qaboard
# Password:
createdb -T template0 $auth qaboard
Password:
$ pg_restore $auth --dbname qaboard /home/ispq/qaboard/database_backups/2019-03-21.dump
Password:
$ exit
> docker restart qaboard-production
```


## Changing the database schemas
- when you add/rename/delete tables or fields to the database, you should define a migration
  * we use [`alembic`](http://alembic.zzzcomputing.com/en/latest/tutorial.html) to manage migrations
  * you'll find [many examples here](alembic/versions)


## Monitoring
```
https://hub.docker.com/r/fenglc/pgadmin4/
```

## Application performance
To get information about how much time is spend where in the python code:
```python
from ..utils import profiled
with profiled():
```

[Read here](https://wiki.postgresql.org/wiki/Tuning_Your_PostgreSQL_Server) about how to investigate the database's performance.

From the container, here is how to investigate the database CLI prompt:
```bash
sudo su -
# check performance issues with
# https://github.com/jfcoz/postgresqltuner
apt-get install -y libdbd-pg-perl
<<<<<<< HEAD:backend/backend/README.md
postgresqltuner.pl --host=localhost --database=qaboard --user=ci --password=password
=======
postgresqltuner.pl --host=localhost --database=qaboard --user=ci --password=dvsdvs
>>>>>>> 4a39c1f... Renamed backend.slamvizapp to backend.backend:backend/backend/README.md

# note that the database configuration is here
nano /etc/postgresql/9.6/main/postgresql.conf

# you could also use pgbadger:
# https://github.com/dalibo/pgbadger
```

Profiling and getting an SQL prompt
```

# sudo -u postgres /usr/lib/postgresql/9.6/bin/postgres \
#   -D /var/lib/postgresql/9.6/main \
#   -c config_file=/etc/postgresql/9.6/main/postgresql.conf &
# sudo su postgres
# psql -d qaboard
# \dt
# select count(*) from outputs;
# alter table outputs rename to outputs_backup;
# alembic stamp f6a4bc0b55f8
# alembic upgrade +1
# alembic stamp head
# drop table..
# EXPLAIN ANALYZE SELECT ci_commits.id AS ci_commits_id, ci_commits.project_id AS ci_commits_project_id, ci_commits.authored_datetime AS ci_commits_authored_datetime, ci_commits.branch AS ci_commits_branch, ci_commits.committer_name AS ci_commits_committer_name, ci_commits.message AS ci_commits_message, ci_commits.commit_dir_override AS ci_commits_commit_dir_override, ci_commits.commit_type AS ci_commits_commit_type, ci_commits.time_of_last_batch AS ci_commits_time_of_last_batch, ci_commits.latest_gitlab_pipeline AS ci_commits_latest_gitlab_pipeline, test_inputs_1.id AS test_inputs_1_id, test_inputs_1.path AS test_inputs_1_path, test_inputs_1.database AS test_inputs_1_database, test_inputs_1.data AS test_inputs_1_data, test_inputs_1.stereo_baseline AS test_inputs_1_stereo_baseline, test_inputs_1.is_wide_angle AS test_inputs_1_is_wide_angle, test_inputs_1.duration AS test_inputs_1_duration, test_inputs_1.is_dynamic AS test_inputs_1_is_dynamic, test_inputs_1.is_static AS test_inputs_1_is_static, test_inputs_1.is_calibration AS test_inputs_1_is_calibration, test_inputs_1.is_low_light AS test_inputs_1_is_low_light, test_inputs_1.is_flickering AS test_inputs_1_is_flickering, test_inputs_1.is_hdr AS test_inputs_1_is_hdr, test_inputs_1.motion_is_translation AS test_inputs_1_motion_is_translation, test_inputs_1.motion_is_rotation AS test_inputs_1_motion_is_rotation, test_inputs_1.motion_axis AS test_inputs_1_motion_axis, test_inputs_1.motion_speed AS test_inputs_1_motion_speed, outputs_1.id AS outputs_1_id, outputs_1.batch_id AS outputs_1_batch_id, outputs_1.created_date AS outputs_1_created_date, outputs_1.output_dir_override AS outputs_1_output_dir_override, outputs_1.output_type AS outputs_1_output_type, outputs_1.test_input_id AS outputs_1_test_input_id, outputs_1.platform AS outputs_1_platform, outputs_1.configuration AS outputs_1_configuration, outputs_1.extra_parameters AS outputs_1_extra_parameters, outputs_1.is_pending AS outputs_1_is_pending, outputs_1.is_running AS outputs_1_is_running, outputs_1.is_failed AS outputs_1_is_failed, outputs_1.metrics AS outputs_1_metrics, outputs_1.data AS outputs_1_data, batches_1.id AS batches_1_id, batches_1.created_date AS batches_1_created_date, batches_1.ci_commit_id AS batches_1_ci_commit_id, batches_1.label AS batches_1_label FROM ci_commits LEFT OUTER JOIN batches AS batches_1 ON ci_commits.id = batches_1.ci_commit_id LEFT OUTER JOIN outputs AS outputs_1 ON batches_1.id = outputs_1.batch_id LEFT OUTER JOIN test_inputs AS test_inputs_1 ON test_inputs_1.id = outputs_1.test_input_id WHERE ci_commits.project_id = 'dvs/psp_swip' AND ci_commits.authored_datetime <= '2018-07-02 13:16:10+00' AND ci_commits.authored_datetime >= '2018-06-28 13:16:10+00' ORDER BY ci_commits.authored_datetime DESC, batches_1.created_date;
```

permissions
```
# quid: check access permissions
# https://gist.github.com/d11wtq/8699521
# eval "$(ssh-agent -s)"
# ssh-add ~/.ssh/id_rsa
# ssh -o StrictHostKeyChecking=no git@gitlab-srv:dvs/psp_swip
# git clone git@gitlab-srv:dvs/psp_swip

```
