"""
Tests for backend/notifications/: emails when batches end.

The SQL that finds whether a command still has pending runs also runs against a real PostgreSQL, if
QABOARD_TEST_DATABASE_URL is set (in temporary tables, in a transaction that is rolled back).
"""
import os
import re
import email
from unittest.mock import MagicMock

import pytest

from backend.notifications.batch_email import (
  summarize, render_batch_email, format_number, format_duration, format_metric, commit_url,
)
from backend.notifications.mail import email_settings, build_message, recipient_for, is_email


metrics_config = {
  'main_metrics': ['psnr', 'noise', 'missing'],
  'available_metrics': {
    'psnr': {'label': 'PSNR', 'suffix': ' dB', 'smaller_is_better': False, 'target': 30},
    'noise': {'label': 'Noise', 'suffix': '%', 'scale': 100, 'smaller_is_better': 'true', 'target': 0.02},
  },
}


def run(id, params=None, failed=False, psnr=None, noise=None, input=None, batch='sweep'):
  metrics = {} if failed else {k: v for k, v in {'psnr': psnr, 'noise': noise}.items() if v is not None}
  return {'id': id, 'input': input or f'scene_{id}.dng', 'platform': 'linux', 'batch': batch, 'params': params or {}, 'is_failed': failed, 'metrics': metrics}


info = {
  'qaboard_url': 'https://qa.example.com/',
  'project_id': 'isp/denoiser',
  'project_name': 'isp/denoiser',
  'hexsha': 'abcdef1234567890',
  'branch': 'develop',
  'commit_message': 'Faster <denoiser> & co',
  'label': 'sweep',
  'selected_group': 'low-light',
  'platform': 'linux',
  'source': 'webapp',
  'user_name': 'jdoe',
  'duration_s': 3725,
  'started_at': 'Mon 19 Oct, 14:02 UTC',
  'docs_url': 'https://qa.example.com/docs/user-guide/running-from-the-webapp#emails-when-batches-end',
}


def test_formats():
  assert format_number(31.4159) == '31.4'
  assert format_number(0.91699) == '0.917'
  assert format_number(2.0) == '2'
  assert format_number(123456.7) == '123,457'
  assert format_number(0.00001234) == '1.23e-05'
  assert format_number(0) == '0'
  assert format_metric(0.0153, {'scale': 100, 'suffix': '%'}) == '1.53%'
  assert format_metric(None, {}) == '–'
  assert format_duration(42) == '42 s'
  assert format_duration(600) == '10 min'
  assert format_duration(3725) == '1 h 02 min'
  assert format_duration(7200) == '2 h'
  assert format_duration(3 * 86400 + 3600) == '3 d 1 h'


def test_summary_counts_and_metrics():
  runs = [run(1, psnr=31, noise=0.01), run(2, psnr=29, noise=0.03), run(3, psnr=33, noise=0.01), run(4, failed=True)]
  summary = summarize(runs, metrics_config)
  assert (summary['total'], summary['succeeded'], summary['failed']) == (4, 3, 1)
  # medians of the successful runs, only for metrics they have
  assert [m['name'] for m in summary['metrics']] == ['psnr', 'noise']
  psnr, noise = summary['metrics']
  assert (psnr['value'], psnr['target'], psnr['meets_target']) == ('31 dB', '30 dB', True)
  # smaller is better, as a string in metrics.yaml
  assert (noise['value'], noise['target'], noise['meets_target']) == ('1%', '2%', True)
  # a single combination of parameters: nothing to rank
  assert summary['ranking'] is None
  assert summary['failed_runs'][0]['input'] == 'scene_4.dng'


def test_summary_ranks_the_parameters():
  runs = [
    run(1, {'strength': 0.1}, psnr=29), run(2, {'strength': 0.1}, psnr=30),
    run(3, {'strength': 0.3}, psnr=32), run(4, {'strength': 0.3}, failed=True),
    run(5, {'strength': 0.5}, psnr=31),
    # no successful run: not ranked
    run(6, {'strength': 0.9}, failed=True),
  ]
  summary = summarize(runs, metrics_config)
  assert summary['combinations'] == 4
  ranking = summary['ranking']
  assert ranking['metric'] == 'PSNR' and ranking['direction'] == 'higher is better'
  assert [(r['rank'], r['params'], r['value'], r['failed']) for r in ranking['rows']] == [
    (1, 'strength=0.3', '32 dB', 1),
    (2, 'strength=0.5', '31 dB', 0),
    (3, 'strength=0.1', '29.5 dB', 0),
  ]


def test_summary_without_metrics_config():
  summary = summarize([run(i, failed=i < 10) for i in range(12)], None)
  assert summary['metrics'] == [] and summary['ranking'] is None
  # we list a few failed runs, and say how many more there are
  assert len(summary['failed_runs']) == 8 and summary['more_failed'] == 2


def test_render_partial_failure():
  runs = [run(1, {'strength': 0.1}, psnr=29), run(2, {'strength': 0.3}, psnr=32), run(3, {'strength': 0.3}, failed=True)]
  subject, html, text = render_batch_email(summarize(runs, metrics_config), info)
  assert subject == 'sweep: 1 of 3 runs failed · isp/denoiser'
  assert 'sweep is done, with failures' in html
  # escaped
  assert 'Faster &lt;denoiser&gt; &amp; co' in html
  assert 'https://qa.example.com/isp/denoiser/commit/abcdef1234567890?batch=sweep&amp;filter=fail&amp;selected_views=logs' in html
  assert 'filter=id%3A3' in html
  assert 'Best parameters' in html and 'strength=0.3' in html
  # The preheader, shown in inboxes after the subject
  assert re.search(r'1 of 3 runs failed in 1 h 02 min · best PSNR: 32 dB with strength=0.3', html)
  assert 'View results: https://qa.example.com/isp/denoiser/commit/abcdef1234567890?batch=sweep' in text
  assert 'you started this batch from QA-Board' in text


def test_render_success_and_failure():
  subject, html, _ = render_batch_email(summarize([run(1, psnr=31), run(2, psnr=32)], metrics_config), info)
  assert subject == 'sweep: all 2 runs succeeded · isp/denoiser'
  assert 'Logs of the failed runs' not in html
  subject, html, text = render_batch_email(summarize([run(1, failed=True)], metrics_config), {**info, 'source': 'cli', 'label': 'default'})
  assert subject == 'default: 1 run failed · isp/denoiser'
  assert 'The run failed' in html
  # how to stop them
  assert 'QA_NOTIFY=none' in text
  # the default batch has no ?batch=
  assert 'https://qa.example.com/isp/denoiser/commit/abcdef1234567890"' in html


def test_html_works_in_outlook():
  _, html, _ = render_batch_email(summarize([run(1, psnr=31), run(2, failed=True)], metrics_config), info)
  # Outlook 2016/2019 (Word) ignores or breaks on these
  for unsupported in ('display:flex', 'display: flex', 'display:grid', 'var(--', 'background-image', '@font-face', '<div class', 'position:'):
    assert unsupported not in html
  # its button is drawn with VML, the layout has a fixed width
  assert '<v:roundrect' in html and '<!--[if mso]>' in html
  assert 'width="600"' in html
  assert 'role="presentation"' in html


def test_commit_url():
  assert commit_url('https://qa/', 'a/b c', 'abc', batch='default') == 'https://qa/a/b%20c/commit/abc'
  assert commit_url('https://qa', 'p', 'abc', batch='x&y', filter=None) == 'https://qa/p/commit/abc?batch=x%26y'


def test_email_settings():
  assert not email_settings({}).enabled
  settings = email_settings({'QABOARD_SMTP_HOST': 'smtp', 'QABOARD_SMTP_SECURITY': 'starttls', 'QABOARD_EMAIL_DOMAIN': '@example.com'})
  assert settings.enabled and settings.port == 587 and settings.domain == 'example.com'
  assert settings.sender == 'QA-Board <qaboard@example.com>'
  assert email_settings({'QABOARD_SMTP_HOST': 'smtp', 'QABOARD_SMTP_SECURITY': 'ssl'}).port == 465
  assert email_settings({'QABOARD_SMTP_HOST': 'smtp'}).port == 25
  assert email_settings({'QABOARD_SMTP_HOST': 'smtp', 'QABOARD_SMTP_SECURITY': 'bad'}).security == 'none'


def test_message():
  settings = email_settings({'QABOARD_SMTP_HOST': 'smtp', 'QABOARD_EMAIL_FROM': 'QA-Board <qa@example.com>', 'QABOARD_EMAIL_REPLY_TO': 'team@example.com'})
  message = build_message('jdoe@example.com', 'Done', '<p>html</p>', 'text', settings, headers={'X-QABoard-Batch': 'a\nb', 'X-Empty': None})
  parsed = email.message_from_bytes(message.as_bytes())
  assert parsed['From'] == 'QA-Board <qa@example.com>' and parsed['Reply-To'] == 'team@example.com'
  # no out-of-office replies
  assert parsed['Auto-Submitted'] == 'auto-generated' and parsed['X-Auto-Response-Suppress'] == 'All'
  assert parsed['X-QABoard-Batch'] == 'a b' and 'X-Empty' not in parsed
  assert parsed['Message-ID'].endswith('@example.com>')
  assert [part.get_content_type() for part in parsed.walk()] == ['multipart/alternative', 'text/plain', 'text/html']


def test_recipients():
  import backend.models as models
  settings = email_settings({'QABOARD_SMTP_HOST': 'smtp', 'QABOARD_EMAIL_DOMAIN': 'example.com'})
  assert recipient_for('jdoe', 'john.doe@corp.com', settings) == 'john.doe@corp.com'
  models.User.query.filter.return_value.one_or_none.return_value = MagicMock(email='jd@corp.com')
  assert recipient_for('jdoe', None, settings) == 'jd@corp.com'
  models.User.query.filter.return_value.one_or_none.return_value = None
  assert recipient_for('jdoe', '', settings) == 'jdoe@example.com'
  assert recipient_for('jdoe', None, email_settings({'QABOARD_SMTP_HOST': 'smtp'})) is None
  assert recipient_for('bad user', None, settings) is None
  assert not is_email('jdoe') and is_email('a@b.co')


@pytest.fixture
def batches_module(monkeypatch):
  import backend.notifications.batches as batches
  sent = []
  monkeypatch.setattr(batches, 'send_batch_notification', lambda session, notification: sent.append(notification))
  return batches, sent


def session_with(notification_id, pending, claimed=1):
  session = MagicMock()
  session.query.return_value.filter.return_value.scalar.return_value = notification_id
  session.execute.return_value.first.return_value = (1,) if pending else None
  session.query.return_value.filter.return_value.update.return_value = claimed
  return session


def test_no_notification_is_cheap(batches_module):
  batches, sent = batches_module
  session = session_with(None, pending=False)
  batches.on_run_ended(session, 'cmd-1')
  # we didn't look at the runs
  session.execute.assert_not_called()
  batches.on_run_ended(session, None)
  assert sent == []


def test_waits_for_the_last_run(batches_module):
  batches, sent = batches_module
  session = session_with(7, pending=True)
  batches.on_run_ended(session, 'cmd-1')
  assert session.execute.call_args.args[1] == {'command_id': 'cmd-1'}
  session.query.return_value.filter.return_value.update.assert_not_called()
  assert sent == []


def test_sends_once(batches_module):
  batches, sent = batches_module
  session = session_with(7, pending=False)
  batches.on_run_ended(session, 'cmd-1')
  assert len(sent) == 1
  update = session.query.return_value.filter.return_value.update.call_args.args[0]
  assert update['status'] == 'sending'
  # another run ending at the same time claimed it first
  session = session_with(7, pending=False, claimed=0)
  batches.on_run_ended(session, 'cmd-1')
  assert len(sent) == 1


def test_errors_never_fail_the_run_update(batches_module):
  batches, sent = batches_module
  session = MagicMock()
  session.query.side_effect = RuntimeError('database is down')
  batches.on_run_ended(session, 'cmd-1')
  session.rollback.assert_called_once()


def test_send_records_failures(monkeypatch):
  import backend.notifications.batches as batches
  monkeypatch.setattr(batches, 'command_runs', lambda session, notification: [run(1, psnr=31)])
  def fail(*args, **kwargs):
    raise ConnectionRefusedError('no SMTP server')
  monkeypatch.setattr(batches, 'send_email', fail)
  import datetime
  notification = MagicMock(status='sending', data={'source': 'webapp'}, user_name='jdoe', recipient='jdoe@example.com',
                           created_date=datetime.datetime(2026, 10, 19, 12), finished_at=datetime.datetime(2026, 10, 19, 13))
  notification.ci_commit.project_id = 'p'
  notification.ci_commit.hexsha = 'abc'
  notification.ci_commit.message = 'msg'
  notification.ci_commit.branch = 'origin/develop'
  notification.ci_commit.data = {}
  notification.ci_commit.project.data = {}
  notification.batch.label = 'sweep'
  notification.batch.data = {}
  session = MagicMock()
  batches.send_batch_notification(session, notification)
  assert notification.status == 'failed' and 'no SMTP server' in notification.error
  session.commit.assert_called()

  sent = []
  monkeypatch.setattr(batches, 'send_email', lambda to, subject, html, text, headers: sent.append((to, subject, headers)))
  notification.status = 'sending'
  batches.send_batch_notification(session, notification)
  assert notification.status == 'sent'
  assert sent == [('jdoe@example.com', 'sweep: 1 run succeeded · p', {'X-QABoard-Project': 'p', 'X-QABoard-Batch': 'sweep', 'X-QABoard-Status': 'succeeded'})]


def test_webapp_requests(monkeypatch, dummy_app):
  import backend.api.tuning as tuning
  monkeypatch.setattr(tuning, 'request_batch_notification', lambda *args, **kwargs: (None, "can't send emails"))
  with dummy_app.test_request_context('/'):
    tuning.g.user = {'user_name': 'jdoe', 'email': 'jdoe@example.com'}
    assert tuning.notify_when_done({'notify': False}, 'c1', None, None, 'jdoe', False) is None
    # not for automated tuning yet
    assert tuning.notify_when_done({'notify': 'email'}, 'c1', None, None, 'jdoe', True) is None
    assert tuning.notify_when_done({'notify': 'email', 'batch_label': 'x'}, 'c1', None, None, 'jdoe', False) == {'error': "can't send emails"}
    # on by default, e.g. for clients that don't know about emails
    assert tuning.notify_when_done({'batch_label': 'x'}, 'c1', None, None, 'jdoe', False) == {'error': "can't send emails"}


@pytest.fixture
def postgres():
  url = os.environ.get('QABOARD_TEST_DATABASE_URL')
  if not url:
    pytest.skip("QABOARD_TEST_DATABASE_URL is not set")
  psycopg2 = pytest.importorskip('psycopg2')
  connection = psycopg2.connect(url)
  try:
    cursor = connection.cursor()
    # A temporary table hides the real one, if any. Like the index in the migration.
    cursor.execute("""
      CREATE TEMPORARY TABLE outputs (id serial PRIMARY KEY, is_pending boolean, data json NOT NULL DEFAULT '{}'::json) ON COMMIT DROP;
      CREATE INDEX idx_outputs_pending_root_command ON outputs ((data->>'root_command_id')) WHERE is_pending;
    """)
    yield cursor
  finally:
    connection.rollback()
    connection.close()


def test_pending_runs_sql(postgres):
  from backend.notifications.batches import has_pending_runs
  # conftest.py makes sqlalchemy.text return the SQL
  sql = str(has_pending_runs).replace(':command_id', '%(command_id)s')
  postgres.execute("""
    INSERT INTO outputs (is_pending, data) SELECT false, json_build_object('root_command_id', 'big') FROM generate_series(1, 5000);
    INSERT INTO outputs (is_pending, data) VALUES (true, '{"root_command_id": "running"}'), (true, '{}'), (null, '{"root_command_id": "old"}');
    ANALYZE outputs;
  """)
  def pending(command_id):
    postgres.execute(sql, {'command_id': command_id})
    return postgres.fetchone() is not None
  assert pending('running')
  assert not pending('big')
  assert not pending('old')
  # only pending runs are read, whatever the size of the batch
  postgres.execute('SET enable_seqscan = off')
  postgres.execute('EXPLAIN ' + sql, {'command_id': 'big'})
  plan = '\n'.join(row[0] for row in postgres.fetchall())
  assert 'idx_outputs_pending_root_command' in plan
