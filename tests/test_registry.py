"""
Images per commit: {commit} in runners.kubernetes.image, and asking registries whether they have an image.
"""
import base64
import unittest
from unittest import mock

from qaboard.runners.registry import commit_image, has_commit, parse_image, credentials_in, image_exists, parse_challenge


class Response():
  def __init__(self, status_code, headers=None, body=None):
    self.status_code, self.headers, self.body = status_code, headers or {}, body
  def json(self):
    if self.body is None:
      raise ValueError('no JSON')
    return self.body


class FakeRegistry():
  """A requests.Session that answers like a registry: anonymous, with tokens, or with basic auth"""
  def __init__(self, tags, auth=None, user=('alice', 's3cret'), status=None):
    self.tags = tags
    self.auth = auth # None | 'bearer' | 'basic'
    self.user = user
    self.status = status
    self.requests = []

  def head(self, url, headers, timeout):
    self.requests.append(('HEAD', url, headers.get('Authorization')))
    if self.status:
      return Response(self.status)
    assert 'application/vnd.oci.image.index.v1+json' in headers['Accept']
    authorization = headers.get('Authorization')
    if self.auth == 'bearer' and authorization != 'Bearer t0ken':
      return Response(401, {'WWW-Authenticate': 'Bearer realm="https://auth.example.com/token",service="registry.example.com"'})
    basic = 'Basic ' + base64.b64encode(f'{self.user[0]}:{self.user[1]}'.encode()).decode()
    if self.auth == 'basic' and authorization != basic:
      return Response(401, {'WWW-Authenticate': 'Basic realm="registry"'})
    return Response(200 if url.rsplit('/', 1)[-1] in self.tags else 404)

  def get(self, url, params, auth, timeout):
    self.requests.append(('GET', url, params, auth))
    if auth is not None and auth != self.user:
      return Response(401)
    return Response(200, body={'token': 't0ken'})


class TestCommitImage(unittest.TestCase):
  def test_replaces_the_commit(self):
    sha = '0123456789abcdef0123456789abcdef01234567'
    self.assertEqual(commit_image('registry.example.com/algo/qa:{commit}', sha), f'registry.example.com/algo/qa:{sha}')
    self.assertEqual(commit_image('registry.example.com/algo/qa:sha-{commit:.8}', sha), 'registry.example.com/algo/qa:sha-01234567')
    self.assertEqual(commit_image('registry.example.com:5000/qa-{commit:.8}:latest', sha), 'registry.example.com:5000/qa-01234567:latest')
    # images without it are unchanged, even without a commit
    self.assertEqual(commit_image('qa:1', None), 'qa:1')
    self.assertTrue(has_commit('qa:{commit:.12}'))
    self.assertFalse(has_commit('qa:1'))
    self.assertFalse(has_commit(None))

  def test_errors(self):
    with self.assertRaisesRegex(ValueError, "don't know the commit"):
      commit_image('qa:{commit}', None)
    with self.assertRaisesRegex(ValueError, "don't know the commit"):
      commit_image('qa:{commit}', '$(rm -rf /)')
    with self.assertRaisesRegex(ValueError, 'only {commit}'):
      commit_image('qa:{branch}', 'abc')
    with self.assertRaisesRegex(ValueError, 'only {commit}'):
      commit_image('qa:{commit}-{branch}', 'abc')
    with self.assertRaisesRegex(ValueError, 'empty'):
      commit_image('qa:{commit:.0}', 'abc')


class TestParse(unittest.TestCase):
  def test_parse_image(self):
    def parsed(image):
      ref = parse_image(image)
      return ref.registry, ref.api_host, ref.repository, ref.reference
    self.assertEqual(parsed('python:3.13'), ('docker.io', 'registry-1.docker.io', 'library/python', '3.13'))
    self.assertEqual(parsed('algo/qa'), ('docker.io', 'registry-1.docker.io', 'algo/qa', 'latest'))
    self.assertEqual(parsed('ghcr.io/samsung/qaboard:backend-01234567'), ('ghcr.io', 'ghcr.io', 'samsung/qaboard', 'backend-01234567'))
    self.assertEqual(parsed('localhost:5000/qa:abc'), ('localhost:5000', 'localhost:5000', 'qa', 'abc'))
    self.assertEqual(parsed('registry.example.com:5000/a/b/c'), ('registry.example.com:5000', 'registry.example.com:5000', 'a/b/c', 'latest'))
    self.assertEqual(parsed('qa@sha256:' + 'a' * 64)[3], 'sha256:' + 'a' * 64)
    with self.assertRaises(ValueError):
      parse_image('qa:not a tag')

  def test_credentials(self):
    auth = base64.b64encode(b'alice:pa:ss').decode()
    self.assertEqual(credentials_in({'auths': {'registry.example.com': {'auth': auth}}}, 'registry.example.com'), ('alice', 'pa:ss'))
    self.assertEqual(credentials_in({'auths': {'https://registry.example.com': {'username': 'bob', 'password': 'x'}}}, 'registry.example.com'), ('bob', 'x'))
    self.assertEqual(credentials_in({'auths': {'https://index.docker.io/v1/': {'auth': auth}}}, 'docker.io'), ('alice', 'pa:ss'))
    # only for that registry
    self.assertIsNone(credentials_in({'auths': {'other.example.com': {'auth': auth}}}, 'registry.example.com'))
    self.assertIsNone(credentials_in({'auths': {'registry.example.com': {'auth': 'not base64!'}}}, 'registry.example.com'))
    self.assertIsNone(credentials_in({}, 'registry.example.com'))

  def test_challenge(self):
    self.assertEqual(parse_challenge('Bearer realm="https://a/token",service="b",scope="repository:c:pull"'),
                     ('bearer', {'realm': 'https://a/token', 'service': 'b', 'scope': 'repository:c:pull'}))


class TestImageExists(unittest.TestCase):
  def test_anonymous(self):
    registry = FakeRegistry(['abc'])
    self.assertTrue(image_exists('registry.example.com/qa:abc', session=registry).exists)
    self.assertEqual(registry.requests[0][1], 'https://registry.example.com/v2/qa/manifests/abc')
    found = image_exists('registry.example.com/qa:def', session=registry)
    self.assertIs(found.exists, False)
    self.assertIn('has no qa:def', found.why)

  def test_tokens(self):
    registry = FakeRegistry(['abc'], auth='bearer')
    self.assertTrue(image_exists('registry.example.com/qa:abc', session=registry).exists)
    get = next(r for r in registry.requests if r[0] == 'GET')
    self.assertEqual(get[1:], ('https://auth.example.com/token', {'scope': 'repository:qa:pull', 'service': 'registry.example.com'}, None))
    self.assertIs(image_exists('registry.example.com/qa:def', session=registry).exists, False)
    # with the credentials of the pull secrets
    config = {'auths': {'registry.example.com': {'username': 'alice', 'password': 's3cret'}}}
    registry.requests.clear()
    self.assertTrue(image_exists('registry.example.com/qa:abc', [{}, config], session=registry).exists)
    self.assertEqual(next(r for r in registry.requests if r[0] == 'GET')[3], ('alice', 's3cret'))

  def test_basic(self):
    registry = FakeRegistry(['abc'], auth='basic')
    config = {'auths': {'registry.example.com': {'username': 'alice', 'password': 's3cret'}}}
    self.assertTrue(image_exists('registry.example.com/qa:abc', [config], session=registry).exists)
    # without credentials we can't tell, and say why
    found = image_exists('registry.example.com/qa:abc', session=registry)
    self.assertIsNone(found.exists)
    self.assertIn('no credentials', found.why)

  def test_cant_tell(self):
    self.assertIsNone(image_exists('registry.example.com/qa:abc', session=FakeRegistry([], status=500)).exists)
    self.assertIsNone(image_exists('registry.example.com/qa:abc', session=FakeRegistry([], status=403)).exists)
    self.assertIsNone(image_exists('qa:not a tag', session=FakeRegistry([])).exists)
    import requests
    session = mock.Mock()
    session.head.side_effect = requests.ConnectionError('down')
    found = image_exists('registry.example.com/qa:abc', session=session)
    self.assertIsNone(found.exists)
    self.assertIn("can't reach registry.example.com", found.why)

  def test_local_registries_without_tls(self):
    import requests
    registry = FakeRegistry(['abc'])
    head = registry.head
    def https_fails(url, **kwargs):
      if url.startswith('https://'):
        raise requests.exceptions.SSLError('wrong version number')
      return head(url, **kwargs)
    registry.head = https_fails
    self.assertTrue(image_exists('localhost:5001/qa:abc', session=registry).exists)
    # only local ones
    self.assertIsNone(image_exists('registry.example.com/qa:abc', session=registry).exists)
