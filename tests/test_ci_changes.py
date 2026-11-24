"""
Which CI jobs a change runs (.github/scripts/ci_changes.py, documented in docs/ci.md), and that
.github/workflows/ci.yaml wires every job of the mapping: its `if:`, and the ci-ok check that waits for it.
"""
import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("ci_changes", ROOT / ".github" / "scripts" / "ci_changes.py")
ci_changes = importlib.util.module_from_spec(spec)  # type: ignore
spec.loader.exec_module(ci_changes)  # type: ignore

ALL = set(ci_changes.JOBS)
E2E = {"quickstart", "helm-e2e", "kubernetes-runner-e2e"}


def runs(files, labels=(), full=""):
  mode, why = ci_changes.decide(files, labels, full)
  return mode, {job for job, reason in why.items() if reason}


class TestDecide(unittest.TestCase):
  def test_docs_only_runs_nothing(self):
    self.assertEqual(runs(["docs/ci.md", "README.md", "drafts/x.txt", "webapp/src/image-viewer/README.md"]), ("docs-only", set()))
    # also on master, like ci.yaml's former `paths:`
    self.assertEqual(runs(["docs/warts.md"], full="push to master"), ("docs-only", set()))

  def test_docs_pages_run_the_python_tests(self):
    # the tests check the docs pages qa links to, release_notes.py check their links
    self.assertEqual(runs(["website/docs/user-guide/image-viewer.mdx"]), ("diff", {"python"}))
    self.assertEqual(runs(["website/src/pages/index.js", "website/static/img/a.png"]), ("diff", set()))

  def test_release_notes(self):
    # .md, but the web app bundles them and the Python job checks them
    self.assertEqual(runs(["website/release-notes/2026-11.md"])[1], {"python", "webapp", "docker"})

  def test_webapp_only(self):
    self.assertEqual(runs(["webapp/src/components/tables.jsx"])[1], {"webapp", "docker"})

  def test_shared_fixtures(self):
    self.assertEqual(runs(["tests/fixtures/series/a.json"])[1], {"python", "webapp", "docker"})
    self.assertEqual(runs(["qaboard/schemas/batches.schema.json"])[1], {"python", "webapp", "docker"})

  def test_qaboard_package(self):
    self.assertEqual(runs(["qaboard/config.py"])[1], {"python", "docker"})
    self.assertEqual(runs(["qaboard/runners/kubernetes.py"])[1], {"python", "docker", "helm-e2e", "kubernetes-runner-e2e"})
    self.assertEqual(runs(["qaboard/runners/lsf.py"])[1], {"python", "docker", "kubernetes-runner-e2e"})

  def test_dependencies(self):
    self.assertEqual(runs(["uv.lock"])[1], {"python", "docker"})
    self.assertEqual(runs(["webapp/package-lock.json"])[1], {"webapp", "docker"})

  def test_chart(self):
    self.assertEqual(runs(["charts/qaboard/templates/backend.yaml"])[1], {"helm", "helm-e2e"})
    # the Python tests check the chart's nginx config and values
    self.assertEqual(runs(["charts/qaboard/values.yaml"])[1], {"python", "helm", "helm-e2e"})

  def test_dockerfiles_run_the_deploys(self):
    self.assertEqual(runs(["backend/Dockerfile"])[1], {"python", "docker", "quickstart", "helm-e2e"})
    self.assertEqual(runs(["services/nginx/nginx.conf.template"])[1], {"python", "docker"})
    self.assertEqual(runs(["deployments/quickstart/compose.yml"])[1], {"python", "quickstart"})

  def test_ci_itself_runs_everything(self):
    self.assertEqual(runs([".github/workflows/ci.yaml"]), ("full", ALL))
    self.assertEqual(runs([".github/scripts/ci_changes.py"]), ("full", ALL))
    self.assertEqual(runs([".github/scripts/helm_e2e.py"])[1], {"helm-e2e"})
    self.assertEqual(runs([".github/workflows/website.yml"])[1], set())

  def test_unknown_files_run_the_python_tests(self):
    self.assertEqual(runs(["some-new-folder/thing.toml"])[1], {"python"})

  def test_label_runs_the_end_to_end_jobs(self):
    self.assertEqual(runs(["webapp/src/a.jsx"], ["run-e2e"])[1], {"webapp", "docker", *E2E})
    self.assertEqual(runs(["webapp/src/a.jsx"], ["docs-media"])[1], {"webapp", "docker"})

  def test_events_that_run_everything(self):
    self.assertEqual(runs(None, full="release"), ("full", ALL))
    self.assertEqual(runs(["webapp/src/a.jsx"], full="push to master"), ("full", ALL))

  def test_patterns(self):
    self.assertTrue(ci_changes.matches("a/b/c.md", ["**.md"]))
    self.assertTrue(ci_changes.matches("Dockerfile", ["**/Dockerfile*"]))
    self.assertTrue(ci_changes.matches("webapp/Dockerfile.dockerignore", ["**/Dockerfile*"]))
    self.assertFalse(ci_changes.matches("deployments/sirc/sirc.yml", ["deployments/*"]))
    self.assertFalse(ci_changes.matches("webapp/x", ["**", "!webapp/**"]))
    self.assertTrue(ci_changes.matches("charts/qaboard/values.yaml", ["!charts/**", "charts/qaboard/values.yaml"]))


class TestGitDiff(unittest.TestCase):
  def test_branch_and_uncommitted_files(self):
    with tempfile.TemporaryDirectory() as repo:
      def git(*args):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=repo, check=True, capture_output=True)
      git("init", "-q", "-b", "master")
      (Path(repo) / "a.txt").write_text("a")
      git("add", ".")
      git("commit", "-q", "-m", "a")
      git("checkout", "-q", "-b", "feature")
      (Path(repo) / "webapp").mkdir()
      (Path(repo) / "webapp" / "b.js").write_text("b")
      git("add", ".")
      git("commit", "-q", "-m", "b")
      (Path(repo) / "c.py").write_text("c")
      cwd = os.getcwd()
      os.chdir(repo)
      try:
        self.assertEqual(ci_changes.changed_files("master", "HEAD"), ["webapp/b.js"])
        self.assertEqual(ci_changes.changed_files("master", None), ["c.py", "webapp/b.js"])
        self.assertIsNone(ci_changes.changed_files("no-such-ref", "HEAD"))
      finally:
        os.chdir(cwd)


class TestWorkflow(unittest.TestCase):
  def test_every_job_is_wired(self):
    workflow = yaml.safe_load((ROOT / ".github" / "workflows" / "ci.yaml").read_text())
    jobs = workflow["jobs"]
    outputs = jobs["changes"]["outputs"]
    for job in ci_changes.JOBS:
      self.assertIn(job, outputs)
      self.assertEqual(jobs[job]["if"], f"needs.changes.outputs.{job} == 'true'")
    self.assertEqual(set(jobs["ci-ok"]["needs"]), {"changes", *ci_changes.JOBS})
    self.assertEqual(jobs["ci-ok"]["if"], "always()")
    # the publish waits for jobs that run on master
    self.assertLessEqual(set(jobs["publish-docker-images"]["needs"]), set(ci_changes.JOBS))
    # a workflow-level paths filter would never report ci-ok
    self.assertNotIn("paths", workflow[True]["push"])  # `on:` is True for YAML 1.1


if __name__ == "__main__":
  unittest.main()
