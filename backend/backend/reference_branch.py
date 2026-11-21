"""The reference branch of a project, from what the server knows about it."""


def reference_branch_of(project_data) -> str:
  """
  The project's reference branch: `project.reference_branch` in its qaboard.yaml, else, for projects whose runs sent
  no qaboard.yaml (qaboard.start_run(), qa upload), their repository's default branch, which those runs send. Else master.
  Projects with a qaboard.yaml keep master: they may rely on it, whatever their git server's default branch.
  """
  data = project_data if isinstance(project_data, dict) else {}
  config = data.get('qatools_config')
  project_config = config.get('project') if isinstance(config, dict) else None
  reference = project_config.get('reference_branch') if isinstance(project_config, dict) else None
  if reference:
    return str(reference)
  if not config:
    default_branch = (data.get('git') or {}).get('default_branch') if isinstance(data.get('git'), dict) else None
    if isinstance(default_branch, str) and default_branch:
      return default_branch
  return 'master'
