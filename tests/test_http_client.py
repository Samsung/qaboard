"""
Tests for qaboard/http_client.py: how qa talks to the server, tries again, and says why a request failed.
"""
import unittest
from unittest import mock

import requests

from qaboard import http_client
from qaboard.http_client import ResultsError, request, request_json, url_for


def answer(status=200, body=None, headers=None, text=None):
  r = mock.Mock()
  r.status_code = status
  r.headers = headers or {}
  if body is None:
    r.json.side_effect = ValueError('not JSON')
  else:
    r.json.return_value = body
  r.text = text if text is not None else str(body)
  return r


class RequestTestCase(unittest.TestCase):
  def setUp(self):
    sleep = mock.patch.object(http_client.time, 'sleep')
    self.sleep = sleep.start()
    self.addCleanup(sleep.stop)

  def requests(self, *answers):
    patch = mock.patch('requests.request', side_effect=list(answers))
    self.addCleanup(patch.stop)
    return patch.start()


class TestUrls(unittest.TestCase):
  def test_api_paths_and_server_paths(self):
    self.assertEqual(url_for('https://qa/', 'output/1/files/a.txt'), 'https://qa/api/v1/output/1/files/a.txt')
    # the URLs the API gives for runs' files
    self.assertEqual(url_for('https://qa', '/s/runs/a/manifest.outputs.json'), 'https://qa/s/runs/a/manifest.outputs.json')


class TestRetries(RequestTestCase):
  def test_transient_errors_are_tried_again(self):
    sent = self.requests(requests.ConnectionError('reset'), answer(503, text='<html>busy</html>'), answer(200, {'ok': True}))
    self.assertEqual(request_json('http://qa', 'commit', token='t', retries=(1, 4)), {'ok': True})
    self.assertEqual(sent.call_count, 3)
    self.assertEqual([c.args[0] for c in self.sleep.call_args_list], [1, 4])
    self.assertEqual(sent.call_args.kwargs['headers']['Authorization'], 'Bearer t')

  def test_no_retries_unless_asked(self):
    # e.g. appending to a log at an offset: the caller decides what to do when an answer is lost
    sent = self.requests(answer(503, text='busy'))
    with self.assertRaises(ResultsError) as e:
      request_json('http://qa', 'commit', token='t')
    self.assertTrue(e.exception.is_transient)
    self.assertEqual(sent.call_count, 1)

  def test_a_misconfigured_proxy_isnt_tried_again(self):
    # a 500, but nginx won't start checking tokens between two tries
    sent = self.requests(answer(500, {'error': 'nginx misses a snippet', 'reason': 'proxy_misconfigured'}))
    with self.assertRaises(ResultsError) as e:
      request_json('http://qa', 'output/1/files/a', method='PUT', token='t', retries=(1, 4))
    self.assertFalse(e.exception.is_transient)
    self.assertEqual(e.exception.reason, 'proxy_misconfigured')
    self.assertEqual(sent.call_count, 1)

  def test_gives_up_after_the_last_try(self):
    sent = self.requests(*[answer(502, text='bad gateway')] * 3)
    with self.assertRaises(ResultsError) as e:
      request('http://qa', 'commit', token='t', retries=(0, 0))
    self.assertEqual((e.exception.status, sent.call_count), (502, 3))

  def test_refusals_are_not_tried_again(self):
    for status in (400, 404, 409, 413, 422, 501):
      with mock.patch('requests.request', return_value=answer(status, {'error': 'No.', 'reason': 'some_reason'})) as sent, self.assertRaises(ResultsError) as e:
        request('http://qa', 'output/1/files/a', method='PUT', data=b'x', token='t', retries=(0, 0))
      self.assertEqual(sent.call_count, 1)
      self.assertFalse(e.exception.is_transient)

  def test_waits_for_retry_after(self):
    self.requests(answer(429, {'error': 'Too many'}, headers={'Retry-After': '7'}), answer(200, {}))
    request('http://qa', 'commit', token='t', retries=(1,))
    self.sleep.assert_called_once_with(7.0)

  def test_doesnt_wait_too_long(self):
    sent = self.requests(answer(503, {'error': 'Maintenance'}, headers={'Retry-After': '3600'}), answer(200, {}))
    with self.assertRaises(ResultsError) as e:
      request('http://qa', 'commit', token='t', retries=(1,))
    self.assertEqual((e.exception.retry_after, sent.call_count), (3600.0, 1))

  def test_wrong_urls_are_not_tried_again(self):
    sent = self.requests(requests.exceptions.InvalidURL('no host'))
    with self.assertRaises(ResultsError) as e:
      request('http://', 'commit', token='t', retries=(0, 0))
    self.assertIsNone(e.exception.status)
    self.assertFalse(e.exception.is_transient)
    self.assertEqual(sent.call_count, 1)

  def test_give_up(self):
    sent = self.requests(answer(503, text='busy'), answer(200, {}))
    with self.assertRaises(ResultsError):
      request('http://qa', 'commit', token='t', retries=(0,), give_up=lambda: True)
    self.assertEqual(sent.call_count, 1)

  def test_bodies_are_given_again_for_each_try(self):
    opened = []
    class Body:
      closed = False
      def close(self):
        self.closed = True
    def body():
      opened.append(Body())
      return opened[-1]
    sent = self.requests(answer(500, text='oops'), answer(200, {}))
    request('http://qa', 'output/1/files/a', method='PUT', data=body, token='t', retries=(0,))
    self.assertEqual(len(opened), 2)
    self.assertTrue(all(b.closed for b in opened))
    self.assertIs(sent.call_args.kwargs['data'], opened[1])
    # a file object can only be read once
    with self.assertRaises(ValueError):
      request('http://qa', 'output/1/files/a', method='PUT', data=Body(), token='t', retries=(0,))


class TestErrors(RequestTestCase):
  def test_the_servers_reason_and_words(self):
    self.requests(answer(400, {'error': "This server doesn't accept uploaded files.", 'reason': 'uploads_disabled'}))
    with self.assertRaises(ResultsError) as e:
      request('http://qa', 'output/', method='POST', json={}, token='t')
    self.assertEqual((e.exception.status, e.exception.reason), (400, 'uploads_disabled'))
    self.assertEqual(e.exception.body['reason'], 'uploads_disabled')
    self.assertIn("doesn't accept uploaded files", str(e.exception))

  def test_token_refusals_say_how_to_sign_in(self):
    self.requests(answer(403, {'error': "This token can't send results", 'reason': 'missing_scope'}))
    with self.assertRaises(ResultsError) as e:
      request('http://qa', 'output/1/metrics', method='PATCH', json={}, token='t')
    self.assertTrue(e.exception.is_refusal)
    self.assertEqual(e.exception.reason, 'missing_scope')
    self.assertIn('ingest scope', str(e.exception))

  def test_answers_that_arent_the_apis(self):
    # e.g. a proxy's HTML page
    self.requests(answer(404, text='<html>Not Found</html>'))
    with self.assertRaises(ResultsError) as e:
      request('http://qa', 'commit', token='t')
    self.assertIsNone(e.exception.reason)
    self.assertEqual(e.exception.body, {})
    self.requests(answer(200, text='<html>sign in</html>'))
    with self.assertRaisesRegex(ResultsError, "Can't understand"):
      request_json('http://qa', 'commit', token='t')


if __name__ == '__main__':
  unittest.main()
