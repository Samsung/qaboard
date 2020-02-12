#!/usr/bin/env python
"""
Aggregates results from `qa batch`.

Usage:
```bash
qa batch my-batch
./qa_aggregate my-batch
#=> prints summary statistics on STDOUT
``

This script is an example, adapt it to your needs!


Troubleshooting:
- "Permission denied" => chmod +x qa_aggregate.py
- "WARNING: Could not find expected metrics " => if working on SIRC's share storage, wait ~30s for the sync after `qa batch`
"""
import os
import sys
import json
import subprocess
from pathlib import Path

import click
from qatools.config import root_qatools, available_metrics




def aggregate():
    command = [
        "qa",
        # just to be sure we don't make unnecessary network calls
        "--offline",
        "batch",
        # we could use --list to get more detailed data as JSON
        "--list-output-dirs",
        *sys.argv[1:],
    ]
    click.secho(f"Aggregating: {' '.join(command)}", err=True, dim=True)
    process = subprocess.run(
        command,
        check=True,
        encoding='utf-8',
        capture_output=True, # requires python3.7, easy to replace...
    )
    # We could do more error handling, print nice error messages..
    # https://docs.python.org/3/library/subprocess.html
    # print(process, file=sys.stderr)


    # All paths are relative to the root of the repository
    if root_qatools != Path().resolve():
        click.echo(click.style("Working	directory changed to: ", fg='cyan') + click.style(str(root_qatools), fg='cyan', bold=True), err=True)
        os.chdir(root_qatools)


    batch_metrics = []
    # Gather metrics from all runs
    output_dirs = process.stdout.splitlines()
    for output_dir in output_dirs:
        output_dir = Path(output_dir)
        metrics_path = output_dir / 'metrics.json'
        if not metrics_path.exists():
            click.secho('WARNING: Could not find expected metrics at "{metrics_path}"', fg='yellow')
            continue
        with metrics_path.open() as f:
            metrics = json.load(f)
        batch_metrics.append(metrics)

    # print(batch_metrics, file=sys.stderr)
    import pandas as pd
    metrics_df = pd.DataFrame(data=batch_metrics)
    # print(metrics_df, file=sys.stderr)

    # https://pandas.pydata.org/pandas-docs/stable/reference/api/pandas.DataFrame.describe.html
    stats = metrics_df.describe()
    print(stats)

    # To get metadata on each metrics, you can call
    # available_metrics['rmse_mean'] to get nice labels, or scale/suffix for display  


if __name__ == "__main__":
    aggregate()
