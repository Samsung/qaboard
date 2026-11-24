"""The pure parts of scripts/dev.py, the local development server"""
import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('dev_script', REPO / 'scripts' / 'dev.py')
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)


class TestDevScript(unittest.TestCase):
  def test_clean_env_drops_other_servers(self):
    env = dev.clean_env({'PATH': '/bin', 'QABOARD_URL': 'https://qaboard.example', 'QABOARD_TOKEN': 'secret',
                         'CI': 'true', 'GITHUB_SHA': 'abc', 'PGHOST': 'db.example', 'HOME': '/root'}, QABOARD_URL='http://localhost:5151')
    self.assertEqual(env['QABOARD_URL'], 'http://localhost:5151')
    for name in ('QABOARD_TOKEN', 'CI', 'GITHUB_SHA', 'PGHOST'):
      self.assertNotIn(name, env)
    self.assertEqual(env['PATH'], '/bin')
    self.assertIn('127.0.0.1', env['NO_PROXY'])

  def test_refusal(self):
    state = {'id': 'abc', 'postgres': {'port': 5555}}
    self.assertIsNone(dev.refusal(state, dev.marker('abc'), 'http://127.0.0.1:5151'))
    self.assertIn('up', dev.refusal(None, None, 'http://127.0.0.1:5151'))
    self.assertIn("isn't on this machine", dev.refusal(state, dev.marker('abc'), 'https://qaboard.example'))
    self.assertIn("isn't the one", dev.refusal(state, None, 'http://localhost:5151'))
    self.assertIn("isn't the one", dev.refusal(state, dev.marker('other'), 'http://localhost:5151'))

  def test_proxy_route(self):
    self.assertEqual(dev.proxy_route('GET', '/s/tmp/out.png?x=1'), 'files')
    self.assertEqual(dev.proxy_route('POST', '/s/tmp/'), 'backend')
    self.assertEqual(dev.proxy_route('GET', '/api/v1/health'), 'backend')
    self.assertEqual(dev.proxy_route('POST', '/webhook/gitlab'), 'backend')
    self.assertEqual(dev.proxy_route('GET', '/iiif/2/x/info.json'), 'backend')  # Vite sends it here: no redirect loop
    self.assertEqual(dev.proxy_route('GET', '/dev/image-pipeline/commits'), 'webapp')

  def test_plan_flags(self):
    story = {'commits': [
      dict(branch='main', flags={'a': 1, 'b': 1}),
      dict(branch='main', flags={'b': 2}),
      dict(branch='feat/x', flags={'a': 3}),
      dict(branch='feat/x', flags={'c': 4}),
    ]}
    flags = [c['effective_flags'] for c in dev.plan(story)]
    self.assertEqual(flags, [{'a': 1, 'b': 1}, {'a': 1, 'b': 2}, {'a': 3, 'b': 2}, {'a': 3, 'b': 2, 'c': 4}])

  def test_stories_branch_after_main(self):
    for story in dev.STORIES.values():
      branches = [c['branch'] for c in story['commits']]
      self.assertEqual(branches[0], 'main')
      # make_repository branches off the last main commit: a story's main commits come first
      self.assertEqual(branches, sorted(branches, key=lambda b: b != 'main'))
      hours = [c['hours'] for c in story['commits']]
      self.assertEqual(hours, sorted(hours, reverse=True))
      self.assertTrue((dev.SEED_TEMPLATES / Path(story['project']).name / 'qaboard.yaml').exists())

  def test_last_start(self):
    text = f"old\n{dev.LOG_SEPARATOR} backend started\nnew 1\nnew 2\n"
    self.assertEqual(dev.last_start(text, 10), f"{dev.LOG_SEPARATOR} backend started\nnew 1\nnew 2")
    self.assertEqual(dev.last_start("a\nb\nc", 2), "b\nc")

  def test_postgres_bin_dirs(self):
    with tempfile.TemporaryDirectory() as root:
      for version in ('12', '16', 'common'):
        (Path(root) / version / 'bin').mkdir(parents=True)
        (Path(root) / version / 'bin' / 'initdb').touch()
      self.assertEqual([p.parent.name for p in dev.postgres_bin_dirs(Path(root))], ['16', '12'])

  def test_ports(self):
    self.assertEqual(dev.pick_ports(5161, 3010), {'server': 5161, 'backend': 5162, 'web': 3010})

  @unittest.skipIf(os.name == 'nt', "POSIX permissions")
  def test_the_token_is_private_from_the_start(self):
    with tempfile.TemporaryDirectory() as tmp:
      token = Path(tmp) / 'token'
      token.write_text('old\n')
      token.chmod(0o644)
      dev.write_private(token, 'qab_pat_x\n')
      self.assertEqual(token.read_text(), 'qab_pat_x\n')
      self.assertEqual(stat.S_IMODE(token.stat().st_mode), 0o600)
      # not through a symlink someone left there
      token.unlink()
      (Path(tmp) / 'elsewhere').write_text('')
      token.symlink_to(Path(tmp) / 'elsewhere')
      with self.assertRaises(OSError):
        dev.write_private(token, 'qab_pat_x\n')
      self.assertEqual((Path(tmp) / 'elsewhere').read_text(), '')


if __name__ == '__main__':
  unittest.main()
