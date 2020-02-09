#!/usr/bin/env python
"""
Initializes or updates the database using information from the filesystem.
"""
import time
from pathlib import Path

import click
from alembic.config import Config
from alembic import command

import slamvizapp
from slamvizapp.models import Base, Project, TestInput, Output, Batch, CiCommit
from slamvizapp.database import engine, Session
from .slam.init_database import init_slam_database
from .cis.init_database import init_cis_database


@click.command()
@click.option('--scrap-from', multiple=True, help='slam, cis...')
@click.option('--drop-all', is_flag=True)
@click.option('--loop', is_flag=True)
@click.option('--sleep', default=600)
@click.option('--verbose', is_flag=True)
def init_database(scrap_from, drop_all, loop, sleep, verbose):
  if drop_all:
    # for tbl in reversed(Base.metadata.sorted_tables):
    # engine.execute(tbl.delete())
    if verbose: print('dropping all data')
    Base.metadata.drop_all(engine)
  if verbose: print('creating schema...')
  Base.metadata.create_all(engine)

  stamp_schema_version()
  scrap(scrap_from, verbose)

  while loop:
    if verbose: print('sleeping...')
    time.sleep(sleep)
    scrap(scrap_from, verbose)


def stamp_schema_version():
  """Write the schema version stamp to the database, in case it is missing."""
  with engine.begin() as connection:
    alembic_cfg = Config()
    alembic_cfg.set_main_option("script_location", "slamvizapp:alembic")
    path = Path(slamvizapp.__file__).parent / 'alembic.ini'
    alembic_cfg.config_file_name = str(path)
    alembic_cfg.attributes['connection'] = connection
    command.stamp(alembic_cfg, "head")

def scrap(scrap_from, verbose):
  if 'slam' in scrap_from:
    init_slam_database(verbose=verbose)
  if 'cis' in scrap_from:
    init_cis_database(verbose=verbose)
  if verbose: print_summary()

def print_summary():
  session = Session()
  print(f'#TestInputs : {session.query(TestInput).count()}')
  print(f'#Projects   : {session.query(Project).count()}')
  print(f'#CiCommits  : {session.query(CiCommit).count()}')
  print(f'#Batches    : {session.query(Batch).count()}')
  print(f'#Outputs    : {session.query(Output).count()}')
