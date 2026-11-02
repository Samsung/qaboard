"""
What a run saves besides its metrics:
- tests.txt: one line per test, its status then its id, sorted: the text viewer diffs it with the reference's, so
  tests that started failing, were added, deleted or skipped show as changed lines. No times: they'd change every line.
- report.html: the tests as a tree (folders, files, classes), with counts and failures expanded.
- slowest.plotly.json: the slowest tests.
"""
import html as html_lib
import json

import junit

LABELS = {'passed': 'PASS', 'failed': 'FAIL', 'error': 'ERROR', 'skipped': 'SKIP', 'flaky': 'FLAKY'}
COLORS = {'passed': '#238551', 'failed': '#cd4246', 'error': '#cd4246', 'skipped': '#8f99a8', 'flaky': '#c87619'}


def tests_txt(path, cases):
    lines = [f"{LABELS[c['status']]:5}  {c['id']}" for c in sorted(cases, key=lambda c: c['id'])]
    path.write_text('\n'.join(lines) + '\n')


def _counts(counts):
    parts = [f"{counts['tests']} tests"]
    for status in ('failed', 'error', 'flaky', 'skipped'):
        if counts[status]:
            parts.append(f'<span style="color:{COLORS[status]}">{counts[status]} {status}</span>')
    return ', '.join(parts)


def _needs_a_look(counts):
    return counts['failed'] + counts['error'] + counts['flaky'] > 0


def _node(node, depth=0):
    """A folder, file or class: its children open when they have tests that didn't pass"""
    out = []
    for child in node['children']:
        out.append(f'<details{" open" if depth < 1 or _needs_a_look(child["counts"]) else ""}>'
                   f'<summary><b>{html_lib.escape(child["name"])}</b> &middot; {_counts(child["counts"])} '
                   f'&middot; {child["time"]:.2f} s</summary>'
                   f'<div style="margin-left:1.2em">{_node(child, depth + 1)}</div></details>')
    if node['cases']:
        def item(c):
            message = f'<pre>{html_lib.escape(c["text"] or c["message"])}</pre>' if c['status'] in ('failed', 'error') else (
                f' <i>{html_lib.escape(c["message"])}</i>' if c['message'] else '')
            return (f'<li><span style="color:{COLORS[c["status"]]};font-weight:bold">{LABELS[c["status"]]}</span> '
                    f'{html_lib.escape(c["name"])} <span style="color:#8f99a8">{c["time"] * 1000:.1f} ms</span>{message}</li>')
        # the tests that need a look first, the passing ones folded
        others = [c for c in node['cases'] if c['status'] != 'passed']
        passed = [c for c in node['cases'] if c['status'] == 'passed']
        ul = '<ul style="list-style:none;padding-left:1em;margin:2px 0">'
        if others:
            out.append(ul + ''.join(item(c) for c in others) + '</ul>')
        if passed:
            out.append(f'<details><summary>{len(passed)} passed</summary>{ul}{"".join(item(c) for c in passed)}</ul></details>')
    return ''.join(out)


def html(path, name, cases, metrics):
    root = junit.tree(cases)
    m = metrics
    summary = (f"<p><b>{m['tests']}</b> tests: {m['passed']} passed, {m['failed']} failed, {m['errors']} errors, "
               f"{m['skipped']} skipped, {m['flaky']} flaky (failed, then passed when run again alone). "
               f"Pass rate {m['pass_rate']:.1%}.")
    if 'coverage' in m:
        summary += (f" Coverage: {m['coverage']:.1%} of {m['lines']} lines ({m['lines_missed']} missed), "
                    f"{m['branch_coverage']:.1%} of branches.")
    summary += '</p>'
    path.write_text(
        '<!doctype html><html><head><meta charset="utf-8"><style>'
        'body{font:14px/1.45 system-ui,sans-serif;margin:12px}pre{background:#f6f7f9;padding:8px;overflow:auto;'
        'max-height:240px;font-size:12px}summary{cursor:pointer;padding:2px 0}'
        '@media (prefers-color-scheme: dark){body{background:#1c2127;color:#f6f7f9}pre{background:#2f343c}}'
        f'</style></head><body><h3>{html_lib.escape(name)}</h3>{summary}{_node(root)}</body></html>'
    )


def slowest(path, cases, title, n=15):
    top = sorted(cases, key=lambda c: c['time'], reverse=True)[:n][::-1]
    figure = {
        'data': [{
            'type': 'bar', 'orientation': 'h',
            'x': [round(c['time'] * 1000, 2) for c in top],
            'y': [c['id'].split('::', 1)[-1] for c in top],
            'marker': {'color': [COLORS[c['status']] for c in top]},
            'hovertext': [c['id'] for c in top],
        }],
        'layout': {'title': {'text': title}, 'xaxis': {'title': {'text': 'ms'}}, 'margin': {'l': 280},
                   'height': 120 + 22 * len(top)},
    }
    path.write_text(json.dumps(figure))
