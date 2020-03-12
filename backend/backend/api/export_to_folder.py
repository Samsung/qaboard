"""
Implement the API used by the "Export to a shared directory" plugin.
"""
import sys
import os
import re
import json
import hashlib
from pathlib import Path

from requests.utils import quote
from flask import request, jsonify, make_response
from sqlalchemy import func, and_, asc, or_
from sqlalchemy.orm import joinedload
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy.sql import label

from qaboard.utils import copy
from qaboard.conventions import deserialize_config, serialize_config
from backend import app, db_session
from ..models import Project, CiCommit, Batch, slugify_config



def load_commit(project_id, commit_id):
  if not commit_id: return None
  try:
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
  except:
    return None



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
    extra_parameters = json.dumps(output.extra_parameters)
    configurations = json.dumps(output.configurations)
    searched = f"{output.test_input.path} {output.platform} {configurations} {extra_parameters}".replace('"', '').lower()
    # print(searched)
    # not using output.test_input_tags.join() like in the JS
    if any([t in searched for t in negative_tokens]):
      return False
    found = all([t in searched for t in positive_tokens])
    # print(found)
    return (not positive_tokens or found)
  outputs = [o for o in outputs if match(o)]
  return outputs


def compatible(o1, o2):
  if o1.test_input.path == o2.test_input.path:
    return True
  if o1.test_input.data and o2.test_input.data and o1.test_input.data.get('id') and o1.test_input.data.get('id') == o2.test_input.data.get('id'):
    return False

# Note: already defined in qatools.tuning, but raises instead of returning None
def matching_output(output_reference, outputs):
  """
  Return the output from from a given batch that looks most similar to a given output.
  This helps us compare an output to historical results.
  """
  possible_matching_outputs = [o for o in outputs if compatible(o, output_reference)]
  valid_outputs = [o for o in possible_matching_outputs if not o.is_pending and not o.is_failed]
  if not valid_outputs: return None

  def match_key(output):
    has_meta_id = output.test_input.data and output_reference.test_input.data and output.test_input.data.get('id')
    return (
      4 if has_meta_id and output.test_input.data.get('id') == output_reference.test_input.data.get('id') else 0 +
      4 if json.dumps(output.configurations, sorted=True) == json.dumps(output_reference.configurations, sorted=True) else 0 +
      # 4 if output.configuration == output_reference.configuration else 0 + # FIXME: a faster property?
      # we can't test for equality with == because of potentially nested dicts... 
      2 if output.platform == output_reference.platform else 0 +
      1 if json.dumps(output.extra_parameters, sorted=True) == json.dumps(output_reference.extra_parameters, sorted=True) else 0
    )
  valid_outputs.sort(key=match_key, reverse=True)
  return valid_outputs[0]



def commonprefix(m):
  # https://github.com/python/cpython/blob/3.7/Lib/genericpath.py#L69
  if not m: return []
  def key(x):
    return (len(x), str(x))
  s1 = min(m, key=key)
  s2 = max(m, key=key)
  for i, c in enumerate(s1):
    print(i, c, file=sys.stderr)
    if c != s2[i]:
      return s1[:i]
  return s1


@app.route("/api/v1/export")
@app.route("/api/v1/export/")
def export_to_folder():
  project_id = request.args['project']

  new_commit = load_commit(project_id, request.args['new_commit_id'])
  if not new_commit:
    return f"ERROR: Commit {request.args['new_commit_id']} not found", 404
  new_batch = new_commit.get_or_create_batch(request.args.get('batch_new', 'default'))
  new_outputs = new_batch.outputs

  if request.args.get('ref_commit_id'):
    ref_commit = load_commit(project_id, request.args['ref_commit_id'])
    if not ref_commit:
      return f"ERROR: Commit {request.args['ref_commit_id']} not found", 404    
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
  query_string = f"{project_id} {new_commit.hexsha} {ref_commit.hexsha if ref_commit else ''} {new_batch.id} {ref_batch.id  if ref_batch else ''} {filter_new} {filter_ref}"
  m = hashlib.md5(query_string.encode('utf-8')).hexdigest()
  export_dir = new_commit.repo_commit_dir / 'share' / m[:8]
  export_dir.mkdir(parents=True, exist_ok=True)

  output_refs = {}
  for output in new_outputs:
    output_refs[output.id] = matching_output(output, ref_outputs)

  # find common characteristics
  common_data = {}
  if not ref_commit or ref_commit.id == new_commit.id:
    common_data['commit'] = new_commit.hexsha
  all_outputs = [*new_outputs, *list(output_refs.values())]
  all_outputs = [o for o in all_outputs if o] # remove None outputs
  all_platforms = {o.platform for o in all_outputs}
  if len(all_platforms) == 1:
    common_data['platform'] = all_outputs[0].platform
  all_configurations = {o.configuration for o in all_outputs}
  if len(all_configurations) == 1:
    common_data['configurations'] = all_outputs[0].configurations
  elif len(all_configurations) > 1:
    all_configurations = [o.configurations for o in all_outputs]
    common_data['configurations_prefix'] = commonprefix(all_configurations)
    all_reversed_configurations = [list(reversed(o.configurations)) for o in all_outputs]
    common_data['configurations_suffix'] = list(reversed(commonprefix(all_reversed_configurations)))
  # To be honest, we really should find what is common in each batch
  # and use @new-* @ref-*. It gives more flexibility for comparing N batches, and can shorten things even more

  all_extra_parameters = set()
  common_extra_parameters = {}
  for o in all_outputs:
    all_extra_parameters.update(set(o.extra_parameters.keys()))
  all_extra_parameters_prefix = commonprefix([p for p in all_extra_parameters])
  for key in all_extra_parameters:
    values = set()
    for o in all_outputs:
      if not o.extra_parameters: o.extra_parameters = {} 
      o_value = [str(o.extra_parameters.get(key))]
      # print(o.id, o_value)
      values.update(set(o_value))
    print(key, values)
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
    if not output_ref:
      output_ref = output

    # we save a mapping label => full into
    label_mappings = {
      'extra_parameters': {},
      'configurations': {},
    }

    def get_labels(output):
      labels = []
      if output.batch.ci_commit.hexsha != common_data.get("commit"):
        labels.append(output.batch.ci_commit.hexsha[:4])
      if output.platform != common_data.get("platform"):
        labels.append(output.platform)
      if not common_data.get("configurations"):
        def strip_config(c):
          c_prefix = serialize_config(common_data.get("configurations_prefix", 'placeholder-placeholder'))
          c_suffix = serialize_config(common_data.get("configurations_suffix", 'placeholder-placeholder'))
          return c.replace(c_prefix, '').replace(c_suffix, '')
        stripped_config = slugify_config(strip_config(output.configuration))
        # list of common SIRC-specific names
        stripped_config = stripped_config.replace('workspace-configurations-', '')
        if stripped_config:
          labels.append(stripped_config)
        label_mappings['configurations'][stripped_config] = output.extra_parameters
      if str(output.extra_parameters) != str(common_data.get("extra_parameters")):
        tame = lambda o: set(((k.replace(all_extra_parameters_prefix, ''), str(v)) for k, v in o.items()))
        p = tame(output.extra_parameters) - tame(common_extra_parameters)
        # print('common_extra_parameters', common_extra_parameters)
        # print('tame(common_extra_parameters)', tame(common_extra_parameters))
        # print('output.extra_parameters', output.extra_parameters)
        # print('tame(output.extra_parameters)', tame(output.extra_parameters))
        # print('p_new', p_new)
        extra_parameters_label = slugify_config(str(p))
        label_mappings['extra_parameters'][extra_parameters_label] = output.extra_parameters
        if p: labels.append(extra_parameters_label)
      stitch = lambda l: f"@{'@'.join(l)}" if l else ''
      label = stitch(labels)
      # print('label', label)
      return label


    label_new = get_labels(output)
    label_ref = get_labels(output_ref)

    if label_mappings['configurations'] or label_mappings['extra_parameters']:
      with (export_dir / '0.mappings.json').open('w') as f:
        json.dump(label_mappings, f, indent=4, sort_keys=True)

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
