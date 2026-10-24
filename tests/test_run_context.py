"""
Tests for qaboard.config.run_context: where `qa` runs, so that QA-Board shows users their runs and can hide the CI's
https://docs.python.org/3/library/unittest.html
"""
import unittest


class TestRunContext(unittest.TestCase):
  def run_context(self, **environ):
    from qaboard.config import run_context
    return run_context(environ)

  def test_local(self):
    self.assertEqual(self.run_context(HOME='/home/alice'), {"origin": "local"})

  def test_started_from_qaboard(self):
    # the web app's scripts export CI=true too
    self.assertEqual(self.run_context(QABOARD_TUNING='true', CI='true', GIT_COMMIT='abc'), {"origin": "webapp"})

  def test_gitlab(self):
    self.assertEqual(self.run_context(CI='true', GITLAB_CI='true', CI_PIPELINE_URL='https://gitlab/p/-/pipelines/1', CI_JOB_URL='https://gitlab/p/-/jobs/2', GITLAB_USER_EMAIL='alice@example.com'), {
      "origin": "ci", "provider": "gitlab", "pipeline_url": "https://gitlab/p/-/pipelines/1", "job_url": "https://gitlab/p/-/jobs/2", "triggered_by": "alice@example.com",
    })

  def test_github(self):
    self.assertEqual(self.run_context(CI='true', GITHUB_ACTIONS='true', GITHUB_SERVER_URL='https://github.com', GITHUB_REPOSITORY='o/r', GITHUB_RUN_ID='7', GITHUB_ACTOR='alice'), {
      "origin": "ci", "provider": "github", "pipeline_url": "https://github.com/o/r/actions/runs/7", "triggered_by": "alice",
    })

  def test_jenkins_without_ci_variable(self):
    self.assertEqual(self.run_context(JENKINS_URL='https://jenkins', BUILD_URL='https://jenkins/job/1'), {"origin": "ci", "provider": "jenkins", "job_url": "https://jenkins/job/1"})

  def test_other_ci(self):
    self.assertEqual(self.run_context(CI='1'), {"origin": "ci", "provider": "unknown"})
    self.assertEqual(self.run_context(GIT_COMMIT='abc'), {"origin": "ci", "provider": "unknown"})


if __name__ == '__main__':
  unittest.main()
