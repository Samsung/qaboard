import json
import os
from pathlib import Path
from unittest import mock

import unittest


# The SIRC mappings, same as in deployments/cli/sirc/qaboard_site_sirc/__init__.py
SIRC_MAPPINGS = json.dumps([
    ["\\\\netapp\\algo_data", "/stage/algo_data"],
    ["\\\\netapp2\\algo_data", "/stage/algo_data"],
    ["\\\\netapp\\algo-datasets", "/stage/algo-datasets"],
    ["\\\\f2\\algo_archive", "/stage/algo_archive"],
    ["\\\\mars\\stage\\jenkins_ws", "/stage/jenkins_ws"],
    ["\\\\mars\\stage\\algo_jenkins_ws", "/stage/algo_jenkins_ws"],
    ["\\\\mars\\raid\\data\\DATASYNC", "/raid/data/DATASYNC"],
    ["\\\\netapp\\algo_ws", "/algo/ws"],
    ["\\\\netapp\\vol23_algo", "/algo"],
    ["\\\\netapp\\vol24_algo", "/algo"],
    ["\\\\mars\\algo", "/algo"],
    ["\\\\mars\\raid\\algo", "/algo"],
    ["\\\\mars\\raid", "/raid"],
    ["\\\\mars\\stage\\algo_db", "/stage/algo_db"],
    ["\\\\netapp\\raid\\users", "/home"],
    ["\\\\netapp\\QA-Data", "/stage/qa_data"],
    ["\\\\f2\\algo-datasets", "/stage/algo-datasets"],
    ["\\\\mars\\data", "/data"],
    ["\\\\netapp\\Joint", "/net/netapp/vol/home_nt/Joint"],
    ["\\\\mars\\sim", "/sim"],
    ["\\\\mars\\stage", "/stage"],
    ["\\\\netapp\\vol19_data", "/net/netapp/vol/vol19_data"],
])


def _reload_compat():
    """Reload compat module so it re-reads the env var for mappings."""
    import importlib
    import qaboard.compat
    importlib.reload(qaboard.compat)
    return qaboard.compat


class TestCompatWithSircMappings(unittest.TestCase):
    """Tests with SIRC path mappings injected via env var."""

    @classmethod
    def setUpClass(cls):
        os.environ['QABOARD_PATH_MAPPINGS'] = SIRC_MAPPINGS
        cls.compat = _reload_compat()

    @classmethod
    def tearDownClass(cls):
        del os.environ['QABOARD_PATH_MAPPINGS']
        _reload_compat()

    def test_to_linux(self):
        w2l = self.compat.windows_to_linux
        self.assertEqual(w2l(r'\\netapp\algo_ws'), '/algo/ws')
        self.assertEqual(w2l(r'\\netapp\algo_ws\test'), '/algo/ws/test')
        self.assertEqual(w2l(r'\\netapp\algo_ws\test' + '\\'), '/algo/ws/test/')
        self.assertEqual(w2l(r"\\mars\raid\algo\test"), '/algo/test')
        self.assertEqual(w2l(r'//netapp/algo_ws'), '/algo/ws')
        # case insensitivity
        self.assertEqual(w2l(r'\\NETAPP\algo_ws\test'), '/algo/ws/test')
        self.assertEqual(w2l(r'\\NEtapp\algo_ws\TEST'), '/algo/ws/TEST')
        self.assertEqual(w2l(r'\\NEtapp\algo_ws\NEtapp'), '/algo/ws/NEtapp')

    def test_to_windows(self):
        l2w = self.compat.linux_to_windows
        self.assertEqual(l2w('/algo/ws'), r'\\netapp\algo_ws')
        self.assertEqual(l2w('/algo/ws/hello/there'), r'\\netapp\algo_ws\hello\there')
        self.assertEqual(l2w('/algo/ws/hello/there/'), '\\\\netapp\\algo_ws\\hello\\there\\')
        # odd paths...
        self.assertEqual(l2w('/algo/CIS/outputs/test'), r'\\netapp\vol23_algo\CIS\outputs\test')
        self.assertEqual(l2w('/algo/CIS/inputs/test'), r'\\netapp\vol24_algo\CIS_inputs\test')

    def test_to_path(self):
        w2l_path = self.compat.windows_to_linux_path
        l2w_path = self.compat.linux_to_windows_path
        self.assertEqual(w2l_path(Path(r'\\netapp\algo_ws')), Path('/algo/ws'))
        self.assertEqual(l2w_path(Path('/algo/ws')), Path(r'\\netapp\algo_ws'))


class TestCompatNoMappings(unittest.TestCase):
    """Tests with no path mappings configured (open-source default)."""

    @classmethod
    def setUpClass(cls):
        # Ensure no mappings env var is set
        os.environ.pop('QABOARD_PATH_MAPPINGS', None)
        cls.compat = _reload_compat()

    @classmethod
    def tearDownClass(cls):
        _reload_compat()

    def test_windows_to_linux_passthrough(self):
        """With no mappings, windows_to_linux only converts separators."""
        w2l = self.compat.windows_to_linux
        self.assertEqual(w2l(r'\\netapp\algo_ws'), '//netapp/algo_ws')
        self.assertEqual(w2l(r'\\server\share\file.txt'), '//server/share/file.txt')

    def test_linux_to_windows_passthrough(self):
        """With no mappings, linux_to_windows only converts separators."""
        l2w = self.compat.linux_to_windows
        self.assertEqual(l2w('/some/path/file.txt'), r'\some\path\file.txt')

    def test_fix_linux_permissions_noop(self):
        """With no hook installed, fix_linux_permissions is a no-op."""
        # Should not raise, just print a message
        self.compat.fix_linux_permissions(Path('/tmp/test'))


if __name__ == '__main__':
    unittest.main()
