"""
Implement the API used by the "Export to a shared directory" plugin.
"""
import os
import re
import json
import hashlib
import difflib
from pathlib import Path

from requests.utils import quote
from flask import request, jsonify, make_response
from sqlalchemy import func, and_, asc, or_
from sqlalchemy.orm import joinedload
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy.sql import label

from qatools.utils import copy
from qatools.conventions import deserialize_config
from slamvizapp import app, db_session
from ..models import Project, CiCommit, Batch, slugify_config



differ = difflib.Differ()

def load_commit(project_id, commit_id):
  if not commit_id: return None
  return (db_session
          .query(CiCommit)
          .options( # avoid n+1 queries
            joinedload(CiCommit.batches).
            joinedload(Batch.outputs)
          )
          .filter(
            CiCommit.project_id==project_id,
            CiCommit.hexsha==commit_id,
          )
          .one()
          )




# no need to make a copy - we don't reuse the outputs
def filter_outputs(query, outputs):
  if not query:
    return outputs

  query = query.lower().replace('"', '')
  query = re.sub(r'[=:] +', ':', query)

  tokens = query = query.split()
  negative_tokens = [t[1:] for t in tokens if t.startswith('-')]
  positive_tokens = [t for t in tokens if not t.startswith('-')]

  def match(output):
    extra_parameters = json.dumps(output.extra_parameters).replace('"', '')
    searched = f"{output.test_input.path} {output.platform} {output.configuration} {extra_parameters}".lower()
    # print(searched)
    # not using output.test_input_tags.join() like in the JS
    if any([t in searched for t in negative_tokens]):
      return False
    found = all([t in searched for t in positive_tokens])
    # print(found)
    return (not positive_tokens or found)
  outputs = [o for o in outputs if match(o)]
  return outputs

# Note: already defined in qatools.tuning, but raises instead of returning None
def matching_output(output_reference, outputs):
  """
  Return the output from from a given batch that looks most similar to a given output.
  This helps us compare an output to historical results.
  """
  possible_matching_outputs = [o for o in outputs if o.test_input.path == output_reference.test_input.path]
  valid_outputs = [o for o in possible_matching_outputs if not o.is_pending and not o.is_failed]
  if not valid_outputs: return None

  def match_key(output):
    return (
      5 if output.configuration == output_reference.configuration else 0 +
      3 if output.platform == output_reference.platform else 0 +
      1 if json.dumps(output.extra_parameters, sorted=True) == json.dumps(output_reference.extra_parameters, sorted=True) else 0
    )
  valid_outputs.sort(key=match_key, reverse=True)
  return valid_outputs[0]




@app.route("/api/v1/export")
@app.route("/api/v1/export/")
def export_to_folder():
  project_id = request.args['project']

  new_commit = load_commit(project_id, request.args['new_commit_id'])
  new_batch = new_commit.get_or_create_batch(request.args.get('batch_new', 'default'))
  new_outputs = new_batch.outputs

  if request.args.get('ref_commit_id'):
    ref_commit = load_commit(project_id, request.args['ref_commit_id'])
    ref_batch = ref_commit.get_or_create_batch(request.args.get('batch_ref', 'default'))
    ref_outputs = ref_batch.outputs
  else:
    ref_commit = None
    ref_batch = None
    ref_outputs = []

  filter_new = request.args.get('filter_new')
  filter_ref = request.args.get('filter_ref')
  new_outputs = filter_outputs(filter_new, new_outputs)
  ref_outputs = filter_outputs(filter_ref, ref_outputs)

  # We save the links in a unique folder
  query_string = f"{new_commit.hexsha} {ref_commit.hexsha if ref_commit else ''} {new_batch.id} {ref_batch.id  if ref_batch else ''} {filter_new} {filter_ref}"
  m = hashlib.md5(query_string.encode('utf-8')).hexdigest()
  export_dir = new_commit.commit_dir / 'exports' / m[:8]
  export_dir.mkdir(parents=True, exist_ok=True)

  output_refs = {}
  for output in new_outputs:
    output_refs[output.id] = matching_output(output, ref_outputs)

  # find common characteristics
  common_data = {}
  if not ref_commit or ref_commit.id == new_commit.id:
    common_data['commit'] = new_commit.id
  all_outputs = [*new_outputs, *list(output_refs.values())]
  all_outputs = [o for o in all_outputs if o] # remove None outputs
  all_platforms = {o.platform for o in all_outputs}
  if len(all_platforms) == 1:
    common_data['platform'] = all_outputs[0].platform
  all_configurations = {o.configuration for o in all_outputs}
  if len(all_configurations) == 1:
    common_data['configuration'] = deserialize_config(all_outputs[0].configuration)
  elif len(all_configurations) > 1:
    configuration_prefix = os.path.commonprefix([o.configuration for o in all_outputs])    
    configuration_suffix = reversed(os.path.commonprefix([reversed(o.configuration) for o in all_outputs]))
    common_data['configuration_prefix'] = deserialize_config(configuration_prefix)
    common_data['configuration_suffix'] = deserialize_config(configuration_suffix)

  # To be honest, we really should find what is common in each batch
  # and use @new-* @ref-*. It gives more flexibility for comparing N batches, and can shorten things even more

  all_extra_parameters = set()
  common_extra_parameters = {}
  for o in all_outputs:
    all_extra_parameters.update(set(o.extra_parameters.keys()))
  all_extra_parameters_prefix = os.path.commonprefix([p for p in all_extra_parameters])
  for key in all_extra_parameters:
    values = set()
    for o in all_outputs:
      if not o.extra_parameters: o.extra_parameters = {} 
      o_value = [o.extra_parameters.get(key)]
      values.update(set([str(o_value)]))
    if len(values) == 1:
      if not all_outputs[0].extra_parameters: all_outputs[0].extra_parameters = {} 
      common_extra_parameters[key] = all_outputs[0].extra_parameters.get(key)
  if common_extra_parameters:
    common_data['extra_parameters'] = common_extra_parameters
  with (export_dir / '0.common.json').open('w') as f:
    json.dump(common_data, f, sort_keys=True, indent=2, separators=(',', ': '))



  glob = request.args.get('path', '*')
  for output in new_outputs:
    output_ref = output_refs[output.id]

    if not output_ref or output_ref.id == output.id:
      label_new = ''
      label_ref = ''
    else:
      labels_new = []
      labels_ref = []
      if output.batch.ci_commit.hexsha != output_ref.batch.ci_commit.hexsha:
        labels_new.append(output.batch.ci_commit.hexsha[:4])
        labels_ref.append(output_ref.batch.ci_commit.hexsha[:4])
      if output.platform != output_ref.platform:
        labels_new.append(output.platform)
        labels_ref.append(output_ref.platform)
      if output.configuration != output_ref.configuration: # TODO: only the diffs....
        stringify_config = lambda c: slugify_config(c.replace(configuration_prefix, '').replace(configuration_suffix, '')) 
        labels_new.append(stringify_config(output.configuration))
        labels_ref.append(stringify_config(output_ref.configuration))
      if str(output.extra_parameters) != str(output_ref.extra_parameters):
        tame = lambda o: set(((k.replace(all_extra_parameters_prefix, ''), str(v)) for k, v in o.items()))
        p_new = tame(output.extra_parameters) - tame(common_extra_parameters)
        p_ref = tame(output_ref.extra_parameters) - tame(common_extra_parameters)
        labels_new.append(slugify_config(str(p_new)))
        labels_ref.append(slugify_config(str(p_ref)))
      stitch = lambda l: f"@{'@'.join(l)}"
      label_new = stitch(labels_new)
      label_ref = stitch(labels_ref)

  
    for output_path in output.output_dir.glob(glob):
      output_path_rel = output_path.relative_to(output.output_dir)
      copied_to_rel = copy_path_rel(output, output_path, label=label_new)
      symlink_to(export_dir / copied_to_rel, output_path)
      # copy(output_path, export_dir / copied_to_rel)
      if output_ref and output_ref.id != output.id:
        output_path_ref = output_ref.output_dir / output_path_rel
        if output_path_ref.exists():
          copied_to_rel = copy_path_rel(output_ref, output_path_ref, label=label_ref)
          symlink_to(export_dir / copied_to_rel, output_path_ref)
          # copy(output_path, export_dir / copied_to_rel)

  params = {
    "batch": new_batch.label,
    "reference": ref_commit.hexsha if ref_commit else None,
    "batch_ref": ref_batch.label if ref_batch else None,
    "filter": filter_new if filter_new else None,
    "filter_ref": filter_ref if filter_ref else None,
  }
  params = {k: quote(v) for k, v in params.items() if v}
  url = f"https://qa/{project_id}/commit/{new_commit.hexsha}?{'&'.join(f'{k}={v}' for k, v in params.items())}"
  redirect = f"""<!DOCTYPE HTML>
  <html lang="en-US">
      <head>
          <meta charset="UTF-8">
          <meta http-equiv="refresh" content="0; url={url}">
          <script type="text/javascript">
              window.location.href = "{url}"
          </script>
          <title>Page Redirection</title>
      </head>
      <body>
          <!-- Note: don't tell people to `click` the link, just tell them that it is a link. -->
          If you are not redirected automatically, follow this <a href='{url}'>link to the QA results</a>.
      </body>
  </html>"""
  redirect_file = export_dir / '0.qa.html'
  if not redirect_file.exists():
    with redirect_file.open('w') as f:
      f.write(redirect)

  link_content = f"[InternetShortcut]\nURL={url}\n"
  link_file = export_dir / '0.qa.url'
  if not link_file.exists():
    with link_file.open('w') as f:
      f.write(link_content)
  return jsonify({
  	"export_dir": str(export_dir),
  })





def symlink_to(path_from, path_to):
  try:
    if path_from.exists():
        path_from.unlink()
    os.link(str(path_to), str(path_from))
    # path_from.symlink_to(path_to)
  except:
    pass


def copy_path_rel(output, output_path, label):
  output_path_rel = output_path.relative_to(output.batch.output_dir)
  # we remove the platform, configuration, and tuning hashes
  levels_to_ignore = 2 if output.batch.label == 'default' else 4
  copied_rel = Path(*output_path_rel.parts[levels_to_ignore:])
  copied_rel = copied_rel.parent / f"{output_path_rel.stem}{label}{output_path_rel.suffix}" 
  copied_rel = str(copied_rel).replace('/', '•') # or \ ? or just name .... ??
  return copied_rel


def diff(s1, s2):
  p_diff = list(differ.compare(s1, s2))
  p_new = ''.join([s[2:] for s in p_diff if s.startswith('+')])
  p_ref = ''.join([s[2:] for s in p_diff if s.startswith('-')])
  return p_new, p_ref
