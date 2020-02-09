"""
Tests the functions used in CIS data imports.
"""
import unittest
from pathlib import Path

from slamvizapp.scripts.cis.utils import *
from slamvizapp.config import cis_ci_directory


class TestInitDatabase(unittest.TestCase):
  """Tests the functions used in the CIS CI data import."""

  def test_parse_ci_dir(self):
    tests_paths = [
      'xx/2015_09_09_test_message',
      'xx/2015_09_09__test_message',
      'xx/2015_09_09_10_15_test_message',
      'xx/2015_09_09_10_15__test_message',
      'xx/2015_09_09_10_15_00_test_message',
      'xx/2015_09_09_10_15_00__test_message',
    ] 
    for path_s in tests_paths:
      path = Path(path_s)
      ci_dir = parse_ci_dir(path)
      assert ci_dir
      assert ci_dir['authored_datetime'].strftime('%D') == '09/09/15'
      assert ci_dir['version'] == 'test_message'

      
  def test_ci_dirs(self):
    ci_dirs_2 = list(ci_dirs(cis_ci_directory/'Elad', max_depth=2))
    assert ci_dirs_2
    ci_dirs_3 = list(ci_dirs(cis_ci_directory/'Elad', max_depth=3))
    assert ci_dirs_3
    assert len(ci_dirs_3)>=len(ci_dirs_2)

    
  def test_parse_project_path(self):
    project_paths = [
      ('Misha/CleanSlate', 'Misha', 'CleanSlate'),
      ('Ron/PSPv2ContinuousIntegration', 'Ron', 'PSPv2'),
      ('Elad/ContinuousIntegration/2X5', 'Elad', '2X5'),
      ('Ron/RCCC/TEST_CI', 'Ron', 'RCCC/TEST'),
    ]
    for p, author, project in project_paths:
      author_, project_ = parse_project_path(p)
      # print(author_, project_)
      assert project_ == project
      assert author_ == author

if __name__ == '__main__':
  unittest.main()