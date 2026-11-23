"""`qa run` in the smallest project: a qaboard.yaml with a name and an entrypoint, no project.url nor postprocess"""
import os
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path


class TestMinimalProject(unittest.TestCase):
  def test_qa_run(self):
    with tempfile.TemporaryDirectory() as tmp:
      project = Path(tmp)
      subprocess.run(['git', 'init', '-q'], cwd=project, check=True)
      (project / 'qaboard.yaml').write_text('project:\n  name: e2e/minimal\n  entrypoint: main.py\ninputs:\n  database: {linux: ., windows: .}\n')
      # run() may leave `is_failed` out
      (project / 'main.py').write_text('def run(context):\n  return {"loss": 1}\n')
      (project / 'a.txt').write_text('a\n')
      env = {k: v for k, v in os.environ.items() if not k.startswith(('QA_', 'QABOARD_', 'CI', 'GITHUB_', 'GITLAB_'))}
      out = subprocess.run([sys.executable, '-m', 'qaboard', 'run', '--input', 'a.txt'], cwd=project, env={**env, 'QA_OFFLINE': '1'},
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8')
      self.assertEqual(out.returncode, 0, out.stdout)
      self.assertNotIn("KeyError", out.stdout)
      self.assertNotIn("misses a key `is_failed`", out.stdout)
      self.assertIn("'loss': 1", out.stdout)


if __name__ == '__main__':
  unittest.main()
