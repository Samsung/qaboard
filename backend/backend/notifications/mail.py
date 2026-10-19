"""
Sending emails. Configured with environment variables, see website/docs/start-server.mdx:
  QABOARD_SMTP_HOST          enables emails
  QABOARD_SMTP_PORT          default: 465 with ssl, 587 with starttls, else 25
  QABOARD_SMTP_SECURITY      none (default), starttls or ssl
  QABOARD_SMTP_USER / QABOARD_SMTP_PASSWORD   if the server needs a login
  QABOARD_SMTP_TIMEOUT       seconds, default 15
  QABOARD_EMAIL_FROM         default "QA-Board <qaboard@$QABOARD_EMAIL_DOMAIN>"
  QABOARD_EMAIL_REPLY_TO     e.g. the team supporting QA-Board
  QABOARD_EMAIL_DOMAIN       users without an email address get emails at <user_name>@<domain>
"""
import os
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


def email_settings(environ=os.environ) -> EmailSettings:
  security = (environ.get('QABOARD_SMTP_SECURITY') or 'none').strip().lower()
  if security not in ('none', 'starttls', 'ssl'):
    print(f"WARNING: QABOARD_SMTP_SECURITY must be none, starttls or ssl, not {security!r}: using none")
    security = 'none'
  default_port = {'ssl': 465, 'starttls': 587}.get(security, 25)
  try:
    port = int(environ.get('QABOARD_SMTP_PORT') or default_port)
  except ValueError:
    port = default_port
  try:
    timeout = float(environ.get('QABOARD_SMTP_TIMEOUT') or 15)
  except ValueError:
    timeout = 15
  domain = (environ.get('QABOARD_EMAIL_DOMAIN') or '').strip().lstrip('@') or None
  return EmailSettings(
    host=(environ.get('QABOARD_SMTP_HOST') or '').strip() or None,
    port=port,
    security=security,
    user=environ.get('QABOARD_SMTP_USER') or None,
    password=environ.get('QABOARD_SMTP_PASSWORD') or None,
    timeout=timeout,
    sender=environ.get('QABOARD_EMAIL_FROM') or f"QA-Board <qaboard@{domain or socket.getfqdn()}>",
    reply_to=environ.get('QABOARD_EMAIL_REPLY_TO') or None,
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
    raise RuntimeError("Emails are not configured: set QABOARD_SMTP_HOST")
  message = build_message(to, subject, html, text, settings, headers)
  smtp_class = smtplib.SMTP_SSL if settings.security == 'ssl' else smtplib.SMTP
  with smtp_class(settings.host, settings.port, timeout=settings.timeout) as smtp:
    if settings.security == 'starttls':
      smtp.starttls()
    if settings.user:
      smtp.login(settings.user, settings.password or '')
    smtp.send_message(message)
