"""
The older export API, deprecated: scripts still call it, the web app uses /api/v1/exports (backend/api/export_files.py),
where the caller says how to name files. Its behavior doesn't change until its callers moved: responses say it's
deprecated (`Deprecation` header), with a link to the new API.
One fix: folders matching the pattern are real folders with links (or copies) of their files, not a symbolic link to
the run's folder, that Windows shares can't open ("wide links" are off by default in Samba). Their names are the same.
"""
import os
import json
import shutil
import hashlib
from pathlib import Path

from requests.utils import quote
from functools import wraps
from flask import request, jsonify, g, make_response
from sqlalchemy.orm import joinedload


from qaboard.compat import windows_to_linux_path
from qaboard.conventions import serialize_config
from qaboard.matching import run_distance
from qaboard.filters import match_query, searched_text
from backend import app, db_session

from backend.fs_utils import as_user, mkdir_shared
from backend.storage import check_storage_path, UnsafePathError
from ..models import CiCommit, Batch, slugify_hash
from ..config import qaboard_url
from .auth import login_required, require_project_access
from ..actor import is_same_origin, error as error_response


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



def filter_outputs(query, outputs):
  """The runs a filter of the web app's filter box keeps: the same matching as the web app and `qaboard.runs()` (qaboard/filters.py)"""
  if not query or not query.strip():
    return outputs
  matches = match_query(query)
  def searched(output):
    data = output.data if isinstance(output.data, dict) else {}
    extra_parameters = output.extra_parameters or {}
    if isinstance(data.get('params'), dict):
      extra_parameters = {**extra_parameters, **data['params']}
    return searched_text(
      id=output.id,
      test_input_path=str(output.test_input.path),
      platform=output.platform,
      configurations=output.configurations,
      extra_parameters=extra_parameters,
      test_input_metadata=output.test_input.data.get('metadata') if output.test_input.data else None,
      batch=data.get('batch'),
      is_failed=bool(output.is_failed),
      is_pending=bool(output.is_pending),
      is_running=bool(output.is_running),
    )
  return [o for o in outputs if matches(searched(o))]


def compatible(o1, o2):
  """Whether the runs are on the same input: same path, or same id in their metadata (e.g. inputs that moved)"""
  if o1.test_input.abs_path == o2.test_input.abs_path:
    return True
  if o1.test_input.path == o2.test_input.path:
    return True
  if o1.test_input.data and o2.test_input.data and o1.test_input.data.get('id') and o1.test_input.data.get('id') == o2.test_input.data.get('id'):
    return True
  return False

def matching_output(output_reference, outputs):
  """
  Return the output from a given batch that looks most similar to a given output, like the web app.
  This helps us compare an output to historical results.
  """
  possible_matching_outputs = [o for o in outputs if compatible(o, output_reference)]
  valid_outputs = [o for o in possible_matching_outputs if not o.is_pending]
  if not valid_outputs: return None

  def as_run(output):
    return {'configurations': output.configurations, 'extra_parameters': output.extra_parameters, 'platform': output.platform}
  def match_key(output):
    same_input = output.test_input.abs_path == output_reference.test_input.abs_path or output.test_input.path == output_reference.test_input.path
    return (0 if same_input else 1, *run_distance(as_run(output_reference), as_run(output)))
  valid_outputs.sort(key=match_key)
  return valid_outputs[0]



def commonprefix(m):
  # https://github.com/python/cpython/blob/3.7/Lib/genericpath.py#L69
  if not m: return []
  def key(x):
    return (len(x), str(x))
  s1 = min(m, key=key)
  s2 = max(m, key=key)
  for i, c in enumerate(s1):
    if c != s2[i]:
      return s1[:i]
  return s1


def deprecated(f):
  """Responses tell clients to move to /api/v1/exports"""
  @wraps(f)
  def wrapper(*args, **kwargs):
    response = make_response(f(*args, **kwargs))
    response.headers['Deprecation'] = 'true'
    response.headers['Link'] = '</api/v1/exports>; rel="successor-version"'
    return response
  return wrapper


# POST: it writes in folders. GET for older web apps and scripts.
@app.route("/api/v1/export", methods=['GET', 'POST'])
@app.route("/api/v1/export/", methods=['GET', 'POST'])
@deprecated
@login_required
def export_to_folder():
  # Cookies come with GETs from other websites' links: actor.py only checks the origin of other methods
  if request.method == 'GET' and g.actor.token is None and not is_same_origin():
    return error_response(403, 'cross_site_write', "Exports are sent with POST from QA-Board's pages: QA-Board refused this one, it could come from another website.")
  project_id = request.args['project']
  ref_project_id = request.args.get('ref_project', project_id)
  # it creates links or copies in a folder: an action on the project's runs
  if forbidden := require_project_access(g.user, project_id):
    return forbidden
  # the reference's runs are linked in the export too
  if ref_project_id != project_id and (forbidden := require_project_access(g.user, ref_project_id, 'project.read')):
    return forbidden

  new_commit_id = request.args['new_commit_id']
  new_commit = load_commit(project_id, new_commit_id)
  if not new_commit:
    return jsonify({"error": f"ERROR: Commit {new_commit_id} not found"}), 404
  new_batch_label = request.args.get('batch_new', 'default')
  new_batch = new_commit.get_or_create_batch(new_batch_label)
  new_outputs = new_batch.outputs

  filter_new = request.args.get('filter_new')
  filter_ref = request.args.get('filter_ref')

  if request.args.get('ref_commit_id'):
    ref_commit_id = request.args['ref_commit_id']
    ref_commit = load_commit(ref_project_id, ref_commit_id)
    if not ref_commit:
      return jsonify({"error": f"ERROR: Commit {ref_commit_id} not found"}), 404
    ref_batch_label = request.args.get('batch_ref', 'default')
    ref_batch = ref_commit.get_or_create_batch(ref_batch_label)
    ref_outputs = ref_batch.outputs
    same_ref_new = ref_project_id == project_id and ref_commit_id == new_commit_id and ref_batch_label == new_batch_label and filter_new == filter_ref
    if same_ref_new:
      ref_commit = None
      ref_batch = None
      ref_outputs = []
  else:
    ref_commit = None
    ref_batch = None
    ref_outputs = []

  new_outputs = filter_outputs(filter_new, new_outputs)
  ref_outputs = filter_outputs(filter_ref, ref_outputs)

  # We save the links in a unique folder
  query_string = f"{project_id} {new_commit.hexsha} {ref_commit.hexsha if ref_commit else ''} {new_batch.id} {ref_batch.id  if ref_batch else ''} {filter_new} {filter_ref}"
  m = hashlib.md5(query_string.encode('utf-8')).hexdigest()

  if "export_dir" in request.args:
    export_dir = Path(request.args['export_dir'])
    export_dir = windows_to_linux_path(export_dir).resolve()
  else:
    # all in one place if admins chose it (storage.exports_root), else next to the commit's runs
    from ..exports import default_dir
    export_dir = default_dir(g.user['user_name'], project_id, m) or new_commit.repo_outputs_dir / 'share' / m[:8]
  try:
    check_storage_path(export_dir)
  except UnsafePathError as e:
    return jsonify({"error": f"ERROR: {e}"}), 403

  # In folders that were there before, we only add files: they're someone's, maybe not the user's.
  # We replace files only in the folders of our exports, and never delete folders.
  created = not os.path.lexists(export_dir)
  if created:
    try:
      # all users write their exports there
      mkdir_shared(export_dir)
    except Exception as e:
      return jsonify({"error": f"ERROR: When creating '{export_dir}': {e}"}), 403
  elif not export_dir.is_dir() or export_dir.is_symlink():
    return jsonify({"error": f"ERROR: '{export_dir}' is not a folder"}), 403
  from ..models import Export
  from ..exports import in_chosen_folder
  tracked = Export.query.filter(Export.path == str(export_dir), Export.deleted_at.is_(None)).first()
  # an export a scan found in a folder someone chose isn't ours: users may have other files there
  ours = created or (tracked is not None and not in_chosen_folder(tracked))

  is_export_dir_writable = os.access(export_dir, os.W_OK)
  if not is_export_dir_writable:
    return jsonify({"error": f"The export folder need to be writable by all users. Call 'chmod a+w {export_dir}'"}), 403

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
  all_databases = {o.test_input.database for o in all_outputs}
  if len(all_databases) == 1:
    common_data['database'] = all_outputs[0].test_input.database
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
      values.update(set(o_value))
    if len(values) == 1:
      if not all_outputs[0].extra_parameters: all_outputs[0].extra_parameters = {} 
      common_extra_parameters[key] = all_outputs[0].extra_parameters.get(key)
  if common_extra_parameters:
    common_data['extra_parameters'] = common_extra_parameters
  write_new(export_dir / '0.common.json', json.dumps(common_data, sort_keys=True, indent=2, separators=(',', ': ')), replace=ours)


  # we save a mapping label => full into
  label_mappings = {
    'extra_parameters': dict(),
    'configurations': dict(),
    'databases': dict(),
  }

  glob = request.args.get('path', '*')
  nb_files_exported = 0
  errors = []
  for output in new_outputs:
    output_ref = output_refs[output.id]
    if not output_ref:
      output_ref = output


    def get_labels(output, label_mappings):
      labels = []
      if output.batch.ci_commit.hexsha != common_data.get("commit"):
        labels.append(output.batch.ci_commit.hexsha[:4])
      if output.platform != common_data.get("platform"):
        labels.append(output.platform)
      if not common_data.get("configurations"):
        def strip_config(c):
          c_prefix = serialize_config(common_data.get("configurations_prefix", 'placeholder-placeholder'))
          c_suffix = serialize_config(common_data.get("configurations_suffix", 'placeholder-placeholder'))
          return c.replace(c_prefix, '').replace(c_suffix, '').replace("crop", "").replace('workspace-configurations-', '')
        c_formatted = strip_config(output.configuration)
        stripped_config = slugify_hash(c_formatted)
        # list of common SIRC-specific names
        if stripped_config:
          labels.append(stripped_config)
        label_mappings['configurations'][stripped_config] = output.configurations
      if not common_data.get("database"):
        slugify_database = slugify_hash(output.test_input.database)
        if slugify_database:
          labels.append(slugify_database)
        label_mappings['databases'][slugify_database] = output.test_input.database
      if str(output.extra_parameters) != str(common_data.get("extra_parameters")):
        tame = lambda o: set(((k.replace(all_extra_parameters_prefix, ''), str(v)) for k, v in o.items()))
        p = tame(output.extra_parameters) - tame(common_extra_parameters)
        extra_parameters_label = slugify_hash(str(p))
        label_mappings['extra_parameters'][extra_parameters_label] = output.extra_parameters
        if p: labels.append(extra_parameters_label)
      stitch = lambda l: f"@{'@'.join(l)}" if l else ''
      label = stitch(labels)
      # TODO: do we want to raise exception if label is empty?
      # if not label:
      #   raise Exception("no label")
      return label


    label_new = get_labels(output, label_mappings)
    label_ref = get_labels(output_ref, label_mappings)

    export_type = request.args.get('export_type', "link")
    for output_path in output.output_dir.glob(glob):
      try:
        output_path_rel = output_path.relative_to(output.output_dir)
        copied_to_rel = copy_path_rel(output, output_path, label=label_new)
        export_to(export_dir / copied_to_rel, output_path, type=export_type, user=g.actor.user, replace=ours)
        if output_ref and output_ref.id != output.id:
          output_path_ref = output_ref.output_dir / output_path_rel
          if output_path_ref.exists():
            copied_to_rel = copy_path_rel(output_ref, output_path_ref, label=label_ref)
            export_to(export_dir / copied_to_rel, output_path_ref, type=export_type, user=g.actor.user, replace=ours)
            nb_files_exported += 1
        nb_files_exported += 1
      except Exception as e:
        error = f"WARNING: Error when trying to export {output_path.name}: {e}"
        print(error)
        errors.append(error)

  if label_mappings['configurations'] or label_mappings['extra_parameters']:
    write_new(export_dir / '0.mappings.json', json.dumps(label_mappings, indent=4, sort_keys=True))

  params = {
    "batch": new_batch.label,
    "reference": ref_commit.hexsha if ref_commit else None,
    "batch_ref": ref_batch.label if ref_batch else None,
    "filter": filter_new if filter_new else None,
    "filter_ref": filter_ref if filter_ref else None,
  }
  params = {k: quote(v) for k, v in params.items() if v}
  url = f"{qaboard_url}/{project_id}/commit/{new_commit.hexsha}?{'&'.join(f'{k}={v}' for k, v in params.items())}"
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
  write_new(export_dir / '0.qa.html', redirect)
  write_new(export_dir / '0.qa.url', f"[InternetShortcut]\nURL={url}\n")
  # users see their exports, and their size, in "Storage usage" (backend/exports.py), and can delete them:
  # not folders that were there before
  export_id = None
  try:
    from ..exports import record
    export = record(export_dir, project_id=project_id, hexsha=new_commit.hexsha, batch_label=new_batch.label, user_name=g.user.get('user_name'),
                    export_type=request.args.get('export_type', 'link'), filter=filter_new, nb_files=nb_files_exported) if ours else None
    db_session.commit()
    export_id = export.id if export else None
  except Exception as e:
    db_session.rollback()
    print(f"WARNING: could not track the export {export_dir}: {e}")
  return jsonify({
    "export_id": export_id,
  	"export_dir": str(export_dir),
    "nb_outputs": len(new_outputs),
    "nb_outputs_ref": len(ref_outputs),
    "nb_files_exported": nb_files_exported,
    "errors": errors,
  })





def write_new(path, text, replace=False):
  """Writes one of the export's own files, if it's not there. `replace`: in our exports' folders"""
  if os.path.lexists(path):
    if not replace:
      return
    # e.g. a link someone put there: we remove the link, we don't write where it points
    path.unlink()
  with path.open('x') as f:
    f.write(text)


def export_to(path_from, path_to, type, user=None, replace=False):
  """Links or copies `path_to` at `path_from`. What's there is only replaced if it's a file, and `replace`"""
  if path_to.is_dir():
    return export_folder_to(path_from, path_to, type, user=user, replace=replace)
  if os.path.lexists(path_from):
    if os.path.exists(path_from) and os.path.samefile(path_from, path_to):
      return # already exported
    if not replace or (path_from.is_dir() and not path_from.is_symlink()):
      raise FileExistsError(f"{path_from} already exists, QA-Board doesn't replace it")
    path_from.unlink()
  if type == "link":
    try:
      os.link(str(path_to), str(path_from))
    except:
      os.symlink(str(path_to), str(path_from))
  elif type == "copy":
    if user is None:
      raise Exception("Need Login")
    as_user(user.user_name, shutil.copyfile, str(path_to), str(path_from))
  else:
    raise ValueError("Invalid type. Use 'link' or 'copy'.")


def export_folder_to(path_from, path_to, type, user=None, replace=False):
  """
  A folder: a real folder, with links (or copies) of its files, in the same subfolders. Earlier exports made a
  symbolic link to the run's folder: it's replaced by a folder, if `replace`.
  """
  if os.path.islink(path_from):
    if not replace:
      raise FileExistsError(f"{path_from} already exists, QA-Board doesn't replace it")
    path_from.unlink()
  elif os.path.lexists(path_from) and not path_from.is_dir():
    raise FileExistsError(f"{path_from} already exists, QA-Board doesn't replace it")
  errors = []
  # links to folders aren't followed: they may be anywhere
  for root, dirs, names in os.walk(path_to):
    dirs.sort()
    folder = path_from / Path(root).relative_to(path_to)
    if type == 'copy':
      if user is None:
        raise Exception("Need Login")
      as_user(user.user_name, mkdir_shared, folder)
    else:
      mkdir_shared(folder)
    for name in sorted(names):
      try:
        export_to(folder / name, Path(root) / name, type, user=user, replace=replace)
      except Exception as e:
        errors.append(f"{Path(root) / name}: {e}")
  if errors:
    raise Exception(f"{len(errors)} files of the folder failed, e.g. {errors[0]}")


def copy_path_rel(output, output_path, label):
  try:
    output_path_rel = output_path.relative_to(output.batch.output_dir)
    # we remove the platform, configuration, and tuning hashes
    levels_to_ignore = 2 if output.batch.label == 'default' else 4
    copied_rel = Path(*output_path_rel.parts[levels_to_ignore:])
  except:
    output_path_rel = output.test_input.path / output_path.relative_to(output.output_dir)
    copied_rel = output_path_rel
  copied_rel = copied_rel.parent / f"{output_path_rel.stem}{label}{output_path_rel.suffix}" 
  copied_rel = str(copied_rel).replace('/', '_') # or \ ? or just name .... ??
  return copied_rel
