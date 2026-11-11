"""
Regression tests for cross-platform bit-accuracy hashing (RDI-2127).

`qaboard.utils.file_info` records:
- by default, the EOL-normalized md5/st_size of plaintext files on EVERY
  platform, so all manifests share one convention and strict comparison
  passes (the decided migration, PLAN_MIGRATE_CRLF).
- for HW_ALG (the project migrating first), the default is raw recording
  until it opts in with QA_RECORD_EOL_NORMALIZED=1 — the env var is purely
  HW_ALG's opt-in; other projects ignore it.

Note: we never patch the global `os.name` — Python 3.14's pathlib picks the
path flavour from it, which breaks tempfile paths. The "windows" simulations
below patch only `qaboard.utils.os`.
"""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import qaboard.utils as qaboard_utils
from qaboard.utils import file_info

CRLF_CONTENT = b'line one\r\nline two\r\nline three\r\n'
LF_CONTENT = CRLF_CONTENT.replace(b'\r\n', b'\n')


class FakeWindowsOs:
  """Stands in for qaboard.utils.os when simulating a Windows host.

  These shims only vary `os.name`, they do not simulate a real Windows host
  (paths, filesystem and line endings stay POSIX).
  """
  name = 'nt'

  def __getattr__(self, item):
    return getattr(os, item)


class FakeLinuxOs:
  name = 'posix'

  def __getattr__(self, item):
    return getattr(os, item)


def no_opt_in_env():
  """The test environment without the opt-in, whatever the caller's shell had set"""
  environ = {k: v for k, v in os.environ.items() if k != 'QA_RECORD_EOL_NORMALIZED'}
  return mock.patch.dict(os.environ, environ, clear=True)


class TestDefaultRecordingConvention(unittest.TestCase):
  """By default, every platform records the normalized form (RDI-2127's decided
  convention): the same unchanged CRLF-content plaintext file yields identical
  manifests on Linux and Windows, and strict comparison passes."""

  def test_crlf_txt_normalizes_on_linux(self):
    with no_opt_in_env(), tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'regs.txt'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeLinuxOs()):
        info = file_info(path)
      self.assertEqual(info['md5'], hashlib.md5(LF_CONTENT).hexdigest())
      self.assertEqual(info['st_size'], len(LF_CONTENT))

  def test_crlf_txt_normalizes_on_windows(self):
    with no_opt_in_env(), tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'regs.txt'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeWindowsOs()):
        info = file_info(path)
      self.assertEqual(info['md5'], hashlib.md5(LF_CONTENT).hexdigest())
      self.assertEqual(info['st_size'], len(LF_CONTENT))

  def test_crlf_hex_normalizes_on_linux(self):
    with no_opt_in_env(), tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'noise.hex'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeLinuxOs()):
        info = file_info(path)
      self.assertEqual(info['md5'], hashlib.md5(LF_CONTENT).hexdigest())
      self.assertEqual(info['st_size'], len(LF_CONTENT))

  def test_crlf_hex_normalizes_on_windows(self):
    with no_opt_in_env(), tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'noise.hex'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeWindowsOs()):
        info = file_info(path)
      self.assertEqual(info['md5'], hashlib.md5(LF_CONTENT).hexdigest())
      self.assertEqual(info['st_size'], len(LF_CONTENT))

  def test_identical_across_platforms(self):
    # the delivery scenario: both legs record the normalized form of the same
    # unchanged CRLF hex file, so their manifests match under strict comparison
    with no_opt_in_env(), tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'noise.hex'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeWindowsOs()):
        windows_info = file_info(path)
      with mock.patch.object(qaboard_utils, 'os', FakeLinuxOs()):
        linux_info = file_info(path)
      self.assertEqual(windows_info, linux_info)
      self.assertEqual(windows_info['md5'], hashlib.md5(LF_CONTENT).hexdigest())

  def test_matches_a_normalized_reference_manifest(self):
    # simulates the migrated delivery: the stored reference manifest holds the
    # normalized hashes, and a fresh recording on any platform matches it
    with no_opt_in_env(), tempfile.TemporaryDirectory() as tmp:
      reference = Path(tmp) / 'reference.hex'
      reference.write_bytes(CRLF_CONTENT)
      stored = {'md5': hashlib.md5(LF_CONTENT).hexdigest(), 'st_size': len(LF_CONTENT)}
      with mock.patch.object(qaboard_utils, 'os', FakeLinuxOs()):
        fresh = file_info(reference)
      self.assertEqual(fresh['md5'], stored['md5'])
      self.assertEqual(fresh['st_size'], stored['st_size'])

  def test_binaries_are_not_normalized(self):
    with no_opt_in_env(), tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'noise.bin'
      path.write_bytes(CRLF_CONTENT)
      info = file_info(path)
      self.assertEqual(info['st_size'], len(CRLF_CONTENT))
      self.assertEqual(info['md5'], hashlib.md5(CRLF_CONTENT).hexdigest())

  def test_normalize_eof_false_keeps_raw(self):
    with no_opt_in_env(), tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'regs.txt'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeWindowsOs()):
        info = file_info(path, normalize_eof=False)
      self.assertEqual(info['md5'], hashlib.md5(CRLF_CONTENT).hexdigest())
      self.assertEqual(info['st_size'], len(CRLF_CONTENT))

  def test_no_copy_without_hashes(self):
    # the server refreshes running outputs' manifests without hashes, often:
    # plaintext files must not be copied and hashed there
    with no_opt_in_env(), tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'regs.txt'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'eol_normalized_copy') as copy:
        info = file_info(path, compute_hashes=False)
      copy.assert_not_called()
      self.assertEqual(info, {'st_size': len(CRLF_CONTENT)})

  def test_project_config_classifying_hex_binary_stays_raw(self):
    # a project config (bit_accuracy.binary) re-classifies .hex as binary, and
    # the normalization must not override the project's explicit classification
    config = {'bit_accuracy': {'binary': ['.hex']}}
    with no_opt_in_env(), tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'noise.hex'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeLinuxOs()):
        linux_info = file_info(path, config=config)
      with mock.patch.object(qaboard_utils, 'os', FakeWindowsOs()):
        windows_info = file_info(path, config=config)
      self.assertEqual(linux_info['md5'], hashlib.md5(CRLF_CONTENT).hexdigest())
      self.assertEqual(windows_info, linux_info)

  def test_hex_is_plaintext_by_default(self):
    # revert of cac377a: excluding .hex from the defaults was defeated anyway by
    # project configs re-classifying it as plaintext (bit_accuracy.binary)
    self.assertIn('.hex', qaboard_utils.default_plaintext)


class TestHwAlgOptIn(unittest.TestCase):
  """HW_ALG (project names starting with CDE-Users/HW_ALG) is the exception: it
  records raw by default until it opts in with QA_RECORD_EOL_NORMALIZED=1. The
  env var is purely HW_ALG's opt-in — other projects ignore it."""

  HW_ALG_CONFIG = {'project': {'name': 'CDE-Users/HW_ALG'}}

  def test_hw_alg_records_raw_by_default(self):
    for fake_os in (FakeLinuxOs, FakeWindowsOs):
      with no_opt_in_env(), tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 'noise.hex'
        path.write_bytes(CRLF_CONTENT)
        with mock.patch.object(qaboard_utils, 'os', fake_os()):
          info = file_info(path, config=self.HW_ALG_CONFIG)
        self.assertEqual(info['md5'], hashlib.md5(CRLF_CONTENT).hexdigest(), fake_os.__name__)
        self.assertEqual(info['st_size'], len(CRLF_CONTENT), fake_os.__name__)

  def test_hw_alg_opts_in_with_the_env_var(self):
    with mock.patch.dict(os.environ, {'QA_RECORD_EOL_NORMALIZED': '1'}), tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'noise.hex'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeLinuxOs()):
        linux_info = file_info(path, config=self.HW_ALG_CONFIG)
      with mock.patch.object(qaboard_utils, 'os', FakeWindowsOs()):
        windows_info = file_info(path, config=self.HW_ALG_CONFIG)
      self.assertEqual(linux_info['md5'], hashlib.md5(LF_CONTENT).hexdigest())
      self.assertEqual(windows_info, linux_info)

  def test_hw_alg_opt_in_requires_exactly_1(self):
    # the flip to normalized must be an explicit opt-in, not a typo
    for value in ('0', 'true', 'yes', ''):
      with mock.patch.dict(os.environ, {'QA_RECORD_EOL_NORMALIZED': value}), tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / 'noise.hex'
        path.write_bytes(CRLF_CONTENT)
        with mock.patch.object(qaboard_utils, 'os', FakeLinuxOs()):
          info = file_info(path, config=self.HW_ALG_CONFIG)
        self.assertEqual(info['md5'], hashlib.md5(CRLF_CONTENT).hexdigest(), f'value={value!r} must not opt in')

  def test_other_projects_ignore_the_env_var(self):
    # normalization is always-on for everyone else: the var neither turns it
    # off nor needs to be set
    config = {'project': {'name': 'CDE-Users/Other'}}
    with mock.patch.dict(os.environ, {'QA_RECORD_EOL_NORMALIZED': '0'}), tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'noise.hex'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeLinuxOs()):
        info = file_info(path, config=config)
      self.assertEqual(info['md5'], hashlib.md5(LF_CONTENT).hexdigest())

  def test_normalize_eof_false_keeps_raw_even_for_hw_alg_opt_in(self):
    with mock.patch.dict(os.environ, {'QA_RECORD_EOL_NORMALIZED': '1'}), tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'regs.txt'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeLinuxOs()):
        info = file_info(path, config=self.HW_ALG_CONFIG, normalize_eof=False)
      self.assertEqual(info['md5'], hashlib.md5(CRLF_CONTENT).hexdigest())
      self.assertEqual(info['st_size'], len(CRLF_CONTENT))


class TestIgnore(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.dirs = []
    for name, content in (('new', 'new'), ('ref', 'ref')):
      directory = Path(tmp.name) / name
      # all the files differ between the two runs
      for path in ('out.txt', 'debug/out.txt', 'stages/debug', 'stages/out.txt'):
        (directory / path).parent.mkdir(parents=True, exist_ok=True)
        (directory / path).write_text(f'{content} {path}')
      manifest = {path: {'md5': f'{content}-{path}', 'st_size': 1} for path in ('out.txt', 'debug/out.txt', 'stages/debug', 'stages/out.txt')}
      (directory / 'manifest.outputs.json').write_text(json.dumps(manifest))
      self.dirs.append(directory)

  def test_ignore_matches_path_prefixes(self):
    """With or without manifests, files whose path starts with an ignore pattern are not checked"""
    from qaboard.bit_accuracy import cmpfiles, cmpmanifests
    new, ref = self.dirs
    ignore = ['debug', 'stages/out', 'manifest.outputs.json']
    expected = {Path('out.txt'), Path('stages/debug')}
    with_manifests = cmpmanifests(new / 'manifest.outputs.json', ref / 'manifest.outputs.json', ignore=ignore)
    without_manifests = cmpfiles(new, ref, ignore=ignore)
    self.assertEqual(with_manifests['mismatch'], expected)
    self.assertEqual(without_manifests['mismatch'], expected)

  def test_identical_files_match_without_manifests(self):
    from qaboard.bit_accuracy import cmpfiles
    new, ref = self.dirs
    (new / 'same.txt').write_text('same')
    (ref / 'same.txt').write_text('same')
    result = cmpfiles(new, ref, patterns=['same.txt'])
    self.assertEqual(result['match'], {Path('same.txt')})
    self.assertEqual(result['mismatch'], set())


if __name__ == '__main__':
  unittest.main()
