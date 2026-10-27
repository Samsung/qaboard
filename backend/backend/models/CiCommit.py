"""
A version of the code on which we ran SLAM performance test.
"""
import os
import re
import fnmatch
import datetime
import subprocess
from pathlib import Path

from sqlalchemy import Column, Boolean, Integer, String, DateTime, JSON, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy import or_, text, UniqueConstraint, Index, orm
from sqlalchemy.orm import relationship, selectinload
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.attributes import flag_modified

from qaboard.conventions import get_commit_dirs
from qaboard.api import dir_to_url

from backend.models import Base, Batch, Output, batches_stats, no_stats
from ..git_hosts import committer_avatar_url, committers
from ..fs_utils import rm_empty_parents, rmtree
from ..storage import check_storage_path, check_inside, UnsafePathError
from ..git_utils import find_branch
from ..artifacts import MAX_CHECKED_FILES, artifacts_status, protected_by_siblings, is_kept, read_manifest, rmtree_except, ArtifactsUnavailable
from .. import recreate_artifacts



def normalize_email(email):
  email = str(email or '').strip().lower()
  return email if '@' in email else None


class CiCommit(Base):
  """Refers to a git commit of the code
  on which we ran some SLAM performance test (likely in the CI).
  We keep some useful data in the database, but for the rest it used gitpython.
  """
  __tablename__ = 'ci_commits'
  id = Column(Integer(), primary_key=True)
  hexsha = Column(String(), index=True, nullable=False)
  # indexed by ix_ci_commits_project_id_authored_datetime below
  project_id = Column(String(), ForeignKey('projects.id'))

  project = relationship("Project", back_populates="ci_commits")

  data = Column(JSONB(), nullable=False, default=dict, server_default='{}')

  authored_datetime = Column(DateTime(timezone=True), index=True)
  committer_name = Column(String(), index=True)
  # who wrote it (the author's email, else the committer's, lowercase), to show users their commits (backend/mine.py)
  author_email = Column(String())
  message = Column(String())
  # We use as branch the first branch that the commit was seen on, or the project's reference branch if it was used.
  # TODO: we should also store the tags we witnessed the commit used with.
  branch = Column(String(), index=True) # first added as.. we ignore tags?

  __table_args__ = (
    UniqueConstraint('project_id', 'hexsha', name='_project_hexsha'),
    # Lists of commits, newest first: a project's, a branch's, and the project's branches by latest activity.
    # Created by the migration e7f3b2a91c40 on existing databases.
    Index('ix_ci_commits_project_id_authored_datetime', 'project_id', authored_datetime.desc()),
    Index('ix_ci_commits_project_id_branch_authored_datetime', 'project_id', 'branch', authored_datetime.desc()),
    # The commits with new runs, whose storage usage must be updated (backend/storage_usage.py)
    Index('ix_ci_commits_latest_output_datetime', 'latest_output_datetime'),
    # Users' commits, created by the migration e9b1c3d5f7a2
    Index('ix_ci_commits_author_email', 'author_email'),
    # commits from before we saved emails are matched by name
    Index('ix_ci_commits_lower_committer_name', text('lower(committer_name)')),
  )
  # In the end there having a commit's parents is not all that useful for QA-Board:
  # not all commits are used for runs: e.g. CI runs only on pushed commits, so
  # that info is not enough to reconstruct the commit graph.
  # Right now we don't display parents in the web application, so we also remove it from the API. 
  # Instead of  JSON, we could use an Array of String instead, so that we can search for descendents. But do we really need it? 
  parents = Column(JSON())

  commit_dir_override = Column(String())
  # Right now we don't really use this field, it's always "git".
  # The client uses "local" in case there is no git info, but
  # even then it doesn't send the information!
  commit_type = Column(String(), default='git')
  
  batches = relationship("Batch",
                         back_populates="ci_commit",
                         cascade="all, delete-orphan",
                         order_by=Batch.created_date,
                        )

  latest_output_datetime = Column(DateTime(timezone=True))
  deleted = Column(Boolean(), default=False)


  @orm.reconstructor
  def init_on_load(self):
    if not self.data:
      self.data = {}

  def get_or_create_batch(self, label):
    matching_batches = [b for b in self.batches if b.label == label]
    if matching_batches: return matching_batches[0]
    return Batch(ci_commit=self, label=label)

  @property
  def ci_batch(self):
    return self.get_or_create_batch('default')


  @property
  def authored_date(self):
    return self.authored_datetime.date()

  @property
  def artifacts_dir(self) -> Path:
    """Returns the folder in all the artifacts for this commit are stored."""
    if self.project.id_relative:
      return self.repo_artifacts_dir / self.project.id_relative
    else:
      return self.repo_artifacts_dir

  @property
  def repo_artifacts_dir(self) -> Path:
    if self.commit_dir_override:
      if self.project.id_relative:
        repo_artifacts_dir = re.sub(f'{self.project.id_relative}$', '', self.commit_dir_override)
        return Path(repo_artifacts_dir)
      else:
        return Path(self.commit_dir_override)
    config = self.data.get('qatools_config', {})
    config_storage = self.project.storage_roots(config)
    return config_storage['artifacts'] / get_commit_dirs(self) / config_storage["subproject"]

  @property
  def artifacts_url(self) -> str:
    return dir_to_url(self.artifacts_dir)

  @property
  def repo_artifacts_url(self) -> str:
    return dir_to_url(self.repo_artifacts_dir)


  @property
  def repo_outputs_dir(self):
    config = self.data.get('qatools_config', {})
    return self.project.storage_roots(config)['outputs'] / get_commit_dirs(self)

  @property
  def outputs_url(self) -> str:
    return dir_to_url(self.outputs_dir)

  @property
  def outputs_dir(self):
    # output dirs are now always saved, so we only call this to get output locations with usual conventions
    # e.g. when starting new tuning runs
    if self.project.id_relative:
      return self.repo_outputs_dir / self.project.id_relative
    else:
      return self.repo_outputs_dir


  def __repr__(self):
    branch = re.sub('origin/', '', self.branch) if self.branch else 'None'
    return f"<CiCommit project='{self.project.id}' hexsha='{self.hexsha[:8]}' branch='{branch}' batches={len(self.batches)}>"



  def __init__(self, hexsha, *, project, branch=None, message=None, parents=None, authored_datetime=None, committer_name=None, commit_type='git'):
    self.hexsha = hexsha
    self.project = project
    self.branch = branch
    self.message = message if message else '<NA>'
    self.parents = parents
    self.authored_datetime = authored_datetime
    self.committer_name = committer_name if committer_name else 'unknown'
    self.commit_type = commit_type
    self.latest_output_datetime = authored_datetime
    self.data = {}


  def save_artifacts(self):
    """
    Restores the artifacts that are defined in the source code: `git checkout && qa save-artifacts`.
    It won't restore build outputs (binaries...), for those see recreate_artifacts / restore_artifacts().
    """
    import tempfile
    from ..git_utils import git_pull
    # workaround for SIRC, trying to save artifacts will crash because the storage assumes a product name
    if self.project.id_relative.endswith("tests/products"):
      return
    # hexsha comes from unauthenticated API calls, make sure git won't parse it as an option
    if not re.match(r'^[0-9a-fA-F]{4,64}$', self.hexsha):
      raise ValueError(f"Invalid commit id: {self.hexsha!r}")
    check_storage_path(self.repo_artifacts_dir)
    if not self.project.repo:
      raise ValueError(f"The server can't read the git repository of {self.project.id}, so it can't restore the artifacts from the source code.")

    with tempfile.TemporaryDirectory() as tmp_dir:
      tmp_dir_path = Path(tmp_dir) / 'worktree'
      # if it fails in dev, chmod -R 777 /var/qaboard/git/CDE-Users/HW_ALG/.git
      git_pull(self.project.repo)
      self.project.repo.git.worktree("add", "--detach", tmp_dir_path, self.hexsha)
      try:
        command = ['qa', 'save-artifacts', '--out', str(self.repo_artifacts_dir)]
        print(command, tmp_dir_path / self.project.id_relative)
        subprocess.run(command, cwd=tmp_dir_path / self.project.id_relative, check=True)
      finally:
        try:
          self.project.repo.git.worktree("remove", "--force", tmp_dir_path)
        except Exception as e: # the artifacts were saved, git will prune the worktree later
          print(f"WARNING: could not remove the git worktree {tmp_dir_path}: {e}")


  def artifacts_status(self, max_checked_files=MAX_CHECKED_FILES):
    """Can we run from this commit's artifacts? See artifacts.artifacts_status."""
    status = artifacts_status(self.artifacts_dir, self.repo_artifacts_dir, is_subproject=bool(self.project.id_relative), max_checked_files=max_checked_files)
    if self.deleted:
      # When only some artifacts were kept (storage.garbage.artifacts.keep), the files that are left look fine
      status["ok"] = False
      status["problems"].insert(0, "The artifacts were deleted.")
    return status

  @property
  def recreate_artifacts_settings(self):
    # The project's settings come from the latest commit on the reference branch: they are likely more up-to-date
    return recreate_artifacts.recreate_settings(
      self.project.data.get('qatools_config'),
      self.data.get('qatools_config'),
    )

  def restore_artifacts(self, user=None, force=False):
    """
    Brings the artifacts back (`user` is who asked, as in g.user): asks the CI to recreate them if `recreate_artifacts` is configured,
    otherwise restores the files from the source code.
    Returns {status: restored|recreating|failed, message, ...}
    """
    settings = self.recreate_artifacts_settings
    if settings:
      recreation = self.data.get('artifacts_recreation')
      if not force and recreate_artifacts.in_progress(recreation):
        return {"status": "recreating", "message": f"The artifacts are being recreated by {recreation.get('via')}, since {recreation['at']}.", "recreation": recreation}
      recreation = recreate_artifacts.trigger(settings, self, user=user)
      self.data = {**self.data, 'artifacts_recreation': recreation}
      flag_modified(self, "data")
      if recreation['status'] == 'failed':
        return {"status": "failed", "message": f"Could not recreate the artifacts with {recreation['via']}: {recreation.get('error')}", "recreation": recreation}
      return {"status": "recreating", "message": f"Asked {recreation['via']} to recreate the artifacts. Try again once it is done.", "recreation": recreation}
    try:
      self.save_artifacts()
    except Exception as e:
      return {"status": "failed", "message": f"Could not restore the artifacts from the source code: {e}"}
    self.deleted = False
    status = self.artifacts_status()
    if not status["ok"]:
      self.deleted = True
      return {"status": "failed", "message": "Restored the artifacts from the source code, but some are still missing: " + " ".join(status["problems"]), "artifacts": status}
    return {
      "status": "restored",
      "message": "Restored the artifacts from the source code. Build outputs (e.g. binaries) can't be restored this way: to rebuild them automatically, configure `recreate_artifacts` in qaboard.yaml.",
    }

  def ensure_artifacts(self, user=None):
    """
    Call before running from the artifacts (redo, tuning).
    If they are missing, we try to bring them back. Raises ArtifactsUnavailable if we can't run now.
    We never run with missing artifacts: e.g. without its qaboard.yaml, a subproject's runs would be saved in the parent project.
    """
    status = self.artifacts_status()
    if status["ok"]:
      # e.g. some files in the manifests are missing: users may not need them, we tell them
      return {"status": "incomplete", "message": " ".join(status["warnings"])} if status.get("warnings") else None
    # QA-Board may not have been told that the artifacts were deleted
    self.deleted = True
    restored = self.restore_artifacts(user=user)
    if restored["status"] == "restored":
      warnings = self.artifacts_status().get("warnings", [])
      return {**restored, "message": " ".join([restored["message"], *warnings])}
    raise ArtifactsUnavailable(
      f"This commit's artifacts are not usable: {' '.join(status['problems'])} {restored['message']}",
      {**status, **restored},
    )


  def sibling_commits(self, session):
    """The same commit in the other (sub)projects of the repository, whose artifacts were not deleted"""
    id_git = self.project.id_git
    siblings = (session.query(CiCommit)
                .filter(CiCommit.hexsha == self.hexsha)
                .filter(CiCommit.deleted == False)
                .filter(or_(CiCommit.project_id == id_git, CiCommit.project_id.startswith(f"{id_git}/"))))
    return [c for c in siblings if c is not self and c.project_id != self.project_id]

  def delete(self, ignore=None, keep=None, dryrun=False, session=None, by=None):
    """
    Delete the commit's artifacts, and mark it as deleted.
    Files that other (sub)projects of the same commit still use are kept (it needs `session` to find them).
    NOTE: We don't touch batches/outputs, you have to deal with them yourself.
          See hard_delete() in api/webhooks.py and clean.py
    Returns {nb_deleted, errors, kept}
    """
    summary = {"nb_deleted": 0, "errors": [], "kept": 0}
    try:
      check_storage_path(self.repo_artifacts_dir)
      check_storage_path(self.artifacts_dir)
    except UnsafePathError as e:
      print(f"WARNING: not deleting the artifacts: {e}")
      summary["errors"].append(str(e))
      return summary
    siblings = self.sibling_commits(session) if session is not None else []
    is_protected = protected_by_siblings(self.repo_artifacts_dir, [(c.repo_artifacts_dir, c.artifacts_dir) for c in siblings], own_dir=self.artifacts_dir)
    if siblings:
      print(f"  keeping the files used by: {', '.join(c.project_id for c in siblings)}")

    manifest_dir = self.artifacts_dir / 'manifests'
    manifests = sorted(manifest_dir.iterdir()) if manifest_dir.is_dir() else []
    for manifest in manifests:
      group = manifest.stem
      if keep and group in keep:
        continue
      print(f'  ...deleting artifacts: {manifest.name}')
      has_error = False
      try:
        files = read_manifest(manifest)
      except Exception as e:
        summary["errors"].append(f"{manifest}: {e}")
        continue
      for file in files.keys():
        if keep and is_kept(group, file, keep):
          summary["kept"] += 1
          continue
        if ignore and any(fnmatch.fnmatch(file, i) for i in ignore):
          continue
        if is_protected(file):
          summary["kept"] += 1
          continue
        file_to_delete = self.repo_artifacts_dir / file
        try:
          # manifests are written by users
          check_inside(file_to_delete, self.repo_artifacts_dir)
          if os.path.lexists(file_to_delete):
            print(str(file_to_delete))
            if not dryrun:
              rmtree(file_to_delete)
              rm_empty_parents(file_to_delete)
            summary["nb_deleted"] += 1
        except Exception as e:
          has_error = True
          summary["errors"].append(f"Could not remove {file_to_delete}: {e}")
      if not has_error and not dryrun:
        try: # FIXME: umask 0 when writing the manifest file!
          rmtree(manifest)
          rm_empty_parents(manifest)
        except Exception as e:
          summary["errors"].append(f"Could not remove {manifest}: {e}")
    if not manifests and self.artifacts_dir.exists():
      print(f"[{self.authored_datetime}] No artifact manifests found. Deleting everything in {self.artifacts_dir}")
      try:
        if is_protected:
          summary["nb_deleted"] += rmtree_except(self.artifacts_dir, self.repo_artifacts_dir, is_protected, rmtree, dryrun=dryrun)
        else:
          summary["nb_deleted"] += 1 if dryrun else rmtree(self.artifacts_dir)
          if not dryrun:
            rm_empty_parents(self.artifacts_dir)
      except Exception as e:
        summary["errors"].append(str(e))

    if summary["errors"]:
      print("\n".join(f"  WARNING: {e}" for e in summary["errors"]))
    if not dryrun:
      # Even after a partial deletion, we can't run from the artifacts anymore
      self.deleted = True
      self.data = {**(self.data or {}), 'artifacts_deleted': {
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "by": by,
        "nb_deleted": summary["nb_deleted"],
        "errors": summary["errors"][:10],
        "kept_for": [c.project_id for c in siblings],
      }}
      flag_modified(self, "data")
    return summary

  @staticmethod
  def get_or_create(session, hexsha, project_id, data=None):
    try:
      ci_commit =(session.query(CiCommit)
                         .filter(
                           CiCommit.project_id==project_id,
                           CiCommit.hexsha.startswith(hexsha),
                         )
                         .one())
    except NoResultFound:
     # FIXME: if we have a short-hash, we should fail
      try:
        from backend.models import Project
        project = Project.get_or_create(session=session, id=project_id)
        if data and data.get('qaboard_config'):
          project_config = data["qaboard_config"].get('project') or {}
          # The project's configuration comes from its reference branch, or from the first commit we see
          is_initialization = not project.data or 'qatools_config' not in project.data
          reference_branch = project_config.get('reference_branch', 'master')
          is_reference = data.get("commit_branch") == reference_branch
          if is_initialization or is_reference:
            # FIXME: We put in Project.data.git the content of
            #       https://docs.gitlab.com/ee/user/project/integrations/webhooks.html#push-events
            # FIXME: We should really have Project.data.gitlab/github/...
            if "git" not in project.data:
              project.data["git"] = {}
            if "path_with_namespace" not in project.data["git"] and "name" in project_config: # FIXME: it really should be Project.root
              project.data["git"]["path_with_namespace"] = data.get('project_root') or project_config["name"]
            project.data.update({'qatools_config': data['qaboard_config']})
            if "qaboard_metrics" in data:
              project.data.update({'qatools_metrics': data["qaboard_metrics"]})
            flag_modified(project, "data")
        # Clients like the CLI tell us about the commit, then we don't need its git repository.
        # Only the date is required, they can leave out what they don't know (e.g. the branch).
        if data and data.get("commit_authored_datetime"):
          git_parents = data.get("commit_parents")
          git_message = data.get("commit_message")
          git_committer_name = data.get("commit_committer_name")
          git_author_email = data.get("commit_author_email") or data.get("commit_committer_email")
          git_authored_datetime = data["commit_authored_datetime"]
          git_branch = data.get("commit_branch")
        else:
          # If the project is connected to a git repo, we try to use it
          git_commit = project.repo.commit(hexsha)
          git_parents = [c.hexsha for c in git_commit.parents]
          git_message = git_commit.message
          git_committer_name = git_commit.committer.name
          git_author_email = getattr(getattr(git_commit, "author", None), "email", None) or getattr(git_commit.committer, "email", None)
          git_authored_datetime = git_commit.authored_datetime
          # commits belong to many branches, so this is a guess
          git_branch = find_branch(hexsha, project.repo)
        if data and data.get("commit_committer_email"):
          # For avatars. The CLI is not authenticated: it can't overwrite what webhooks told us.
          committers.remember([{"name": git_committer_name, "email": data["commit_committer_email"]}], overwrite=False)
        ci_commit = CiCommit(
          hexsha,
          project=project,
          commit_type='git', # we don't use anything else
          parents=git_parents,
          message=git_message,
          committer_name=git_committer_name,
          authored_datetime=git_authored_datetime,
          branch=git_branch,
        )
        ci_commit.author_email = normalize_email(git_author_email)
        if data and data.get('project_root'):
          if not ci_commit.data:
            ci_commit.data = {}
          if not ci_commit.data.get('git'):
            ci_commit.data['git'] = {}
          ci_commit.data['git'].update({"path_with_namespace": data['project_root']})
          flag_modified(ci_commit, "data")

        if data:
          if 'qaboard_config' in data:
            ci_commit.data.update({'qatools_config': data['qaboard_config']})
          if "qaboard_metrics" in data:
            ci_commit.data.update({'qatools_metrics': data['qaboard_metrics']})
          flag_modified(ci_commit, "data")
        try:
          session.add(ci_commit)
          session.commit()
        except IntegrityError:
          # https://stackoverflow.com/questions/2546207/does-sqlalchemy-have-an-equivalent-of-djangos-get-or-create
          session.rollback()
          ci_commit =(
            session.query(CiCommit)
            .filter(
              CiCommit.project_id==project_id,
              CiCommit.hexsha.startswith(hexsha),
            )
            .one()
          )
      except ValueError:
        error = f'[ERROR] ValueError: could not create a commit for {hexsha}'
        print(error)
        raise ValueError(error)
    if not ci_commit.data:
      ci_commit.data = {}
    # The commit may have been created without its configuration (e.g. opened in the web app before `qa` ran on it).
    # Without it, QA-Board can't find its batch files.
    if data and data.get('qaboard_config') and not ci_commit.data.get('qatools_config'):
      ci_commit.data['qatools_config'] = data['qaboard_config']
      flag_modified(ci_commit, "data")
    # Same for its metrics file: else the metrics declared in code that its runs send would hide the project's
    if data and "qaboard_metrics" in data and ci_commit.data.get('qatools_metrics') is None:
      ci_commit.data['qatools_metrics'] = data['qaboard_metrics']
      flag_modified(ci_commit, "data")
    # Commits from before we saved emails get theirs when `qa` sends results again
    sent_email = data and (data.get("commit_author_email") or data.get("commit_committer_email"))
    if sent_email and not getattr(ci_commit, 'author_email', None) and \
       (data.get("commit_committer_name") or '').strip().lower() == (ci_commit.committer_name or '').strip().lower():
      ci_commit.author_email = normalize_email(sent_email)
    return ci_commit

  def _get_avatar_url(self):
    """The committer's avatar, from what we know about the git host and the committers. No network calls."""
    project_data = self.project.data or {}
    project_url = (project_data.get('qatools_config') or {}).get('project', {}).get('url')
    return committer_avatar_url(self.committer_name, project_data.get('git'), project_url)

  def to_dict(self, db_session, with_aggregation=None, with_batches=None, with_outputs=False, batch_stats=None, cache=None):
    """
    `batch_stats`: the batches' counts of outputs and aggregated metrics, from batches_stats(). Queried if not given.
    `cache`: a dict to share when serializing many commits of a project, for what doesn't change between them.
    """
    batches = [b for b in self.batches if not with_batches or b.label in with_batches]
    if batch_stats is None:
      batch_stats = batches_stats(db_session, [b.id for b in batches], with_aggregation)
    if cache is None:
      cache = {}
    # e.g. GitHub avatars need an API call
    avatar_key = ('committer_avatar_url', self.project_id, self.committer_name)
    if avatar_key not in cache:
      cache[avatar_key] = self._get_avatar_url()
    repo_artifacts_url = self.repo_artifacts_url
    artifacts_url = self.artifacts_url
    out = {
        'id': self.hexsha,
        # 'type': self.commit_type,
        # Clients may not know the branch. The web app expects a string, it treats '' as no branch
        'branch': re.sub('origin/', '', self.branch) if self.branch else '',
        # Not used anywhere in the web application, and it's not all that useful (see earlier comment)
        # 'parents': [p for p in self.parents] if self.parents else [],
        'message': self.message,
        'committer_name': self.committer_name,
        'committer_avatar_url': cache[avatar_key],
        'authored_datetime': self.authored_datetime.isoformat(),
        'authored_date': self.authored_date.isoformat(),
        'latest_output_datetime': self.latest_output_datetime.isoformat() if self.latest_output_datetime else None,
        'deleted': self.deleted,
        "data": self.data,
        'outputs_url': dir_to_url(self.outputs_dir),
        'artifacts_url': artifacts_url,
        'repo_artifacts_url': repo_artifacts_url,
        'commit_dir_url': artifacts_url,           # backward compat for a while if projects using QA-Board rely on the API...
        'repo_commit_dir_url': repo_artifacts_url, # idem
        'batches': {
          b.label: b.to_dict(db_session, with_outputs=with_outputs, with_aggregation=with_aggregation, stats=batch_stats.get(b.id, no_stats))
          for b in batches
        },
    }
    if with_outputs:
      out["data"] = self.data
    return out




def latest_successful_commit(session, project_id, branch, batch_label=None, within_last=20):
  """
  Returns the latest commit on a given branch where we got valid outputs (in the batch `batch_label` if given),
  with its batches and outputs loaded. Only the latest within_last commits are checked...
  """
  latest_commits = (session
                    .query(CiCommit.id)
                    .filter(CiCommit.project_id==project_id)
                   )
  # without a branch we fallback to "any" commit with results
  if branch:
    # we try to be accomodating with the usual remote branch name
    latest_commits = latest_commits.filter(or_(CiCommit.branch==branch, CiCommit.branch==f'origin/{branch}'))
  latest_commits = latest_commits.order_by(CiCommit.authored_datetime.desc()).limit(within_last)
  valid_outputs = (session
                   .query(Output.id)
                   .join(Batch, Output.batch_id==Batch.id)
                   .filter(
                     Batch.ci_commit_id==CiCommit.id,
                     Output.is_failed.isnot(True),
                     Output.is_pending.isnot(True),
                   )
                  )
  if batch_label:
    valid_outputs = valid_outputs.filter(Batch.label==batch_label)
  return (session
          .query(CiCommit)
          .options(selectinload(CiCommit.batches).selectinload(Batch.outputs))
          .filter(
            CiCommit.id.in_(latest_commits.subquery().select()),
            valid_outputs.exists(),
          )
          .order_by(CiCommit.authored_datetime.desc())
          .first()
         )

