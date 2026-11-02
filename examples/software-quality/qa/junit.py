"""
Reads JUnit XML test reports, the format most test runners write:

    pytest --junitxml=junit.xml               ctest --output-junit junit.xml
    ./tests --gtest_output=xml:junit.xml       cargo nextest (junit in .config/nextest.toml)
    go test -json | go-junit-report            jest --reporters=jest-junit, Gradle, Maven Surefire...

Each <testcase> becomes a dict: its id, its path in the hierarchy (the test's classname split on dots, then its name),
its status (passed, failed, error, skipped, flaky), its time in seconds and, when it didn't pass, the message.
Standard library only, so that you can copy this file into your project.
"""
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

STATUSES = ('passed', 'failed', 'error', 'skipped', 'flaky')


def _float(value, default=0.0):
    try:
        return float(str(value).replace(',', ''))
    except (TypeError, ValueError):
        return default


def _case(element, suite_name):
    classname = element.get('classname') or suite_name or ''
    name = element.get('name') or ''
    status, message, text = 'passed', '', ''
    for tag in ('failure', 'error'):
        child = element.find(tag)
        if child is not None:
            status = 'failed' if tag == 'failure' else 'error'
            message = child.get('message') or ''
            text = (child.text or '').strip()
            break
    else:
        skipped = element.find('skipped')
        # gtest: DISABLED_ tests are status="notrun", GTEST_SKIP() result="skipped"
        if skipped is not None or element.get('status') == 'notrun' or element.get('result') == 'skipped':
            status = 'skipped'
            message = (skipped.get('message') if skipped is not None else '') or ''
        # Maven Surefire and Gradle: failed, then passed when rerun
        elif element.find('flakyFailure') is not None or element.find('flakyError') is not None:
            status = 'flaky'
            child = element.find('flakyFailure') if element.find('flakyFailure') is not None else element.find('flakyError')
            message = child.get('message') or ''
    path = [part for part in classname.split('.') if part] + [name]
    return {
        'id': f"{classname}::{name}" if classname else name,
        'path': path,
        'suite': suite_name or '',
        'classname': classname,
        'name': name,
        'status': status,
        'time': _float(element.get('time')),
        'message': message.strip().splitlines()[0][:300] if message.strip() else (text.splitlines()[-1][:300] if text else ''),
        'text': text[:5000],
    }


def read(path) -> list:
    """The test cases of a JUnit XML file, in the file's order"""
    root = ET.parse(str(path)).getroot()
    cases = []

    def walk(element, suite_name):
        for child in element:
            if child.tag == 'testsuite':
                walk(child, child.get('name') or suite_name)
            elif child.tag == 'testcase':
                cases.append(_case(child, suite_name))

    if root.tag == 'testcase':
        cases.append(_case(root, ''))
    else:
        walk(root, root.get('name') if root.tag == 'testsuite' else '')
    return cases


def counts(cases) -> dict:
    """How many tests have each status, and `tests`: how many there are"""
    by_status = Counter(c['status'] for c in cases)
    return {'tests': len(cases), **{s: by_status.get(s, 0) for s in STATUSES}}


def tree(cases) -> dict:
    """The cases as a tree: {'name', 'children': [...], 'cases': [...], 'counts': {...}, 'time'}, folders first"""
    root = {'name': '', 'children': {}, 'cases': []}
    for case in cases:
        node = root
        for part in case['path'][:-1]:
            node = node['children'].setdefault(part, {'name': part, 'children': {}, 'cases': []})
        node['cases'].append(case)

    def finish(node):
        children = [finish(c) for c in node['children'].values()]
        all_cases = node['cases'] + [c for child in children for c in child['all_cases']]
        return {**node, 'children': children, 'all_cases': all_cases, 'counts': counts(all_cases),
                'time': sum(c['time'] for c in all_cases)}
    return finish(root)


if __name__ == '__main__':
    # A quick look: python qa/junit.py junit.xml
    import sys
    for arg in sys.argv[1:]:
        cases = read(Path(arg))
        print(arg, counts(cases))
        for case in cases:
            if case['status'] != 'passed':
                print(f"  {case['status'].upper():7} {case['id']}: {case['message']}")
