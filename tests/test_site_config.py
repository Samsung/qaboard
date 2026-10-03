"""
Tests for the site's base qaboard.yaml (QABOARD_SITE_CONFIG), that projects' configurations are merged on.
"""
import os
import sys
import json
import tempfile
import unittest
import subprocess
from pathlib import Path

import yaml


def site_config(root):
  return {
    "runners": {"default": "lsf", "lsf": {"queue": "site_queue"}},
    "storage": {"outputs": f"{root}/site/outputs/{{user}}", "artifacts": f"{root}/site/artifacts"},
    "inputs": {"database": {"linux": f"{root}/site/datasets", "windows": "//site/datasets"}},
  }


class TestSiteConfig(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.dir = Path(tmp.name)
    self.site_config = self.dir / 'site.yaml'
    self.site = site_config(self.dir)
    self.site_config.write_text(yaml.safe_dump(self.site))
    self.project = self.dir / 'project'
    self.project.mkdir()

  def config(self, project_config):
    """The configuration of a project, as seen from a new `qa` process."""
    (self.project / 'qaboard.yaml').write_text(yaml.safe_dump(project_config))
    env = {k: v for k, v in os.environ.items() if k not in ('QA_STORAGE', 'QA_DATABASE')}
    out = subprocess.run(
      [sys.executable, '-c', 'import json; from qaboard.config import config; print(json.dumps(config))'],
      cwd=self.project,
      env={**env, 'QABOARD_SITE_CONFIG': str(self.site_config), 'QABOARD_HOST': 'localhost:5151'},
      stdout=subprocess.PIPE,
      encoding='utf-8',
      check=True,
    )
    return json.loads(out.stdout.splitlines()[-1])

  def test_merge(self):
    config = self.config({
      "project": {"name": "group/project", "url": "git@server:group/project"},
      "runners": {"lsf": {"max_memory": 1000}},
    })
    self.assertEqual(config['project']['name'], 'group/project')
    self.assertEqual(config['runners'], {"default": "lsf", "lsf": {"queue": "site_queue", "max_memory": 1000}})
    self.assertEqual(config['storage'], self.site['storage'])
    self.assertEqual(config['inputs']['database'], self.site['inputs']['database'])

  def test_locations_are_replaced(self):
    config = self.config({
      "project": {"name": "group/project", "url": "git@server:group/project"},
      "storage": str(self.dir / "project_storage"),
      "inputs": {"database": {"linux": "/project/datasets"}},
    })
    self.assertEqual(config['storage'], str(self.dir / "project_storage"))
    self.assertEqual(config['inputs']['database'], {"linux": "/project/datasets"})

  def test_init(self):
    out = subprocess.run(
      [sys.executable, '-m', 'qaboard', 'init'],
      cwd=self.project,
      env={**os.environ, 'QABOARD_SITE_CONFIG': str(self.site_config), 'QABOARD_HOST': 'localhost:5151'},
      stdout=subprocess.PIPE,
      stderr=subprocess.STDOUT,
      encoding='utf-8',
    )
    self.assertIn('site defaults', out.stdout)
    config_text = (self.project / 'qaboard.yaml').read_text()
    project_config = yaml.safe_load(config_text)
    # the sample project's values would override the site's
    self.assertNotIn('storage', project_config)
    self.assertNotIn('database', project_config['inputs'])
    # but we show them
    self.assertIn(f'#   outputs: {self.dir}/site/outputs/{{user}}', config_text)
    # what isn't defined by the site is kept
    self.assertEqual(project_config['inputs']['batches'], ['qa/batches.yaml'])
    self.assertEqual(project_config['runners']['local'], {'concurrency': -1})


class TestUseSiteDefaults(unittest.TestCase):
  def test_shadowed_keys(self):
    from qaboard.init import shadowed_keys
    sample = {"a": {"b": 1, "c": 2}, "d": {"e": 1}, "l": [1], "storage": {"linux": "/x"}, "n": None}
    self.assertEqual(
      shadowed_keys(sample, {"a": {"b": 0}, "d": {"e": 0}, "l": [2], "storage": {"outputs": "/y"}, "n": {"m": 1}}),
      [("a", "b"), ("d",), ("storage",), ("n",)],
    )

  def test_use_site_defaults(self):
    from qaboard.init import use_site_defaults
    sample = "\n".join([
      "a:",
      "  # comment",
      "  b: 1 # comment",
      "  c: |",
      "    multi",
      "    line",
      "  # trailing comment",
      "d: 2",
    ])
    out = use_site_defaults(sample, {"a": {"c": "site"}})
    self.assertEqual(yaml.safe_load(out), {"a": {"b": 1}, "d": 2})
    self.assertIn("  # c: site\n  # trailing comment\nd: 2", out)


class TestMerge(unittest.TestCase):
  def test_dict_replaces_string(self):
    from qaboard.utils import merge
    self.assertEqual(merge({"storage": {"linux": "/x"}}, {"storage": "/y"}), {"storage": {"linux": "/x"}})
    self.assertEqual(merge({"storage": "/y"}, {"storage": {"linux": "/x"}}), {"storage": "/y"})


if __name__ == '__main__':
  unittest.main()
