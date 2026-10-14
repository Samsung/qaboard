#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest>=8", "pyyaml>=6", "requests>=2.31", "jsonschema>=4.21", "psutil>=5.9"]
# ///
"""
Unit tests for docs-media/seed.py's story logic: uv run docs-media/tests/test_seed.py
The fixture story (tests/fixture/story.yaml) tests the rest against a real stack.
"""
import sys
import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import seed  # noqa: E402

UTC = datetime.timezone.utc
T0 = datetime.datetime(2026, 10, 8, 16, tzinfo=UTC)


def test_default_t0_is_the_last_thursday_at_16():
  assert seed.default_t0(datetime.datetime(2026, 10, 12, 9, tzinfo=UTC)) == T0
  assert seed.default_t0(datetime.datetime(2026, 10, 8, 16, 30, tzinfo=UTC)) == T0
  assert seed.default_t0(datetime.datetime(2026, 10, 8, 15, 59, tzinfo=UTC)) == T0 - datetime.timedelta(days=7)


def test_offsets():
  assert seed.parse_offset('-12d 14:05', T0) == datetime.datetime(2026, 9, 26, 14, 5, tzinfo=UTC)
  assert seed.parse_offset('-0d 13:20', T0) == T0 - datetime.timedelta(hours=2, minutes=40)
  assert seed.parse_offset('-90m', T0) == T0 - datetime.timedelta(minutes=90)
  assert seed.parse_offset('-2h30m', T0) == T0 - datetime.timedelta(hours=2, minutes=30)
  assert seed.parse_duration('2h25m') == datetime.timedelta(hours=2, minutes=25)


def test_merge_patch_removes_nulls():
  assert seed.merge_patch({'a': 1, 'b': {'c': 1, 'd': 2}}, {'a': None, 'b': {'c': None, 'e': 3}}) == {'b': {'d': 2, 'e': 3}}


def test_merge_takes_what_the_merged_branch_changed():
  base = {'demosaic': 'bilinear', 'denoise': 'gaussian'}
  ours = {'demosaic': 'hamilton-adams', 'denoise': 'gaussian'}
  theirs = {'demosaic': 'bilinear', 'denoise': 'bilateral', 'boost': 1.5}
  assert seed.merge_heads(base, ours, theirs, {}, 'test') == {'demosaic': 'hamilton-adams', 'denoise': 'bilateral', 'boost': 1.5}
  # a key the merged branch removed
  assert seed.merge_heads({'bug': True}, {'bug': True}, {}, {}, 'test') == {}


def test_merge_conflicts():
  with pytest.raises(SystemExit):
    seed.merge_heads({'a': 1}, {'a': 2}, {'a': 3}, {}, 'test')
  assert seed.merge_heads({'a': 1}, {'a': 2}, {'a': 3}, {'a': 4}, 'test') == {'a': 4}


def test_avatar_colors_match_the_web_app():
  # computed with avatarColor() of webapp/src/components/avatars.tsx
  expected = {'Ines Marchetti': 11, 'Tobias Wendt': 11, 'Tobias M. Wendt': 2, 'Kitefin Coding Agent': 2,
              'Kaito Nishimaki': 6, 'Adaeze Nwankwo': 8, 'Mira Kowalczyk': 1, 'Zoë Ångström': 3}
  assert {name: seed.avatar_color(name) for name in expected} == expected


def test_inputs_globs_match_like_gitignore():
  assert seed.glob_matches('bursty-*', 'profiles/bursty-high.yaml')
  assert not seed.glob_matches('profiles/steady-*', 'profiles/bursty-high.yaml')
  assert seed.glob_matches('charts/*', 'charts/siemens-star.png')
  assert seed.glob_matches(None, 'anything')


def test_the_fixture_story():
  story = seed.Story(Path(__file__).parent / 'fixture' / 'story.yaml', T0)
  merge = story.commits['merge-median']
  assert merge.parents == ['stronger-gain', 'median-fix']
  assert merge.flags == {'gain': 1.5, 'denoise': 'median'}
  assert merge.files['qa/metrics.yaml']['available_metrics']['noise']['target'] == 2
  assert story.commits['median-fix'].flags == {'gain': 1.5, 'denoise': 'median'}
  assert story.sha_of('base') == story.commits['base'].sha == '9f6957327c6cda5947715a6571d2cc8addcff1e0'
  local = story.commits['median-fix'].runs[1]
  assert (local.via, local.user, local.db_label) == ('local', 'ines', '@ines| ines-probe')


def test_failures_can_select_configurations():
  story = seed.Story(seed.EXAMPLES / 'detection-eval' / 'story.yaml', T0)
  commit = story.commits['qdq-se-gates']
  ci = commit.runs[0]
  # Seeder.expected_failure doesn't use the seeder's state
  assert seed.Seeder.expected_failure(None, commit, ci, 'slices/indoor', ['int8', 'size-320'])
  assert not seed.Seeder.expected_failure(None, commit, ci, 'slices/indoor', ['fp32', 'size-320'])


def test_runs_files_replace_the_batch_name_only():
  # the label can be the batch's name: only the name after `batch` goes
  assert seed.without_batch_name(['--label', 'nightly', 'batch', 'nightly'], [], 'nightly') == ['--label', 'nightly', 'batch']
  assert seed.without_batch_name(['batch', 'ci', '--tuning-search', '{}'], ['--tuning-search', '{}'], 'ci') == ['batch', '--tuning-search', '{}']
  with pytest.raises(seed.SeedError):
    seed.without_batch_name(['optimize', '--batch', 'ci'], [], 'ci')



def test_failed_gate_checks_are_named():
  # a metric's rule, with its message; the rules without a metric by their kind
  assert seed.failed_gate_check({'kind': 'max_regression_pct', 'metric': 'psnr', 'status': 'fail', 'message': '-3% (limit 1%)'}) == 'psnr: -3% (limit 1%)'
  assert seed.failed_gate_check({'kind': 'max_failed_runs', 'metric': None, 'limit': 0, 'new': 2, 'status': 'fail', 'message': ''}) == 'max_failed_runs: 2 (limit 0)'
  assert seed.failed_gate_check({'kind': 'require_bit_accuracy', 'metric': None, 'limit': None, 'status': 'fail', 'message': ''}) == 'require_bit_accuracy: fail'


if __name__ == '__main__':
  sys.exit(pytest.main([__file__, '-q']))
