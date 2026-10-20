"""
QA-Board runs this file: `qa run --input codec` calls run(context).

A run is one test suite (tests/<suite>/, described by its suite.yaml) in one mode: `default`, or `strict`, where
warnings are errors. It runs the suite with pytest under coverage.py, reads the JUnit XML report, runs the tests that
failed again, alone, to tell flaky tests from failing ones, and returns the counts and the coverage of the package the
suite tests (qa/metrics.yaml). It saves the report, the list of tests with their status (diffed between commits), the
lines that no test runs, and the slowest tests.
- the SDK's and the tests' flags come from build/flags.json (what a commit changed), see fleet_sdk/_flags.py.
- to wrap another test runner, keep qa/junit.py and replace pytest_command() and rerun(): see SPEC.md.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import junit  # noqa: E402
import report  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MODES = {
    'default': [],
    'strict': ['-W', 'error::DeprecationWarning'],   # like a debug build with -Werror: deprecations fail the tests
}
MAX_RERUNS = 50   # more failures than that are not flakes


def mode_of(configs) -> str:
    modes = [c for c in configs or [] if isinstance(c, str) and c in MODES]
    return modes[0] if modes else 'default'


def pytest_command(suite_dir: Path, covers: str, output_dir: Path, mode: str) -> list:
    return [
        sys.executable, '-m', 'coverage', 'run', '--branch', f'--source={covers}', f'--data-file={output_dir / ".coverage"}',
        '-m', 'pytest', str(suite_dir.relative_to(ROOT)), f'--junitxml={output_dir / "junit.xml"}',
        '-o', 'junit_family=xunit1', '-q', '-rfE', *MODES[mode],
    ]


def node_id(case) -> str:
    """pytest's id of a JUnit test case: its classname is the file's dotted path, then the class, if any"""
    parts = case['classname'].split('.')
    for end in range(len(parts), 0, -1):
        path = Path(*parts[:end]).with_suffix('.py')
        if (ROOT / path).exists():
            return '::'.join([path.as_posix(), *parts[end:], case['name']])
    return case['id']


def rerun(failed, output_dir: Path, mode: str) -> set:
    """The ids of the failed tests that pass when run again, alone (without the tests that ran before them)"""
    if not failed or len(failed) > MAX_RERUNS:
        return set()
    xml = output_dir / 'rerun.junit.xml'
    command = [sys.executable, '-m', 'pytest', *failed, f'--junitxml={xml}', '-o', 'junit_family=xunit1', '-q', *MODES[mode]]
    print(f"\nRunning the {len(failed)} failed tests again, alone:")
    run_and_print(command)
    if not xml.exists():
        return set()
    return {node_id(c) for c in junit.read(xml) if c['status'] == 'passed'}


def env() -> dict:
    return {**os.environ, 'PYTHONPATH': str(ROOT), 'PYTHONDONTWRITEBYTECODE': '1'}


def run_and_print(command) -> int:
    """Runs a command, printing its output line by line: `qa` saves what we print in the run's log, not what a
    subprocess writes on its own"""
    process = subprocess.Popen(command, cwd=ROOT, env=env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in process.stdout:
        print(line, end='', flush=True)
    return process.wait()


def coverage(output_dir: Path) -> dict:
    data = output_dir / '.coverage'
    if not data.exists():
        return {}

    def run(*args):
        return subprocess.run([sys.executable, '-m', 'coverage', *args, f'--data-file={data}'],
                              cwd=ROOT, env=env(), capture_output=True, text=True)
    run('json', '-o', str(output_dir / 'coverage.json'), '--quiet')
    (output_dir / 'coverage.txt').write_text(run('report', '-m', '--skip-empty').stdout)
    totals = json.loads((output_dir / 'coverage.json').read_text())['totals']
    return {
        'lines': totals['num_statements'],
        'lines_missed': totals['missing_lines'],
        'coverage': totals['covered_lines'] / totals['num_statements'] if totals['num_statements'] else 1.0,
        'branch_coverage': totals['covered_branches'] / totals['num_branches'] if totals['num_branches'] else 1.0,
    }


def evaluate(suite_dir: Path, mode: str, output_dir: Path) -> dict:
    suite = yaml.safe_load((suite_dir / 'suite.yaml').read_text())
    output_dir.mkdir(parents=True, exist_ok=True)
    command = pytest_command(suite_dir, suite['covers'], output_dir, mode)
    print(f"{suite.get('label', suite_dir.name)} ({mode}): {' '.join(command[1:])}\n", flush=True)
    code = run_and_print(command)
    xml = output_dir / 'junit.xml'
    # 0: passed, 1: some tests failed, 5: no tests. Others: pytest itself failed (2 with collection errors, which the
    # report lists as errors)
    if not xml.exists() or code in (3, 4):
        return {'suite': suite, 'cases': [], 'metrics': {'is_failed': True}}
    cases = junit.read(xml)
    for case in cases:
        case['id'] = node_id(case)
    flaky = rerun([c['id'] for c in cases if c['status'] in ('failed', 'error')], output_dir, mode)
    for case in cases:
        if case['id'] in flaky:
            case['status'] = 'flaky'
    counts = junit.counts(cases)
    run_tests = counts['tests'] - counts['skipped']
    times = [c['time'] for c in cases]
    metrics = {
        'tests': counts['tests'],
        'passed': counts['passed'],
        'failed': counts['failed'],
        'errors': counts['error'],
        'skipped': counts['skipped'],
        'flaky': counts['flaky'],
        'pass_rate': (counts['passed'] + counts['flaky']) / run_tests if run_tests else 1.0,
        'test_time': sum(times),
        'slowest_test': max(times, default=0),
        **coverage(output_dir),
        'is_failed': code == 2 and not cases,
    }
    return {'suite': suite, 'cases': cases, 'metrics': metrics}


def run(context):
    mode = mode_of(context.configs)
    output_dir = Path(context.output_dir)
    result = evaluate(Path(context.input_path), mode, output_dir)
    if result['cases']:
        name = f"{result['suite'].get('label', context.rel_input_path)} ({mode})"
        report.tests_txt(output_dir / 'tests.txt', result['cases'])
        report.html(output_dir / 'report.html', name, result['cases'], result['metrics'])
        report.slowest(output_dir / 'slowest.plotly.json', result['cases'], f'{name}: slowest tests')
    m = result['metrics']
    if not m.get('is_failed'):
        print(f"\n{m['tests']} tests: {m['passed']} passed, {m['failed']} failed, {m['errors']} errors, "
              f"{m['skipped']} skipped, {m['flaky']} flaky; coverage {m.get('coverage', 0):.1%} "
              f"({m.get('lines_missed', 0)} lines missed)")
    return m


if __name__ == '__main__':
    # A quick look without QA-Board: python qa/main.py codec [strict]
    suite_dir = ROOT / 'tests' / sys.argv[1]
    result = evaluate(suite_dir, sys.argv[2] if len(sys.argv) > 2 else 'default', ROOT / 'output' / 'quick-look' / sys.argv[1])
    print(json.dumps(result['metrics'], indent=1))
