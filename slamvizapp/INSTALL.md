# Installation instructions
> The **Dockerfile** is the reference on how to install this application.

For reference, here are installation instructions.

## Sync with the `dvs/psp_swip` repository
- Clone the `psp_swip` repository at a location specified in the `SLAMVIZAPP_DATA` environment variable:

```bash
cd $SLAMVIZAPP_DATA
git clone git@gitlab-srv:dvs/psp_swip.git
```

## Application setup
You need:
- `git`
- `python3.6`: the [annaconda distribution](https://www.continuum.io/downloads) is the easiest way.

Now install this application and its dependencies as a regular python package:

```bash
pip install --editable .                   # edits to the code will be seen
#           --proxy http://dlp2-wcg01:8080 # from IT's "vdi" servers
#            -k                            # to trust Samsung's SSL certificate

# If you want a clean and dedicated python environment, consider using virtualenv/conda
# pip install virtualenv; virtualenv venv; . venv/bin/activate 
```

If the python dependencies change, make the Docker build faster with:
```bash
pip freeze requirements-freeze.txt
# TODO: use pipenv... https://docs.pipenv.org/
```


## Database setup
You will need a database accessible:
* The default configuration expects a `postgreSQL` database available on *localhost* ([download](https://www.postgresql.org/download)). The *Dockerfile* provides setup instructions.
* Since we work with `sqlalchemy` as ORM, we can pick almost any database. If needed, you can change the database user, password, host, type... using environment variables like `SLAMVIZAPP_DB_USER`. To know more, read *database.py*.

To initialize the database run:

```bash
./slamvizapp_init_database
# --help
# --drop-all   Drop all the tables before the import.
# --loop       Keep looking for new results.
```

## Run the backend
```bash
FLASK_APP=slamvizapp FLASK_DEBUG=1 flask run --host 0.0.0.0 --with-threads
```

## Optionnal configuration
* To run the app using fancier tools (HTTP2, SSL, wsgi and reverse proxies...), read the [deployment instructions](deployment/README.md).
* Make sure the app receives notifications (aka webhooks) whenever someone pushes changes to [gitlab](http://gitlab-srv/dvs/psp_swip). In `psp_swip`'s [*integrations settings*](http://gitlab-srv/dvs/psp_swip/settings/integrations) setup a webhook to `$YOUR_HOSTNAME/webhook/gitlab`.
