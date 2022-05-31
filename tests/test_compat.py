from pathlib import Path

import unittest
from qaboard.compat import windows_to_linux, linux_to_windows
from qaboard.compat import windows_to_linux_path, linux_to_windows_path

class TestCompat(unittest.TestCase):
  def test_to_linux(self):
    self.assertEquals(windows_to_linux(r'\\netapp\algo_ws'), '/algo/ws')
    self.assertEquals(windows_to_linux(r'\\netapp\algo_ws\test'), '/algo/ws/test')
    self.assertEquals(windows_to_linux(r'\\netapp\algo_ws\test/'), '/algo/ws/test/')

  def test_to_windows(self):
    # usual conversions
    self.assertEquals(linux_to_windows('/algo/ws'), r'\\netapp\algo_ws')
    self.assertEquals(linux_to_windows('/algo/ws/hello/there'), r'\\netapp\algo_ws\hello\there')
    self.assertEquals(linux_to_windows('/algo/ws/hello/there/'), '\\\\netapp\\algo_ws\\hello\\there\\')
    # odd paths...
    self.assertEquals(linux_to_windows('/algo/CIS/outputs/test'), r'\\netapp\vol23_algo\CIS\outputs\test')
    self.assertEquals(linux_to_windows('/algo/CIS/inputs/test'), r'\\netapp\vol24_algo\CIS_inputs\test')

  def test_to_path(self):
    self.assertEquals(windows_to_linux_path(Path(r'\\netapp\algo_ws')), Path('/algo/ws'))
    self.assertEquals(linux_to_windows_path(Path('/algo/ws')), Path(r'\\netapp\algo_ws'))


if __name__ == '__main__':
  unittest.main()
