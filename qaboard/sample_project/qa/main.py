"""
Sample implementation of a CLI wrapper with QA-Board.
"""
import sys
import subprocess
from pathlib import Path
import click

# Whis will identify runs through GitlabCI or Jenkins.
from qaboard.config import is_ci


def run(context):
  """
  Runs you code, creates files under context.output_dir, and returns metrics.
  """
  click.secho("Edit qa/main.py to run *your* code using the context", fg='blue', bold=True)
  useful_context_keys = (
    'output_dir',         # Where you're expected to save results
    'input_path',         # .database / .rel_input_path
    # 'type',             # Useful if you need to handle different input types.. Read the docs!
    # 'input_metadata',   # Read the docs to enable this!
    'configs',          # List of configurations, the meaning is 100% on your side!
    'params',             # Merge of all the dicts in `configurations` and extra_parameters
    'platform',
    'forwarded_args',     # Extra list of CLI args, eg `qa batch --my-custom-extra-flag`
  )
  cli_formatter = {}
  for key in useful_context_keys:
    value = getattr(context, key)
    cli_formatter[key] = value
    click.secho(f"  .{key}:  {value}", fg='blue')
  # A common thing to do is running an executable: compiled code, python2.7 code
  # or import some python code and run it!

  # To get started with minimal effort and as example,
  # we run the extra CLI flags passed by the user.
  arg_format = lambda a: a.format(**cli_formatter)
  command = " ".join([arg_format(a) for a in context.forwarded_args])

  if command:
    click.secho("Below we run the CLI flags you gave qa:", fg='blue', bold=True)
    click.secho(f"> {command}", fg='blue')
  else:
    click.secho(f"Try to run something! eg:  qa {' '.join(sys.argv[1:])}"+ " 'echo {input_path} => {output_dir}'", fg='blue', bold=True)
    return {"is_failed": False}

  if context.dryrun:
    return {"is_failed": False}

  # We do extra work to capture real-time logs and print it ourselves
  # otherwise it won't show in both STDOUT and the captured log.txt file
  # https://stackoverflow.com/questions/803265/getting-realtime-output-using-subprocess
  process = subprocess.Popen(
    command,
    shell=True,
    cwd=context.output_dir,
    encoding='utf-8',
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    bufsize=1,
    errors='replace',
  )
  while True:
      line = process.stdout.readline()
      if line == '' and process.poll() is not None:
          break
      if line:
          print(line.strip(), flush=True)
  returncode = process.poll()
  if returncode != 0:
    return {"is_failed": True, "returncode": returncode}
  return {"is_failed": False}

  click.secho("Edit qa/main.py: create plots/graphs, return metrics...", fg='cyan', bold=True)
  return {"is_failed": False}



# def postprocess(runtime_metrics, context):
#   """
#   Optionnaly, you can define a `postprocess` function that, just like `run()`, can:
#     1. return a dict with metrics to save in metrics.json
#     2. Create any qualitative outputs you would like to view later (images, movies...)
#   """
#   # it can be as simple as....
#   return runtime_metrics

#   ## Sample ##
#   # You should know what files you algo writes to, and what they mean
#   output_path = context.output_dir / 'my-output.txt'
#   metrics = {"is_failed": not output_path.exists()}
#   if metrics["is_failed"]:
#     return metrics

#   outputs = parse(output_path)
#   create_plots(outputs, context.output_dir)
#   return {
#     **runtime_metrics,
#     **my_metrics(outputs),
#   }
