"""
Sample implementation of a CLI wrapper using qatools
"""
from qatools import qacli


# the context.obj argument (from the Click package) is a dict with all the information you need:
# recording_path: Pathlib Path
# database_path: Pathlib Path
# platform: string
# configuration: string
# output_directory: Pathlib Path, where you should write
# ...

def run(context):
  filepath_abs = database_directory / ctx.obj['recording_path']
  command = ' '.join([
       f"{ctx.obj['executable']}",
       f'--working_directory "{working_directory}"',
       f'--paramfile params.json',
       f'--paramfile {ctx.obj["configuration"]}',
       f'--paramfile {ctx.obj["tuning_filepath"]}' if 'tuning_filepath' in ctx.obj else '',
       f'--input_path "{filepath_abs}"',
       f'--output_path "{ctx.obj["output_directory"]}"',
  ])
  print(command)
  if dryrun: return
  start = time.time()
  pipes = subprocess.Popen(command, shell=True,
                           encoding='utf-8',
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
  std_out, std_err = pipes.communicate()
  print(std_err.strip(), std_out.strip())
  return {'compute_time': time.time()-start}


from my_metrics import my_favorite_metric
def postprocessing(context, runtime_metrics):
  ground_truth = context["recording_path"] / context["recording_path"]
  metrics = my_favorite_metric(context["output_directory"], ground_truth)
  save_metrics({**runtime_metrics, **metrics})


if __name__=="__main__main"
  qacli(postprocessing=postprocessing, run=run)
  # working directory?
  # add CLI options? eg --roi or --only-metric..
