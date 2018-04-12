#!/usr/bin/env python
from pathlib import Path
import click
import time

ci_directory = Path('/home/arthurf/ci/dvs/psp_swip/commits')


def do_migrate():
  for folder in ci_directory.glob('*/output/*'):
    if folder.is_file(): continue
    if folder.name=='lsf': continue

    *output_folder, start_of_name = folder.parts
    new_folder = Path(*output_folder) / 'lsf' / 'serial-stereo' / start_of_name
    new_folder.parent.mkdir(parents=True, exist_ok=True)
    print(f'{folder} -> {new_folder}')
    folder.rename(new_folder)


@click.command()
@click.option('--loop', is_flag=True)
def migrate(loop):
  do_migrate()
  while loop:
    print('sleeping...')
    time.sleep(60)
    do_migrate()


if __name__ == '__main__':
    migrate()
