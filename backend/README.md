# QA-Board Backend
QA-Board's backend built as a [flask](https://flask.pocoo.org) application. It exposes an HTTP API used to read/write all the metadata on QA-Board's runs.

## How to start a development backend
1. First get the code:
```bash
git clone git@gitlab-srv:common-infrastructure/qaboard.git
cd qaboard
```

2. If you want to run a frontend, [go to the README](../webapp/README.md) and without docker run `npm install`.

3. Edit at the top-level of the repository _development.yml_, and replace `arthurf` with your user.

4. Start the server:

```bash
docker-compose -f docker-compose.yml -f development.yml up  -d 

# for more build logs
export BUILDKIT_PROGRESS=plain
```

> **Tip:** If you called `npm install` in the *webapp/*, (see the [README](../webapp)), a frontend connected to the dev backend will also be up on port 3000.

Get logs and a shell with:
```bash
docker-compose -f docker-compose.yml -f development.yml logs -f backend
docker-compose -f docker-compose.yml -f development.yml exec backend bash
```

Edit _development.yml_ as suits your needs to e.g. change connect to another database using `QABOARD_DB_HOST`.

Consult also:
- [Starting QA-Board Guide](https://samsung.github.io/qaboard/docs/deploy).
- [Troubleshooting Guide](https://samsung.github.io/qaboard/docs/backend-admin/troubleshooting).
- To learn how to restore from a backup, read the [upgrade guide](https://samsung.github.io/qaboard/docs/backend-admin/host-upgrades).

At SIRC:
```bash
sudo sysctl -w net.core.somaxconn=65536
```

## Overview
[sqlalchemy](http://docs.sqlalchemy.org/en/latest/orm/tutorial.html) maps our classes (defined in [/models](models/)) to database tables:
  * **Projects**
  * Versions of the code, called **CiCommits**
  * Each commit has **Batches** of related **Outputs**
  * Each output was run on a specific **TestInputs**

Flask helps us create an HTTP server. It exposes API endpoints defined in the [api/](api/) folder.
- `api.py`: read/list data about projects/commits/outputs
- `webhooks.py`: listens for (i) push notification from gitlab (ii) new results sent by `qa`.
- `tuning.py`: ask for new tuning runs, 

`database.py` manages how we access our database, and connects to the git repository via `gitpython`.


## Changing the database schemas
- when you add/rename/delete tables or fields to the database, you should define a migration
  * we use [`alembic`](http://alembic.zzzcomputing.com/en/latest/tutorial.html) to manage migrations
  * you'll find [many examples here](alembic/versions)


## SQL performance
Queries:
- Enable `QABOARD_DB_ECHO=true` to see all SQL queries
- Get an SQL prompt with `docker-compose exec db psql -U qaboard` and play with `EXPLAIN ANALYZE my-query`.
- We now also ship `pgadmin` with QA-Board, on port 5050.

Tuning:
- [Read here](https://wiki.postgresql.org/wiki/Tuning_Your_PostgreSQL_Server) about how to investigate the database's performance.
- Since we moved to `docker-compose` we went back to the default `postgreSQL` config (at */etc/postgresql/XXXX/main/postgresql.conf*). Time to document how to change them!

```bash
# Check performance issues with
# https://github.com/jfcoz/postgresqltuner
apt-get install -y libdbd-pg-perl
postgresqltuner.pl --host=localhost --database=qaboard --user=ci --password=password

# or we can also use pgbadger:
# https://github.com/dalibo/pgbadger
```


## Monitoring & Application performance (WIP)
To get information about how much time is spend where in the python code:
```python
from ..utils import profiled
with profiled():
  ... # code to be profiled
```

