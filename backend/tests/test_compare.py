"""
Tests for GET /api/v1/commit/<sha>/compare (backend/api/compare.py) and its numbers (backend/compare.py).

The numbers must be the web app's: tests/fixtures/metrics-compare.json is shared with the web app's tests
(webapp/src/utils/__tests__/compare.test.jsx), that check its Summary and Metrics Diff views give the same.
"""
import sys
import json
import datetime
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from backend.compare import compare_outputs, js_stringify, manifests_mismatch, run_counts, metrics_info


FIXTURE = json.loads((Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'metrics-compare.json').read_text())
HEXSHA = "0123456789abcdef0123456789abcdef01234567"
REF_HEXSHA = "fedcba9876543210fedcba9876543210fedcba98"


def approx(expected):
  return pytest.approx(expected, rel=1e-12, abs=1e-15)


def fixture_outputs(side):
  return list(FIXTURE[side]['outputs'].values())


def check_summary(metrics, expected):
  for key, numbers in expected.items():
    for side in ('new', 'ref'):
      assert metrics[key][side]['count'] == numbers[side]['count'], (key, side)
      assert metrics[key][side]['median'] == approx(numbers[side]['median']), (key, side)
      if numbers[side]['pass_rate'] is None:
        assert metrics[key][side]['pass_rate'] is None, (key, side)
      else:
        assert metrics[key][side]['pass_rate'] == approx(numbers[side]['pass_rate']), (key, side)
    assert metrics[key]['delta'] == approx(numbers['delta']), key
    assert metrics[key]['delta_relative'] == approx(numbers['delta_relative']), key


def check_diff(tests, expected):
  # the Metrics Diff's rows: finished runs that aren't tuning iterations
  assert [str(t['id']) for t in tests] == list(expected)
  for test in tests:
    numbers = expected[str(test['id'])]
    assert test['reference_id'] == numbers['reference_id'], test['id']
    assert test['reference_mismatch'] == numbers['reference_mismatch'], test['id']
    # cells that show a change: both runs have a number
    cells = {k: v for k, v in test['metrics'].items() if v['delta'] is not None}
    assert set(cells) == set(numbers['metrics']), test['id']
    for key, cell in cells.items():
      assert cell['delta'] == approx(numbers['metrics'][key]['delta']), (test['id'], key)
      assert cell['delta_relative'] == approx(numbers['metrics'][key]['delta_relative']), (test['id'], key)


# ==========================================
# The numbers
# ==========================================

def test_same_numbers_as_the_web_app():
  comparison = compare_outputs(fixture_outputs('new'), fixture_outputs('ref'), FIXTURE['available_metrics'])
  check_summary(comparison['metrics'], FIXTURE['expected']['summary'])
  check_diff(comparison['tests'], FIXTURE['expected']['diff'])
  # metrics that are only strings or booleans are not aggregated
  assert set(comparison['metrics']) == {'psnr', 'latency_p99', 'runtime'}


def test_the_order_of_the_runs_does_not_matter():
  comparison = compare_outputs(fixture_outputs('new')[::-1], fixture_outputs('ref')[::-1], FIXTURE['available_metrics'])
  check_summary(comparison['metrics'], FIXTURE['expected']['summary'])
  check_diff(comparison['tests'], FIXTURE['expected']['diff'])


def test_metrics_definitions():
  comparison = compare_outputs(fixture_outputs('new'), fixture_outputs('ref'), FIXTURE['available_metrics'], metrics=['psnr', 'unknown'])
  assert set(comparison['metrics']) == {'psnr', 'unknown'}
  psnr = comparison['metrics']['psnr']
  assert (psnr['smaller_is_better'], psnr['target'], psnr['suffix'], psnr['label'], psnr['declared']) == (False, 30, ' dB', 'PSNR', True)
  # like the web app, metrics are "smaller is better" unless they say otherwise
  unknown = comparison['metrics']['unknown']
  assert (unknown['smaller_is_better'], unknown['declared'], unknown['new']['median'], unknown['delta']) == (True, False, None, None)
  assert metrics_info({'m': {'smaller_is_better': 'False'}}, ['m'])['m']['smaller_is_better'] is False


def test_relative_change_uses_the_magnitude_of_the_reference():
  # a metric that is negative: going from -2 to -1 is +50%, not -50%
  new = [{'id': 1, 'test_input_path': 'a', 'metrics': {'gain': -1.0}}]
  ref = [{'id': 2, 'test_input_path': 'a', 'metrics': {'gain': -2.0}}]
  comparison = compare_outputs(new, ref)
  assert comparison['metrics']['gain']['delta_relative'] == approx(0.5)
  # a reference of 0: no relative change can be given
  ref = [{'id': 2, 'test_input_path': 'a', 'metrics': {'gain': 0.0}}]
  assert compare_outputs(new, ref)['metrics']['gain']['delta_relative'] is None
  assert compare_outputs(ref, ref)['metrics']['gain']['delta_relative'] == 0


def test_js_stringify():
  assert js_stringify(["base", {"b": 1, "a": [1.5, None, True]}]) == '["base",{"b":1,"a":[1.5,null,true]}]'
  # integer-like keys come first in JavaScript objects
  assert js_stringify({"x": 1, "10": 2, "2": 3}) == '{"2":3,"10":2,"x":1}'
  assert js_stringify({"é": "ü"}) == '{"é":"ü"}'


def test_run_counts():
  outputs = fixture_outputs('new')
  assert run_counts(outputs) == {'total': 9, 'valid': 7, 'failed': 1, 'pending': 1, 'running': 1}


def test_manifests_mismatch():
  new = {'out.png': {'md5': 'a'}, 'log.txt': {'md5': 'x'}, 'stages/1.png': {'md5': 'b'}, 'only-new.txt': {'md5': 'c'}, 'regs.txt': {'md5': 'd'}}
  ref = {'out.png': {'md5': 'a'}, 'log.txt': {'md5': 'y'}, 'stages/1.png': {'md5': 'B'}, 'regs.txt': {'md5': 'D'}}
  # logs are never compared, nor files in only one of the runs
  assert manifests_mismatch(new, ref) == ['regs.txt', 'stages/1.png']
  assert manifests_mismatch(new, ref, {'patterns': ['*.png']}) == ['stages/1.png']
  assert manifests_mismatch(new, ref, {'patterns': '*.png', 'ignore': 'stages'}) == []


# ==========================================
# The endpoint
# ==========================================

def make_output(o):
  return SimpleNamespace(id=o['id'], is_pending=o['is_pending'], is_failed=o['is_failed'], to_dict=lambda: o)


def make_commit(hexsha, batches, branch='main', data=None, project=None, id=1):
  commit = SimpleNamespace(
    id=id, hexsha=hexsha, branch=branch, message='message', committer_name='adaeze',
    authored_datetime=datetime.datetime(2026, 10, 1, 12, 0, tzinfo=datetime.timezone.utc),
    data=data or {}, project=project or SimpleNamespace(id='kitefin/camera-isp', data={}), project_id='kitefin/camera-isp',
    batches=[SimpleNamespace(label=label, data={}, outputs=[make_output(o) for o in outputs]) for label, outputs in batches.items()],
  )
  return commit


@pytest.fixture
def compare_api(monkeypatch):
  """Loads the real backend/api/compare.py, with the database mocked"""
  auth = sys.modules['backend.api.auth']
  monkeypatch.setattr(auth, 'is_authorized_user', MagicMock(return_value=True))
  path = Path(__file__).parent.parent / "backend" / "api" / "compare.py"
  spec = importlib.util.spec_from_file_location("backend.api._compare_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  module.milestones_of = lambda project_id, milestone_id=None: []
  return module


def call(compare_api, dummy_app, commits, query, branch_commit=None):
  """GET the endpoint, with `commits` {sha: commit} in the database"""
  def find_commit(project_id, hexsha):
    return next((c for sha, c in commits.items() if sha.startswith(hexsha)), None)
  compare_api.find_commit = find_commit
  compare_api.find_branch_commit = MagicMock(return_value=branch_commit)
  with dummy_app.test_request_context(f'/api/v1/commit/{HEXSHA}/compare?{query}'):
    response = compare_api.compare_commit(HEXSHA)
    if isinstance(response, tuple):
      response, status_code = response
      response.status_code = status_code
    return response


def test_compare_endpoint(compare_api, dummy_app):
  metrics = {'qatools_metrics': {'available_metrics': FIXTURE['available_metrics']}}
  new = make_commit(HEXSHA, {'default': fixture_outputs('new')}, branch='feature', data=metrics)
  ref = make_commit(REF_HEXSHA, {'default': fixture_outputs('ref')}, id=2)
  response = call(compare_api, dummy_app, {HEXSHA: new}, 'project=kitefin/camera-isp&reference=main', branch_commit=ref)
  assert response.status_code == 200
  data = response.get_json()
  check_summary(data['metrics'], FIXTURE['expected']['summary'])
  check_diff(data['tests'], FIXTURE['expected']['diff'])
  assert data['metrics']['psnr']['smaller_is_better'] is False
  assert data['commit']['id'] == HEXSHA and data['commit']['batch'] == 'default'
  assert data['reference']['id'] == REF_HEXSHA
  assert (data['reference']['type'], data['reference']['requested'], data['reference']['branch']) == ('branch', 'main', 'main')
  # the tuning iteration is not a run of the batch
  assert data['commit']['runs'] == {'total': 8, 'valid': 6, 'failed': 1, 'pending': 1, 'running': 1}
  # run 106 is still running
  assert data['status'] == 'running'
  compare_api.find_branch_commit.assert_called_once_with('kitefin/camera-isp', 'main', 'default', new)


def test_compare_finished_batches(compare_api, dummy_app):
  outputs = [o for o in fixture_outputs('new') if not o['is_pending']]
  new = make_commit(HEXSHA, {'default': outputs})
  ref = make_commit(REF_HEXSHA, {'default': [o for o in fixture_outputs('ref') if not o['is_pending']]}, id=2)
  data = call(compare_api, dummy_app, {HEXSHA: new, REF_HEXSHA: ref}, f'project=p&reference={REF_HEXSHA[:8]}&metrics=psnr').get_json()
  assert (data['status'], data['messages']) == ('complete', [])
  assert data['reference']['type'] == 'commit' and data['reference']['id'] == REF_HEXSHA
  assert list(data['metrics']) == ['psnr']
  assert data['bit_accuracy'] is None


def test_ci_names_the_ci_batch(compare_api, dummy_app):
  new = make_commit(HEXSHA, {'default': fixture_outputs('new'), 'tuning': []})
  ref = make_commit(REF_HEXSHA, {'default': fixture_outputs('ref')}, id=2)
  data = call(compare_api, dummy_app, {HEXSHA: new}, 'project=p&batch=ci', branch_commit=ref).get_json()
  assert data['commit']['batch'] == 'default' and data['reference']['batch'] == 'default'
  assert data['metrics']['psnr']['new']['count'] == 6


def test_missing_reference(compare_api, dummy_app):
  new = make_commit(HEXSHA, {'default': fixture_outputs('new')})
  data = call(compare_api, dummy_app, {HEXSHA: new}, 'project=p&reference=main', branch_commit=None).get_json()
  assert data['status'] == 'missing'
  assert data['reference']['id'] is None
  assert 'no commit on the branch "main" has runs in the batch "default"' in data['messages'][0]
  # what can be computed without a reference still is
  assert data['metrics']['psnr']['new']['median'] == 30.5 and data['metrics']['psnr']['ref']['median'] is None


def test_reference_without_runs(compare_api, dummy_app):
  new = make_commit(HEXSHA, {'default': fixture_outputs('new')})
  ref = make_commit(REF_HEXSHA, {'other': fixture_outputs('ref')}, id=2)
  data = call(compare_api, dummy_app, {HEXSHA: new, REF_HEXSHA: ref}, f'project=p&reference={REF_HEXSHA}').get_json()
  assert (data['status'], data['messages']) == ('missing', ['No runs in the batch "default" of the reference.'])
  failed = [{**o, 'is_failed': True, 'is_pending': False} for o in fixture_outputs('ref')]
  ref = make_commit(REF_HEXSHA, {'default': failed}, id=2)
  data = call(compare_api, dummy_app, {HEXSHA: new, REF_HEXSHA: ref}, f'project=p&reference={REF_HEXSHA}').get_json()
  assert (data['status'], data['messages']) == ('missing', ['All the runs failed in the batch "default" of the reference.'])


def test_missing_batch(compare_api, dummy_app):
  new = make_commit(HEXSHA, {'default': fixture_outputs('new')})
  ref = make_commit(REF_HEXSHA, {'nightly': fixture_outputs('ref')}, id=2)
  data = call(compare_api, dummy_app, {HEXSHA: new}, 'project=p&batch=nightly', branch_commit=ref).get_json()
  assert data['status'] == 'missing'
  assert data['messages'] == ['No runs in the batch "nightly" of this commit.']


def test_milestone_reference(compare_api, dummy_app):
  milestones = [
    SimpleNamespace(id=12, label='v2.4.0', commit_hexsha=REF_HEXSHA, commit_project_id=None, batch='default', filter='', data={}),
    SimpleNamespace(id=11, label='v2.3.0', commit_hexsha='0000000', commit_project_id=None, batch='default', filter='', data={}),
    SimpleNamespace(id=10, label='', commit_hexsha=REF_HEXSHA, commit_project_id=None, batch='nightly', filter='indoor', data={'legacy_key': f'p/{REF_HEXSHA}/nightly'}),
  ]
  compare_api.milestones_of = lambda project_id, milestone_id=None: [m for m in milestones if milestone_id in (None, m.id)]
  new = make_commit(HEXSHA, {'default': fixture_outputs('new')})
  ref = make_commit(REF_HEXSHA, {'default': fixture_outputs('ref')}, id=2)
  data = call(compare_api, dummy_app, {HEXSHA: new, REF_HEXSHA: ref}, 'project=p&reference=v2.4.0').get_json()
  assert (data['reference']['type'], data['reference']['milestone'], data['reference']['id']) == ('milestone', 'v2.4.0', REF_HEXSHA)
  # from its link: /p/milestone/12-v2-4-0
  data = call(compare_api, dummy_app, {HEXSHA: new, REF_HEXSHA: ref}, 'project=p&reference=%2312').get_json()
  assert (data['reference']['type'], data['reference']['id']) == ('milestone', REF_HEXSHA)
  # keys from before October 2026 still work, and we compare with the milestone's batch
  ref_nightly = make_commit(REF_HEXSHA, {'nightly': fixture_outputs('ref')}, id=2)
  data = call(compare_api, dummy_app, {HEXSHA: new, REF_HEXSHA: ref_nightly}, f'project=p&reference=p/{REF_HEXSHA}/nightly').get_json()
  assert (data['reference']['type'], data['reference']['batch']) == ('milestone', 'nightly')
  assert any('filter of the milestone' in m for m in data['messages'])
  assert data['status'] != 'missing'
  data = call(compare_api, dummy_app, {HEXSHA: new, REF_HEXSHA: ref}, 'project=p&reference=v2.3.0').get_json()
  assert (data['status'], data['reference']['id']) == ('missing', None)
  assert data['messages'] == ['The commit of the milestone "v2.3.0" has no results.']


def test_default_reference(compare_api, dummy_app):
  new = make_commit(HEXSHA, {'default': fixture_outputs('new')}, data={'qatools_config': {'project': {'reference_branch': 'develop'}}})
  call(compare_api, dummy_app, {HEXSHA: new}, 'project=p')
  assert compare_api.find_branch_commit.call_args.args[1] == 'develop'
  new.data = {'qatools_config': {'project': {'reference_branch': 'develop'}, 'gate': {'reference': 'release'}}}
  call(compare_api, dummy_app, {HEXSHA: new}, 'project=p')
  assert compare_api.find_branch_commit.call_args.args[1] == 'release'


def test_errors(compare_api, dummy_app):
  assert call(compare_api, dummy_app, {}, 'reference=main').status_code == 400
  assert call(compare_api, dummy_app, {}, 'project=p').status_code == 404
  with dummy_app.test_request_context('/api/v1/commit/main/compare?project=p'):
    assert compare_api.compare_commit('main')[1] == 400
  compare_api.is_authorized_user.return_value = False
  assert call(compare_api, dummy_app, {}, 'project=p').status_code == 403


def test_bit_accuracy(compare_api, dummy_app, tmp_path, monkeypatch):
  monkeypatch.setattr(compare_api, 'is_storage_path', lambda path: True)
  outputs = {}
  for side in ('new', 'ref'):
    for o in fixture_outputs(side):
      output_dir = tmp_path / str(o['id'])
      output_dir.mkdir()
      # run 101's output differs from its reference's, 102 has no manifest
      if o['id'] != 102:
        (output_dir / 'manifest.outputs.json').write_text(json.dumps({'out.png': {'md5': 'changed' if o['id'] == 101 else 'same'}}))
      outputs[o['id']] = o
  new = make_commit(HEXSHA, {'default': fixture_outputs('new')})
  ref = make_commit(REF_HEXSHA, {'default': fixture_outputs('ref')}, id=2)
  for commit in (new, ref):
    for output in commit.batches[0].outputs:
      output.output_dir = tmp_path / str(output.id)
  data = call(compare_api, dummy_app, {HEXSHA: new}, 'project=p&bit_accuracy=true', branch_commit=ref).get_json()
  # 109 has no reference run
  assert data['bit_accuracy'] == {'checked': 5, 'mismatched': 1, 'unavailable': 1}
  tests = {t['id']: t for t in data['tests']}
  assert (tests[101]['bit_accurate'], tests[101]['bit_accuracy_mismatch']) == (False, ['out.png'])
  assert (tests[102]['bit_accurate'], tests[103]['bit_accurate'], tests[109]['bit_accurate']) == (None, True, None)
