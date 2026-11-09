"""
Sending emails. Configured in Admin → Settings → Email, or with environment variables (they win),
see website/docs/start-server.mdx:
  email.smtp_host       QABOARD_SMTP_HOST       enables emails
  email.smtp_port       QABOARD_SMTP_PORT       default: 465 with ssl, 587 with starttls, else 25
  email.smtp_security   QABOARD_SMTP_SECURITY   none (default), starttls or ssl
  email.smtp_user / email.smtp_password         QABOARD_SMTP_USER / QABOARD_SMTP_PASSWORD, if the server needs a login
  email.smtp_timeout    QABOARD_SMTP_TIMEOUT    seconds, default 15
  email.from            QABOARD_EMAIL_FROM      default "QA-Board <qaboard@<email.domain>>"
  email.reply_to        QABOARD_EMAIL_REPLY_TO  e.g. the team supporting QA-Board
  email.domain          QABOARD_EMAIL_DOMAIN    users without an email address get emails at <user_name>@<domain>
"""
import re
import socket
import smtplib
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr
from dataclasses import dataclass
from typing import Optional


@dataclass
class EmailSettings:
  host: Optional[str]
  port: int
  security: str
  user: Optional[str]
  password: Optional[str]
  timeout: float
  sender: str
  reply_to: Optional[str]
  domain: Optional[str]

  @property
  def enabled(self) -> bool:
    return bool(self.host)


def email_settings(environ=None, overrides=None) -> EmailSettings:
  """
  From the settings (Admin → Settings → Email, the environment winning).
  environ: {variable: value} instead, e.g. in tests. overrides: {setting: value} over them, e.g. to test new values.
  """
  if environ is None:
    from ..settings import setting
    get = setting
  else:
    from ..settings import DEFINITIONS
    get = lambda key: environ.get(DEFINITIONS[key].env)
  if overrides:
    base, get = get, lambda key: overrides[key] if key in overrides else base(key)
  security = (get('email.smtp_security') or 'none').strip().lower()
  if security not in ('none', 'starttls', 'ssl'):
    print(f"WARNING: QABOARD_SMTP_SECURITY must be none, starttls or ssl, not {security!r}: using none")
    security = 'none'
  default_port = {'ssl': 465, 'starttls': 587}.get(security, 25)
  try:
    port = int(get('email.smtp_port') or default_port)
  except ValueError:
    port = default_port
  try:
    timeout = float(get('email.smtp_timeout') or 15)
  except ValueError:
    timeout = 15
  domain = (get('email.domain') or '').strip().lstrip('@') or None
  return EmailSettings(
    host=(get('email.smtp_host') or '').strip() or None,
    port=port,
    security=security,
    user=get('email.smtp_user') or None,
    password=get('email.smtp_password') or None,
    timeout=timeout,
    sender=get('email.from') or f"QA-Board <qaboard@{domain or socket.getfqdn()}>",
    reply_to=get('email.reply_to') or None,
    domain=domain,
  )


def email_enabled() -> bool:
  return email_settings().enabled


_email = re.compile(r'^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$')

def is_email(value) -> bool:
  return isinstance(value, str) and bool(_email.match(value.strip()))


def recipient_for(user_name, email=None, settings=None) -> Optional[str]:
  """Where we email a user: the email we were given, the one of their account, or <user_name>@$QABOARD_EMAIL_DOMAIN"""
  if is_email(email):
    return email.strip()
  if user_name:
    from backend.models import User
    user = User.query.filter(User.user_name == user_name).one_or_none()
    if user and is_email(user.email):
      return user.email.strip()
  settings = settings or email_settings()
  if user_name and settings.domain and re.fullmatch(r'[\w.+-]+', user_name):
    return f"{user_name}@{settings.domain}"
  return None


def build_message(to, subject, html, text, settings: EmailSettings, headers=None) -> EmailMessage:
  message = EmailMessage()
  message['Subject'] = subject
  message['From'] = settings.sender
  message['To'] = to
  if settings.reply_to:
    message['Reply-To'] = settings.reply_to
  message['Date'] = formatdate(localtime=True)
  sender_domain = parseaddr(settings.sender)[1].partition('@')[2] or None
  message['Message-ID'] = make_msgid(domain=sender_domain)
  # Automated: no out-of-office or other auto-replies (RFC 3834, and Exchange/Outlook)
  message['Auto-Submitted'] = 'auto-generated'
  message['X-Auto-Response-Suppress'] = 'All'
  # e.g. X-QABoard-Project, for users' mail rules
  for name, value in (headers or {}).items():
    if value:
      message[name] = str(value).replace('\n', ' ')
  message.set_content(text)
  message.add_alternative(html, subtype='html')
  return message


def send_email(to, subject, html, text, headers=None, settings=None):
  """Raises if the email could not be sent."""
  settings = settings or email_settings()
  if not settings.enabled:
    raise RuntimeError("Emails are not configured: set the SMTP server in Admin → Settings → Email (or QABOARD_SMTP_HOST)")
  message = build_message(to, subject, html, text, settings, headers)
  smtp_class = smtplib.SMTP_SSL if settings.security == 'ssl' else smtplib.SMTP
  with smtp_class(settings.host, settings.port, timeout=settings.timeout) as smtp:
    if settings.security == 'starttls':
      smtp.starttls()
    if settings.user:
      smtp.login(settings.user, settings.password or '')
    smtp.send_message(message)
