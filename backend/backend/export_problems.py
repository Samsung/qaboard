"""
What went wrong while exporting files (backend/api/export_files.py), said once per kind of problem, not once per file.

Exports fail file after file for the same reason, e.g. the user's account can't write in the folder: thousands of
identical errors tell users nothing. Problems are grouped by what QA-Board was doing (making a folder, copying, linking,
cropping), who did it (the user, for copies, or the server), the error (e.g. EACCES) and which file it was about
(the run's file or the exported file). Each group says what it means and what to do, with a few examples.

Users get no tracebacks. Admins do: each failed export gets a reference, that users see, and that's in the server's
logs, with each group's first traceback (also from the child processes that act as users, see fs_utils.as_user),
and in Sentry, if it's set up: one event per export, tagged `export.reference`, grouped by kind of problem.
"""
import errno
import uuid
import traceback
from dataclasses import dataclass, field
from typing import Optional


EXAMPLES = 3

STEPS = {
  'folder': "creating folders",
  'copy': "copying files",
  'link': "linking files",
  'crop': "cropping images",
  'replace': "replacing files",
}


@dataclass
class Problem:
  step: str
  actor: str  # a user name, or "server"
  code: str  # e.g. EACCES, or the exception's type
  about: Optional[str]  # "source": the run's file, "destination": the exported file or its folder
  count: int = 0
  examples: list = field(default_factory=list)
  error: Optional[BaseException] = None

  @property
  def by_user(self):
    return self.actor != 'server'


def error_code(error: BaseException) -> str:
  if isinstance(error, OSError) and error.errno in errno.errorcode:
    return errno.errorcode[error.errno]
  return type(error).__name__


def what_about(error: BaseException, source) -> Optional[str]:
  """Whether the OS complained about the run's file or the exported one"""
  path = getattr(error, 'filename', None)
  if path is None:
    return None
  return 'source' if str(path) == str(source) else 'destination'


def explain(problem: Problem, folder) -> dict:
  """{message, hint} for users: what happened, and what they can do"""
  who = f"your account ({problem.actor})" if problem.by_user else "the QA-Board server"
  Who = who[0].upper() + who[1:]
  step = STEPS.get(problem.step, problem.step)
  code = problem.code
  if code in ('EACCES', 'EPERM', 'EROFS'):
    if problem.about == 'source':
      message = f"{Who} can't read these runs' files."
      hint = ("Copies are made as you, so you need to read the runs' files: export links instead, or ask whoever owns the runs for access."
              if problem.by_user else "Ask your QA-Board admins: the server needs to read the runs' files.")
    elif code == 'EROFS':
      message, hint = f"The folder is read-only: {who} can't write there.", "Export into another folder, e.g. a new folder."
    else:
      message = f"{Who} can't write in the export's folder ({step})."
      hint = (f"Check that you can write in {folder}, or export into a new folder."
              if problem.by_user else f"Export into a new folder, or ask your QA-Board admins to let the server write in {folder}.")
  elif code == 'EDQUOT':
    message = f"The disk quota of {who} is full."
    hint = "Copies count in your quota: export links instead, or free some space." if problem.by_user else "Ask your QA-Board admins."
  elif code == 'ENOSPC':
    message, hint = "The storage is full.", "Free some space, or export into another folder. Links take no space."
  elif code == 'ENOENT' and problem.about == 'source':
    message, hint = "Some runs' files are gone, e.g. deleted while exporting.", "Refresh the page and export again."
  elif code == 'ENAMETOOLONG':
    message, hint = "Some names are too long for the storage.", "Shorten the names, e.g. with fewer fields in the template."
  elif code == 'EXDEV':
    message, hint = "Links only work on the same storage as the runs.", "Export copies, or into a new folder."
  elif problem.step == 'crop' and code == 'ValueError':
    message, hint = "Some regions can't be cropped.", "Their crops are skipped, e.g. regions outside the image."
  elif code in ('UnknownAccountError', 'UnsafePathError'):
    message, hint = f"QA-Board refused {step}.", "Ask your QA-Board admins, with the reference below."
  else:
    message, hint = f"Something went wrong while {step}.", "Ask your QA-Board admins, with the reference below."
  return {"message": message, "hint": hint}


class Problems:
  """The files that failed in an export, grouped"""
  def __init__(self):
    self.groups = {}
    self.reference = None
    # files not tried: the first ones all failed
    self.not_attempted = 0

  def add(self, error: BaseException, *, step: str, actor: str, source, f: dict, side: str = None):
    problem_key = (step, actor, error_code(error), what_about(error, source))
    problem = self.groups.get(problem_key)
    if problem is None:
      problem = self.groups[problem_key] = Problem(step=step, actor=actor, code=problem_key[2], about=problem_key[3], error=error)
    problem.count += 1
    if len(problem.examples) < EXAMPLES:
      problem.examples.append({"file": f['file'], "to": f['to'], "side": side, "error": user_error(error)})

  @property
  def count(self):
    return sum(p.count for p in self.groups.values())

  def sorted(self):
    return sorted(self.groups.values(), key=lambda p: -p.count)

  def describe(self, folder) -> list:
    """For the web app and scripts: no tracebacks"""
    return [{"step": p.step, "actor": p.actor, "code": p.code, "about": p.about, "count": p.count, "examples": p.examples, **explain(p, folder)}
            for p in self.sorted()]

  def as_errors(self, folder) -> list:
    """One line per problem, for `errors`"""
    lines = []
    for p in self.sorted():
      text = explain(p, folder)['message']
      count = f" ({p.count} files)" if p.count > 1 else ""
      lines.append(f"{text}{count} E.g. {p.examples[0]['to']}: {p.examples[0]['error']}")
    return lines

  def report(self, context: dict) -> Optional[str]:
    """Logs each problem's first traceback, and sends one Sentry event. Returns the reference users can give admins"""
    if not self.groups:
      return None
    self.reference = uuid.uuid4().hex[:12]
    lines = [f"ERROR: export {self.reference}: {self.count} files failed, {context}"]
    for p in self.sorted():
      lines.append(f"-- {p.count} files: {STEPS.get(p.step, p.step)} as {p.actor}, {p.code} ({p.about or 'n/a'}). E.g. {p.examples[0]}")
      lines.append(''.join(traceback.format_exception(p.error)).rstrip())
    print('\n'.join(lines), flush=True)
    report_to_sentry(self, context)
    return self.reference


def user_error(error: BaseException) -> str:
  """What the OS said, without the traceback, e.g. "Permission denied: '/path'" """
  if isinstance(error, OSError) and error.strerror:
    paths = [p for p in (error.filename, getattr(error, 'filename2', None)) if p is not None]
    return f"{error.strerror}: {', '.join(repr(str(p)) for p in paths)}" if paths else error.strerror
  return str(error) or type(error).__name__


def report_to_sentry(problems: Problems, context: dict):
  try:
    import sentry_sdk
  except ImportError:
    return
  if not sentry_sdk.is_initialized():
    return
  # regions outside images are the users' data, not a problem for admins
  groups = [p for p in problems.sorted() if not (p.step == 'crop' and p.code == 'ValueError')]
  if not groups:
    return
  main = groups[0]
  try:
    with sentry_sdk.new_scope() as scope:
      scope.set_tag('export.reference', problems.reference)
      scope.set_tag('export.step', main.step)
      scope.set_tag('export.by', 'user' if main.by_user else 'server')
      scope.set_tag('export.error', main.code)
      scope.set_context('export', {
        **context,
        "reference": problems.reference,
        "nb_failed": problems.count,
        "problems": [{"step": p.step, "actor": p.actor, "code": p.code, "about": p.about, "count": p.count, "examples": p.examples} for p in groups],
      })
      # one issue per kind of problem: its events are the exports that had it
      scope.fingerprint = ['qaboard-export-failed', main.step, 'user' if main.by_user else 'server', main.code, main.about or '']
      sentry_sdk.capture_exception(main.error)
  except Exception:
    print(f"WARNING: could not report export {problems.reference} to Sentry: {traceback.format_exc()}", flush=True)
