"""
Unit tests of qa/junit.py, on the reports of pytest, GoogleTest, CTest and Maven Surefire:

    python -m unittest discover examples/software-quality/qa/tests
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import junit  # noqa: E402

SAMPLES = HERE / 'samples'


class GoogleTest(unittest.TestCase):
    def setUp(self):
        self.cases = junit.read(SAMPLES / 'gtest.xml')

    def test_counts(self):
        self.assertEqual(junit.counts(self.cases), {'tests': 6, 'passed': 3, 'failed': 1, 'error': 0, 'skipped': 2, 'flaky': 0})

    def test_ids_and_paths(self):
        self.assertEqual(self.cases[0]['id'], 'Crc16Test::KnownVectors')
        self.assertEqual(self.cases[2]['path'], ['Bits/VarintRoundTrip', 'Encodes/7'])

    def test_failure_message(self):
        self.assertEqual(self.cases[1]['message'], 'tests/crc_test.cc:24')
        self.assertIn('Which is: 10673', self.cases[1]['text'])

    def test_disabled_and_skipped(self):
        self.assertEqual([c['status'] for c in self.cases[4:]], ['skipped', 'skipped'])


class CTest(unittest.TestCase):
    def test_one_case_per_executable(self):
        cases = junit.read(SAMPLES / 'ctest.xml')
        self.assertEqual([(c['name'], c['status']) for c in cases],
                         [('codec_tests', 'passed'), ('planning_tests', 'failed'), ('gpu_tests', 'skipped')])
        self.assertAlmostEqual(cases[1]['time'], 0.43)


class Surefire(unittest.TestCase):
    def test_flaky(self):
        cases = junit.read(SAMPLES / 'surefire.xml')
        self.assertEqual([c['status'] for c in cases], ['passed', 'flaky'])
        self.assertEqual(cases[1]['path'], ['com', 'kitefin', 'fleet', 'ClientTest', 'deadline'])


class Pytest(unittest.TestCase):
    def test_tree(self):
        """pytest's own report on a small suite: the classname is the module's dotted path"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / 'test_demo.py').write_text(
                'import pytest\n'
                '@pytest.mark.parametrize("x", [1, 2])\ndef test_ok(x): pass\n'
                'def test_bad(): assert 1 == 2\n'
                '@pytest.mark.skip(reason="later")\ndef test_later(): pass\n'
                'class TestGroup:\n    def test_in_class(self): pass\n')
            subprocess.run([sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', f'--junitxml={tmp / "junit.xml"}',
                            '-o', 'junit_family=xunit1', 'test_demo.py'], cwd=tmp, capture_output=True)
            cases = junit.read(tmp / 'junit.xml')
        self.assertEqual(junit.counts(cases)['tests'], 5)
        tree = junit.tree(cases)
        module = tree['children'][0]
        self.assertEqual(module['name'], 'test_demo')
        self.assertEqual(module['counts'], {'tests': 5, 'passed': 3, 'failed': 1, 'error': 0, 'skipped': 1, 'flaky': 0})
        self.assertEqual([c['name'] for c in module['children']], ['TestGroup'])
        self.assertEqual(next(c for c in cases if c['name'] == 'test_later')['message'], 'later')


if __name__ == '__main__':
    unittest.main()
