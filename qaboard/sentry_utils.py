"""
Sentry settings shared by QA-Board's processes: the `qa` CLI (in CI), the backend and the celery workers.
sentry_sdk is only imported when a DSN is configured.

Settings, from the environment:
- SENTRY_ENVIRONMENT: e.g. production, staging
- SENTRY_RELEASE: overrides the release (by default the server's image version, or the CLI's version)
- SENTRY_TRACES_SAMPLE_RATE: share of the requests/tasks traced (SENTRY_SAMPLE_RATE is the former name)
- SENTRY_PROFILE_SESSION_SAMPLE_RATE: share of the processes that profile their traces (continuous profiling)
- SENTRY_PROFILES_SAMPLE_RATE: for Sentry servers without continuous profiling: share of the traces profiled
- SENTRY_CA_CERTS: the CA bundle that signed the Sentry server's certificate, see ca_certs()
"""
import os
import re
import sys
import ssl
from pathlib import Path


def env_float(names, default):
  """The first of the environment variables `names` that is set, as a float."""
  for name in names:
    value = os.environ.get(name)
    if value is None or not value.strip():
      continue
    try:
      return float(value)
    except ValueError:
      print(f"WARNING: Sentry: ignoring {name}={value!r}, it should be a number", file=sys.stderr)
  return default


def traces_sample_rate(default):
  return env_float(('SENTRY_TRACES_SAMPLE_RATE', 'SENTRY_SAMPLE_RATE'), default)


# Where the OS keeps CAs added by admins (update-ca-certificates on Debian/Ubuntu, update-ca-trust on RHEL)
ADDED_CA_DIRS = ('/usr/local/share/ca-certificates', '/etc/pki/ca-trust/source/anchors')

def system_ca_bundle():
  """The OS's CA bundle, which includes the CAs added by admins (unlike certifi's, that sentry_sdk uses by default)."""
  paths = ssl.get_default_verify_paths()
  candidates = (
    paths.cafile,
    paths.openssl_cafile,
    '/etc/ssl/certs/ca-certificates.crt', # debian, ubuntu, alpine
    '/etc/pki/tls/certs/ca-bundle.crt',   # rhel
    '/etc/ssl/cert.pem',                  # macos
  )
  for candidate in candidates:
    if candidate and os.path.isfile(candidate):
      return candidate
  return None


def has_added_cas():
  for directory in ADDED_CA_DIRS:
    try:
      if any(p.is_file() for p in Path(directory).rglob('*')):
        return True
    except OSError:
      pass
  return False


def ca_certs(setting=None):
  """
  Returns (ca_certs, verify): how to check the certificate of the Sentry server.

  `setting` can be:
  - the path to a CA bundle,
  - "system": the OS's CA bundle,
  - unset/true: sentry_sdk's default ($SSL_CERT_FILE, $REQUESTS_CA_BUNDLE, else certifi's bundle),
    or the OS's bundle if admins added CAs to it, like our Docker images do with the CA_CERT_URL build argument,
  - false: don't check the certificate. Only when you ask for it: it's logged.
  """
  if setting is not None and not isinstance(setting, bool):
    setting = str(setting).strip()
    lowered = setting.lower()
    if lowered in ('0', 'false', 'no', 'off'):
      setting = False
    elif lowered in ('', '1', 'true', 'yes', 'on'):
      setting = None
  if setting is False:
    print("WARNING: Sentry: not checking the server's TLS certificate, as configured", file=sys.stderr)
    return None, False
  if setting and setting is not True:
    if setting.lower() == 'system':
      return system_ca_bundle(), True
    if not os.path.isfile(setting):
      print(f"WARNING: Sentry: the CA bundle {setting} doesn't exist", file=sys.stderr)
    return setting, True
  if os.environ.get('SSL_CERT_FILE') or os.environ.get('REQUESTS_CA_BUNDLE'):
    return None, True
  if has_added_cas():
    return system_ca_bundle(), True
  return None, True


def insecure_transport():
  import urllib3
  import sentry_sdk.transport
  urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
  class InsecureHttpTransport(sentry_sdk.transport.HttpTransport):
    def _get_pool_options(self, *args, **kwargs):
      options = super()._get_pool_options(*args, **kwargs)
      options["cert_reqs"] = "CERT_NONE"
      options.pop("ca_certs", None)
      return options
  return InsecureHttpTransport



# Scrubbing: sentry_sdk already leaves out cookies, IPs and sensitive headers (send_default_pii=False),
# but tokens also travel in URLs (e.g. /api/...?token=, GitLab's ?private_token=), and webhooks send secrets in headers.
FILTERED = '[Filtered]'
SENSITIVE_PARAMS = re.compile(
  r'(?P<key>(?:[\w.\-\[\]]*(?:token|secret|password|passwd|api_?key|signature|credential)[\w.\-\[\]]*|\bauth|\bauthorization|\bsig)=)[^&#;\s"\']*',
  re.IGNORECASE,
)
SENSITIVE_HEADERS = re.compile(r'authorization|cookie|token|secret|signature|api[-_]?key|password', re.IGNORECASE)


def scrub_string(value):
  """Filters the values of sensitive URL parameters, e.g. "?token=abc&a=1" => "?token=[Filtered]&a=1"."""
  if not isinstance(value, str) or '=' not in value:
    return value
  return SENSITIVE_PARAMS.sub(lambda m: m.group('key') + FILTERED, value)


def scrub_dict_values(d, keys):
  if not isinstance(d, dict):
    return
  for key in keys:
    if key in d:
      d[key] = scrub_string(d[key])


def scrub_values(value, depth=0):
  """Filters the values of sensitive keys, and the sensitive URL parameters in strings, e.g. in a WSGI environ."""
  if depth > 10:
    return value
  if isinstance(value, str):
    return scrub_string(value)
  if isinstance(value, dict):
    return {
      k: FILTERED if isinstance(k, str) and SENSITIVE_HEADERS.search(k) and v else scrub_values(v, depth + 1)
      for k, v in value.items()
    }
  if isinstance(value, list):
    return [scrub_values(v, depth + 1) for v in value]
  return value


def scrub_frames(container):
  """The local variables of the stack frames in exceptions and threads, e.g. a WSGI environ with QUERY_STRING"""
  values = container.get('values') if isinstance(container, dict) else None
  for value in values if isinstance(values, list) else []:
    frames = ((value.get('stacktrace') or {}).get('frames') or []) if isinstance(value, dict) else []
    for frame in frames:
      if isinstance(frame, dict) and frame.get('vars'):
        frame['vars'] = scrub_values(frame['vars'])


def scrub_event(event, hint=None):
  """before_send and before_send_transaction: filters tokens, cookies and secrets from what we send."""
  scrub_frames(event.get('exception'))
  scrub_frames(event.get('threads'))
  request = event.get('request')
  if isinstance(request, dict):
    scrub_dict_values(request, ('url', 'query_string'))
    request.pop('cookies', None)
    headers = request.get('headers')
    if isinstance(headers, dict):
      for name in list(headers):
        if SENSITIVE_HEADERS.search(str(name)):
          headers[name] = FILTERED
  breadcrumbs = event.get('breadcrumbs')
  values = breadcrumbs.get('values') if isinstance(breadcrumbs, dict) else breadcrumbs
  for crumb in values if isinstance(values, list) else []:
    if isinstance(crumb, dict):
      scrub_dict_values(crumb, ('message',))
      scrub_dict_values(crumb.get('data'), ('url', 'http.query', 'http.fragment'))
  for span in event.get('spans') or []:
    if isinstance(span, dict):
      scrub_dict_values(span, ('description',))
      scrub_dict_values(span.get('data'), ('url', 'http.query', 'http.fragment', 'http.url'))
  trace = (event.get('contexts') or {}).get('trace')
  if isinstance(trace, dict):
    scrub_dict_values(trace, ('description',))
    scrub_dict_values(trace.get('data'), ('url', 'http.query', 'http.fragment', 'http.url'))
  return event


def sentry_options(dsn, release=None, environment='production', traces_rate=0.2, profile_session_rate=0.1, ca_setting=None, **kwargs):
  """
  Arguments for sentry_sdk.init. The environment can override the defaults given here (see the module's docstring).
  """
  options = dict(
    dsn=dsn,
    release=os.environ.get('SENTRY_RELEASE') or release or None,
    environment=os.environ.get('SENTRY_ENVIRONMENT') or environment,
    traces_sample_rate=traces_sample_rate(traces_rate),
    # We set the user ourselves, with only their username
    send_default_pii=False,
    before_send=scrub_event,
    before_send_transaction=scrub_event,
  )
  profiles_rate = env_float(('SENTRY_PROFILES_SAMPLE_RATE',), None)
  if profiles_rate is not None:
    # Transaction-based profiling, for Sentry servers that don't support continuous profiling
    options['profiles_sample_rate'] = profiles_rate
  else:
    # Continuous profiling: the processes sampled profile their code while they have traces
    options['profile_session_sample_rate'] = env_float(('SENTRY_PROFILE_SESSION_SAMPLE_RATE',), profile_session_rate)
    options['profile_lifecycle'] = 'trace'
  certs, verify = ca_certs(ca_setting if ca_setting is not None else os.environ.get('SENTRY_CA_CERTS'))
  if not verify:
    options['transport'] = insecure_transport()
  elif certs:
    options['ca_certs'] = certs
  options.update(kwargs)
  return options
