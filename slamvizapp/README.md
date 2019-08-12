## slamvizapp-backend
Backend for `slamvizapp` built as a [flask](https://flask.pocoo.org) application.


 that handle all our HTTP needs.

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
pg_dump --dbname=slamvizapp --username=ci --password -h localhost  > backup.07-01-2019.sql

```

# Recovery
```bash
> docker exec -it qaboard-production bash
export LC_ALL=C.UTF-8 LANG=C.UTF-8
ps -aux | grep '\(flask run\|sudo .*uwsgi\)' | grep -v grep | awk '{print $2}' | xargs -I{} sudo kill {}
auth='--username=ci --password -h localhost'
PGPASS=$HOME/.pgpass
auth='--username=ci --no-password -h localhost'

dropdb $auth  slamvizapp
# Password:
createdb -T template0 $auth slamvizapp
Password:
$ pg_restore $auth --dbname slamvizapp /home/ispq/qaboard/database_backups/2019-03-21.dump
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
postgresqltuner.pl --host=localhost --database=slamvizapp --user=ci --password=dvsdvs

# note that the database configuration is here
nano /etc/postgresql/9.6/main/postgresql.conf

# you could also use pgbadger:
# https://github.com/dalibo/pgbadger
```

