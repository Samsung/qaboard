"""The reference branch of a project, from what the server knows about it."""


def reference_branch_of(project_data, config=None) -> str:
  """
  The project's reference branch: `project.reference_branch` in its qaboard.yaml (`config`, by default the project's),
  else its repository's default branch (from the git server's webhooks, or the first one runs sent, see
  models/CiCommit.py), else main. Like the client's (qaboard/config.py reference_branch).
  """
  data = project_data if isinstance(project_data, dict) else {}
  if config is None:
    config = data.get('qatools_config')
  project_config = config.get('project') if isinstance(config, dict) else None
  reference = project_config.get('reference_branch') if isinstance(project_config, dict) else None
  if reference:
    return str(reference)
  git = data.get('git') if isinstance(data.get('git'), dict) else {}
  default_branch = git.get('default_branch')
  if isinstance(default_branch, str) and default_branch:
    return default_branch
  return 'main'
