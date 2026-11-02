"""
Regression tests for cross-platform bit-accuracy hashing (RDI-2127).

`qaboard.utils.file_info` records:
- raw md5/st_size for `.hex` files on EVERY platform: their CRLF is part of the
  data format (SIRC hex files contain CRLF even when generated on Linux), and
  every stored reference manifest (committed TVs, CI outputs) has raw hashes.
  Normalizing hex made the Windows delivery legs fail against Linux references.
- EOL-normalized md5/st_size for true text files (.txt...) on Windows only,
  so they match the raw LF hashes the Linux references record.

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


class TestHexFilesAreAlwaysRaw(unittest.TestCase):
  """`.hex` is data, not text: its hash must never depend on the platform (RDI-2127)."""

  def test_crlf_hex_records_raw_hash(self):
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'noise.hex'
      path.write_bytes(CRLF_CONTENT)
      info = file_info(path)
      self.assertEqual(info['md5'], hashlib.md5(CRLF_CONTENT).hexdigest())
      self.assertEqual(info['st_size'], len(CRLF_CONTENT))

  def test_crlf_hex_identical_on_windows_and_linux(self):
    # A CRLF hex file must record the same md5/st_size on Windows and Linux,
    # and both must be the raw bytes' hash — this is what makes the Windows
    # delivery legs bit-accurate against the Linux-committed reference manifests.
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'noise.hex'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeWindowsOs()):
        windows_info = file_info(path)
      with mock.patch.object(qaboard_utils, 'os', FakeLinuxOs()):
        linux_info = file_info(path)
      self.assertEqual(windows_info, linux_info)
      self.assertEqual(windows_info['md5'], hashlib.md5(CRLF_CONTENT).hexdigest())

  def test_crlf_hex_matches_a_raw_linux_reference_manifest(self):
    # Simulates the delivery comparison: a reference manifest recorded on Linux
    # (raw md5 of the CRLF bytes) versus a fresh manifest computed on Windows.
    with tempfile.TemporaryDirectory() as tmp:
      reference = Path(tmp) / 'reference.hex'
      reference.write_bytes(CRLF_CONTENT)
      stored = {'md5': hashlib.md5(CRLF_CONTENT).hexdigest(), 'st_size': len(CRLF_CONTENT)}
      with mock.patch.object(qaboard_utils, 'os', FakeWindowsOs()):
        fresh = file_info(reference)
      self.assertEqual(fresh['md5'], stored['md5'])
      self.assertEqual(fresh['st_size'], stored['st_size'])


class TestTextFilesNormalizeOnWindowsOnly(unittest.TestCase):
  """True text files: Windows normalizes EOLs so its manifests match the raw
  LF hashes Linux records; Linux records raw bytes."""

  def test_crlf_txt_normalizes_on_windows(self):
    with tempfile.TemporaryDirectory() as tmp:
      crlf = Path(tmp) / 'regs.txt'
      lf = Path(tmp) / 'regs_lf.txt'
      crlf.write_bytes(CRLF_CONTENT)
      lf.write_bytes(LF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeWindowsOs()):
        windows_info = file_info(crlf)
      self.assertEqual(windows_info['md5'], hashlib.md5(LF_CONTENT).hexdigest())
      self.assertEqual(windows_info['st_size'], len(LF_CONTENT))

  def test_txt_records_raw_on_linux(self):
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'regs.txt'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeLinuxOs()):
        info = file_info(path)
      self.assertEqual(info['md5'], hashlib.md5(CRLF_CONTENT).hexdigest())
      self.assertEqual(info['st_size'], len(CRLF_CONTENT))

  def test_lf_txt_is_stable_across_platforms(self):
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'regs.txt'
      path.write_bytes(LF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeWindowsOs()):
        windows_info = file_info(path)
      with mock.patch.object(qaboard_utils, 'os', FakeLinuxOs()):
        linux_info = file_info(path)
      self.assertEqual(windows_info, linux_info)

  def test_non_plaintext_files_are_not_normalized(self):
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'noise.bin'
      path.write_bytes(CRLF_CONTENT)
      info = file_info(path)
      self.assertEqual(info['st_size'], len(CRLF_CONTENT))
      self.assertEqual(info['md5'], hashlib.md5(CRLF_CONTENT).hexdigest())

  def test_normalize_eof_false_keeps_raw(self):
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'regs.txt'
      path.write_bytes(CRLF_CONTENT)
      with mock.patch.object(qaboard_utils, 'os', FakeWindowsOs()):
        info = file_info(path, normalize_eof=False)
      self.assertEqual(info['md5'], hashlib.md5(CRLF_CONTENT).hexdigest())
      self.assertEqual(info['st_size'], len(CRLF_CONTENT))

  def test_hex_stays_raw_even_with_plaintext_opt_in_shape(self):
    # hex is not in default_plaintext anymore: without project config it must
    # be hashed raw even though it once was in the defaults.
    self.assertNotIn('.hex', qaboard_utils.default_plaintext)


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
