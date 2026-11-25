"""
Getting in touch with QA-Board's maintainers, who would love to help sites make it work for their teams.

QA-Board sends nothing to its maintainers. Admin → Overview offers to write to them: the web app opens the admin's
email app with a message they edit, then send or not (website/docs/backend-admin/support.mdx). The message says how
the server is set up, in general terms (version, sign-in, runner, rough size), and nothing about projects, people or
hostnames. Whether the admin wrote, or said no thanks, is the setting `web.maintainers_contact`, so that the
overview stops asking, for every admin.
"""
import os
from typing import Optional


# Where the overview and the docs (website/docs/backend-admin/support.mdx) send admins
MAINTAINERS_EMAIL = 'arthur@fl.am'
SUBJECT = "Hello from a QA-Board server"


def bucket(count: int) -> str:
  """Rough sizes: the maintainers want an idea, not numbers"""
  if count <= 0:
    return "no"
  for limit in (10, 50, 200, 1000):
    if count <= limit:
      return f"up to {limit}"
  return "over 1000"


def plural(count: int, noun: str) -> str:
  return f"{bucket(count)} {noun}s"


def server_facts(version: Optional[str], kubernetes: bool, login_type: str, provider_types: list,
                 runner: Optional[str], users: int, projects: int) -> list:
  """What the message says about the server: one line each, that admins can delete"""
  sign_in = sorted({t.lower() for t in provider_types if t and t.lower() != 'local'} | {login_type.lower()})
  return [
    f"QA-Board {version or '(version unknown)'}, {'on Kubernetes' if kubernetes else 'with Docker Compose or another way'}",
    f"Sign-in: {', '.join(sign_in)}",
    f"Batches started from the web app: {runner or 'off'}",
    f"Size: {plural(users, 'user')}, {plural(projects, 'project')}",
  ]


def message_body(facts: list, signature: Optional[str]) -> str:
  return "\n".join([
    "Hi QA-Board maintainers,",
    "",
    "We use QA-Board at: [company, team]",
    "We use it for: [what you test: algorithms, ML models, software...]",
    "We'd love help with: [setting it up, integrating our projects, runners, viewers... or nothing for now]",
    "",
    "Please let me know about (delete what you don't want):",
    "- security fixes",
    "- new releases, about once a month",
    "",
    "About our server (delete what you'd rather not share):",
    *[f"- {fact}" for fact in facts],
    "",
    "Thanks,",
    signature or "",
  ]).rstrip() + "\n"


def contact(user=None) -> dict:
  """{email, subject, body, status}: what Admin → Overview's "Write to the maintainers" opens, and whether admins did"""
  from .settings import setting, login_type
  from .server_runner import server_runner
  from .sign_in.providers import all_providers
  from .models import Project, User
  try:
    provider_types = [p.type for p in all_providers() if p.enabled]
  except Exception:
    provider_types = []
  facts = server_facts(
    version=os.environ.get('QABOARD_VERSION'),
    kubernetes=bool(os.environ.get('KUBERNETES_SERVICE_HOST')),
    login_type=login_type(),
    provider_types=provider_types,
    runner=server_runner(),
    users=User.query.filter(User.kind == 'human', User.status == 'active').count(),
    projects=Project.query.count(),
  )
  signature = (getattr(user, 'full_name', None) or getattr(user, 'user_name', None)) if user else None
  return {
    "email": MAINTAINERS_EMAIL,
    "subject": SUBJECT,
    "body": message_body(facts, signature),
    "status": setting('web.maintainers_contact'),
  }


def log_offer():
  """For new servers' logs, next to how to create the first admin"""
  # printed like the setup token next to it (first_admin.log_setup_token): a message to the admin installing QA-Board
  print(f"[setup] Need a hand? QA-Board's maintainers would love to help you set it up: {MAINTAINERS_EMAIL} (or Admin → Overview).", flush=True)
