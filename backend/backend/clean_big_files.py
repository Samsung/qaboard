#!/usr/bin/env python
import sys
import subprocess
import datetime

from sqlalchemy import func, and_, asc, or_, not_

from .database import db_session, Session
from .models import Output



now = datetime.datetime.utcnow()
from .clean import parse_time
query_start = now - parse_time('6months')
# query_start = now - parse_time('1day')


def main():
    outputs = (db_session
        .query(Output)
        .filter(Output.created_date > query_start)
        .order_by(Output.created_date.desc())
    )
    print(outputs.count())
    nb_bad_files = 0
    total_size = 0
    errors = []
    for output in outputs.all():
        if not output.output_dir.exists():
            continue
        if not (output.output_dir / 'manifest.outputs.json').exists():
            output.update_manifest()
        for path in output.output_dir.rglob('*'):
            size = path.stat().st_size
            if size > 1_000_000_000:
                nb_bad_files += 1
                total_size += size
                print(nb_bad_files, path, size)
                try:
                    path.unlink()
                except:
                    errors.append(path)
                # exit(0)
        # exit(0)
    print(f"{nb_bad_files} files for {total_size}")
    if errors:
        print(f"ERRORS!")
        for e in errors:
            print(e)
        # 237
        with Path('/home/arthurf/errors.txt').open('w') as f:
            for e in errors:
                print(e, file=f)

main()