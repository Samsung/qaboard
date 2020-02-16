#!/usr/bin/env python
"""
Initializes or updates the database using information from the filesystem.
"""
import time
from pathlib import Path

import click
from alembic.config import Config
from alembic import command

import backend
from backend.database import engine, Session


@click.command()
@click.option('--drop-all', is_flag=True)
@click.option('--verbose', is_flag=True)
def init_database(drop_all, verbose):
  if drop_all:
    # for tbl in reversed(Base.metadata.sorted_tables):
    # engine.execute(tbl.delete())
    if verbose: print('dropping all data')
    Base.metadata.drop_all(engine)
  if verbose: print('creating schema...')
  Base.metadata.create_all(engine)

  stamp_schema_version()


def stamp_schema_version():
  """Write the schema version stamp to the database, in case it is missing."""
  with engine.begin() as connection:
    alembic_cfg = Config()
    alembic_cfg.set_main_option("script_location", "backend:alembic")
    path = Path(backend.__file__).parent / 'alembic.ini'
    alembic_cfg.config_file_name = str(path)
    alembic_cfg.attributes['connection'] = connection
    command.stamp(alembic_cfg, "head")
