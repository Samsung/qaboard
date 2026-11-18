"""
Images per commit: `{commit}` in an image name (runners.kubernetes.image), and whether its registry has it.

Teams that build an image per commit in CI (with the code, at `workdir`) name it like
`registry.example.com/algo/qa:{commit}`. Before starting pods, we ask the registry whether the commit's image exists
(the Docker Registry HTTP API v2 / OCI distribution spec: HEAD /v2/<name>/manifests/<tag>): "no image for this commit"
says more than pods in ImagePullBackOff. When we can't tell (no credentials, network...), runs start anyway, and the
runner's diagnostics explain pull errors as before.
"""
import re
import json
import base64
from pathlib import Path
from dataclasses import dataclass
from typing import Optional, Dict, Tuple, List, Iterable

# {commit}, or its first N characters: {commit:.8}
commit_field = re.compile(r'\{commit(?::\.(\d+))?\}')
# what a tag can be (OCI distribution spec)
tag_pattern = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')
docker_hub = 'docker.io'
docker_hub_api = 'registry-1.docker.io'
manifest_types = ', '.join([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
])
timeout = 10 # seconds, per request


def has_commit(image: Optional[str]) -> bool:
  return bool(image) and bool(commit_field.search(image or ''))


def commit_image(image: str, commit: Optional[str]) -> str:
  """
  `image` with {commit} (or {commit:.8}, its first 8 characters) replaced by the commit's id.
  Raises ValueError if the image needs a commit and there is none, or has other {...} fields.
  """
  if not has_commit(image):
    if '{' in image or '}' in image:
      raise ValueError(f'runners.kubernetes.image: only {{commit}} and {{commit:.8}} can be replaced in {image!r}.')
    return image
  if not commit or not re.match(r'^[0-9A-Za-z_.-]+$', commit):
    raise ValueError(f"runners.kubernetes.image is {image!r}, but we don't know the commit: run in a git repository, or in a CI.")
  def replace(match: 're.Match[str]') -> str:
    length = match.group(1)
    if length is not None and int(length) < 1:
      raise ValueError(f'runners.kubernetes.image: {match.group(0)} would be empty.')
    return commit[:int(length)] if length is not None else commit
  resolved = commit_field.sub(replace, image)
  if '{' in resolved or '}' in resolved:
    raise ValueError(f'runners.kubernetes.image: only {{commit}} and {{commit:.8}} can be replaced in {image!r}.')
  return resolved


@dataclass
class ImageReference():
  registry: str   # as written, e.g. registry.example.com:5000, or docker.io
  repository: str # e.g. algo/qa, library/python
  tag: Optional[str] = None
  digest: Optional[str] = None

  @property
  def api_host(self) -> str:
    return docker_hub_api if self.registry == docker_hub else self.registry

  @property
  def reference(self) -> str:
    return self.digest or self.tag or 'latest'


def parse_image(image: str) -> ImageReference:
  """Like Docker's reference parsing: the first part is a registry if it has a . or a :, or is localhost"""
  name, _, digest_part = image.partition('@')
  digest = digest_part or None
  tag: Optional[str] = None
  last = name.rsplit('/', 1)[-1]
  if ':' in last:
    name, tag = name.rsplit(':', 1)
  first, _, rest = name.partition('/')
  if rest and ('.' in first or ':' in first or first == 'localhost'):
    registry, repository = first, rest
  else:
    registry, repository = docker_hub, name
  if registry == docker_hub and '/' not in repository:
    repository = f'library/{repository}'
  if not repository or (tag is not None and not tag_pattern.match(tag)):
    raise ValueError(f'Invalid image name: {image!r}')
  return ImageReference(registry, repository.lower() if registry == docker_hub else repository, tag, digest)


# Credentials: like a dockerconfigjson pull secret, or ~/.docker/config.json: {"auths": {"<registry>": {"auth": base64("user:password")}}}
Credentials = Tuple[str, str]

def registry_keys(registry: str) -> List[str]:
  keys = [registry, f'https://{registry}', f'http://{registry}', f'https://{registry}/v1/', f'https://{registry}/v2/']
  if registry == docker_hub:
    keys += ['https://index.docker.io/v1/', 'index.docker.io', docker_hub_api]
  return keys

def credentials_in(docker_config: Dict, registry: str) -> Optional[Credentials]:
  auths = docker_config.get('auths') if isinstance(docker_config, dict) else None
  if not isinstance(auths, dict):
    return None
  for key in registry_keys(registry):
    entry = auths.get(key)
    if not isinstance(entry, dict):
      continue
    if entry.get('username') and entry.get('password'):
      return str(entry['username']), str(entry['password'])
    if entry.get('auth'):
      try:
        user, _, password = base64.b64decode(entry['auth']).decode('utf-8').partition(':')
      except (ValueError, UnicodeDecodeError):
        continue
      if user:
        return user, password
  return None

def local_docker_config() -> Dict:
  """~/.docker/config.json (or $DOCKER_CONFIG/config.json). Credential helpers aren't used."""
  import os
  path = Path(os.environ.get('DOCKER_CONFIG') or Path.home() / '.docker') / 'config.json'
  try:
    return json.loads(path.read_text())
  except (OSError, ValueError):
    return {}


def parse_challenge(header: str) -> Tuple[str, Dict[str, str]]:
  """WWW-Authenticate: Bearer realm="https://auth.example.com/token",service="registry",scope="repository:a/b:pull" """
  scheme, _, params = header.strip().partition(' ')
  return scheme.lower(), {k.lower(): v for k, v in re.findall(r'(\w+)="([^"]*)"', params)}


@dataclass
class Found():
  # True: the registry has it, False: it doesn't, None: we can't tell (why)
  exists: Optional[bool]
  why: str = ''


def image_exists(image: str, docker_configs: Iterable[Dict] = (), session=None) -> Found:
  """
  Whether the registry has this image: HEAD /v2/<repository>/manifests/<tag>, with a token if it asks (anonymous,
  or with the credentials for this registry in `docker_configs`). Never raises.
  """
  import requests
  try:
    ref = parse_image(image)
  except ValueError as e:
    return Found(None, str(e))
  credentials = next((c for c in (credentials_in(config, ref.registry) for config in docker_configs) if c), None)
  http = session or requests.Session()
  # Local registries (kind, minikube) often have no TLS
  schemes = ['https', 'http'] if ref.api_host.split(':')[0] in ('localhost', '127.0.0.1') else ['https']
  headers = {'Accept': manifest_types}
  last_error = ''
  for scheme in schemes:
    url = f'{scheme}://{ref.api_host}/v2/{ref.repository}/manifests/{ref.reference}'
    try:
      response = http.head(url, headers=headers, timeout=timeout)
      if response.status_code == 401:
        authorization = authorize(http, response.headers.get('WWW-Authenticate', ''), ref, credentials)
        if authorization:
          response = http.head(url, headers={**headers, 'Authorization': authorization}, timeout=timeout)
    except requests.RequestException as e:
      last_error = f"can't reach {ref.api_host} ({type(e).__name__})"
      continue
    if response.status_code == 200:
      return Found(True)
    if response.status_code == 404:
      return Found(False, f'{ref.registry} has no {ref.repository}:{ref.reference}')
    if response.status_code in (401, 403):
      # Some registries answer 401 for repositories that don't exist: we can't tell
      hint = '' if credentials else ' (no credentials for it: image_pull_secrets, or `docker login`)'
      return Found(None, f'{ref.registry} refused to tell us{hint}')
    return Found(None, f'{ref.registry} answered HTTP {response.status_code}')
  return Found(None, last_error)


def authorize(http, challenge: str, ref: ImageReference, credentials: Optional[Credentials]) -> Optional[str]:
  """The Authorization header to retry with, after a 401 with this challenge"""
  scheme, params = parse_challenge(challenge)
  if scheme == 'basic':
    if not credentials:
      return None
    return 'Basic ' + base64.b64encode(f'{credentials[0]}:{credentials[1]}'.encode()).decode()
  if scheme != 'bearer' or not params.get('realm', '').startswith(('https://', 'http://')):
    return None
  query = {'scope': params.get('scope') or f'repository:{ref.repository}:pull'}
  if params.get('service'):
    query['service'] = params['service']
  response = http.get(params['realm'], params=query, auth=credentials, timeout=timeout)
  if response.status_code != 200:
    return None
  try:
    body = response.json()
  except ValueError:
    return None
  token = body.get('token') or body.get('access_token') if isinstance(body, dict) else None
  return f'Bearer {token}' if token else None
