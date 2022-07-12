from pathlib import Path

import unittest

class TestCompat(unittest.TestCase):
  def test_to_linux(self):
    from qaboard.compat import windows_to_linux
    self.assertEquals(windows_to_linux(r'\\netapp\algo_ws'), '/algo/ws')
    self.assertEquals(windows_to_linux(r'\\netapp\algo_ws\test'), '/algo/ws/test')
    self.assertEquals(windows_to_linux(r'\\netapp\algo_ws\test'+'\\'), '/algo/ws/test/')
    self.assertEquals(windows_to_linux(r"\\mars\raid\algo\test"), '/algo/test')
    self.assertEquals(windows_to_linux(r'//netapp/algo_ws'), '/algo/ws')
    # case insensitivity
    self.assertEquals(windows_to_linux(r'\\NETAPP\algo_ws\test'), '/algo/ws/test')
    self.assertEquals(windows_to_linux(r'\\NEtapp\algo_ws\TEST'), '/algo/ws/TEST')
    self.assertEquals(windows_to_linux(r'\\NEtapp\algo_ws\NEtapp'), '/algo/ws/NEtapp')

  def test_to_windows(self):
    # usual conversions
    from qaboard.compat import linux_to_windows
    self.assertEquals(linux_to_windows('/algo/ws'), r'\\netapp\algo_ws')
    self.assertEquals(linux_to_windows('/algo/ws/hello/there'), r'\\netapp\algo_ws\hello\there')
    self.assertEquals(linux_to_windows('/algo/ws/hello/there/'), '\\\\netapp\\algo_ws\\hello\\there\\')
    # odd paths...
    self.assertEquals(linux_to_windows('/algo/CIS/outputs/test'), r'\\netapp\vol23_algo\CIS\outputs\test')
    self.assertEquals(linux_to_windows('/algo/CIS/inputs/test'), r'\\netapp\vol24_algo\CIS_inputs\test')

  def test_to_path(self):
    from qaboard.compat import windows_to_linux_path, linux_to_windows_path
    self.assertEquals(windows_to_linux_path(Path(r'\\netapp\algo_ws')), Path('/algo/ws'))
    self.assertEquals(linux_to_windows_path(Path('/algo/ws')), Path(r'\\netapp\algo_ws'))


if __name__ == '__main__':
  unittest.main()
