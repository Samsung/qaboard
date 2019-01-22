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

## Changing the database schemas
- when you add/rename/delete tables or fields to the database, you should define a migration
  * we use [`alembic`](http://alembic.zzzcomputing.com/en/latest/tutorial.html) to manage migrations
  * you'll find [many examples here](alembic/versions)

## Monitoring
```
https://hub.docker.com/r/fenglc/pgadmin4/
```

## Backups
```
# https://www.postgresql.org/docs/9.1/backup-dump.html
export LC_ALL=C.UTF-8
export LANG=C.UTF-8
pg_dump --dbname=slamvizapp --username=ci --password -h localhost  > /var/slamvizapp/backup.07-01-2019.sql

# recovery
psql --username=ci --password -h localhost slamvizapp  < /var/slamvizapp/backup.07-01-2019.sql
pg_restore --clean --username=ci --password -h localhost slamvizapp  < /var/slamvizapp/backup.07-01-2019.sql

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

