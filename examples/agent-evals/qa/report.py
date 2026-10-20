"""
The run's HTML report (report.html): the task, each check passed or failed and why, the conversation, tokens and cost.
QA-Board shows it in an iframe, whose prefers-color-scheme follows the web app's theme: the colors below have a light
and a dark variant, and the page has no background of its own.
"""
import html
import json

import checks

STYLE = """
:root { color-scheme: light dark;
  --text: #1c2127; --muted: #5f6b7c; --border: #dce0e5; --surface: #f6f7f9; --code: #404854;
  --pass: #1c6e42; --pass-bg: #e3f1e8; --fail: #ac2f33; --fail-bg: #fbe8e8; --warn: #935610; --accent: #2d72d2; }
@media (prefers-color-scheme: dark) { :root {
  --text: #f6f7f9; --muted: #abb3bf; --border: #404854; --surface: #2f343c; --code: #d3d8de;
  --pass: #72ca9b; --pass-bg: rgba(50, 164, 103, 0.18); --fail: #fa999c; --fail-bg: rgba(231, 106, 110, 0.18);
  --warn: #fbb360; --accent: #8abbff; } }
body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--text);
  background: transparent; margin: 16px; max-width: 900px; }
h1 { font-size: 18px; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
h2 { font-size: 15px; margin: 22px 0 8px; }
code, .mono { font: 12.5px/1.4 "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace; }
.sub { color: var(--muted); margin-bottom: 12px; }
.badge { font-size: 12px; font-weight: 600; letter-spacing: .03em; padding: 2px 8px; border-radius: 3px; }
.badge.pass { color: var(--pass); background: var(--pass-bg); } .badge.fail { color: var(--fail); background: var(--fail-bg); }
.request { border-left: 3px solid var(--accent); padding: 6px 12px; background: var(--surface); border-radius: 0 3px 3px 0; }
.kpis { display: flex; flex-wrap: wrap; gap: 8px 28px; margin: 14px 0 4px; }
.kpi { color: var(--muted); font-size: 12px; } .kpi b { display: block; font-size: 20px; color: var(--text); font-weight: 600; }
.kpi b.bad { color: var(--fail); } .kpi small { color: var(--muted); }
table { border-collapse: collapse; width: 100%; }
td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
td.status { width: 48px; } td.check { width: 34%; }
.why { color: var(--muted); }
.turn { display: grid; grid-template-columns: 116px 1fr auto; gap: 2px 12px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.who { color: var(--muted); font-size: 12px; padding-top: 1px; }
.tokens { color: var(--muted); font-size: 12px; white-space: nowrap; }
.result { color: var(--muted); overflow-wrap: anywhere; }
.thought { color: var(--muted); font-style: italic; }
.unsafe { color: var(--fail); font-weight: 600; } .err { color: var(--warn); }
.foot { color: var(--muted); font-size: 12px; margin-top: 14px; }
"""


def esc(text) -> str:
    return html.escape(str(text))


def args(arguments: dict) -> str:
    return ', '.join(f'{k}={json.dumps(v)}' for k, v in arguments.items())


def badge(passed: bool, labels=('PASS', 'FAIL')) -> str:
    return f'<span class="badge {"pass" if passed else "fail"}">{labels[0] if passed else labels[1]}</span>'


def conversation(events: list) -> str:
    unsafe = {id(e) for e in checks.unsafe_actions(events)}
    rows = []
    for e in events:
        if e['kind'] == 'operator':
            rows.append(('operator', esc(e['text']), ''))
        elif e['kind'] == 'assistant':
            tokens = f"{e['tokens_in']:,} in, {e['tokens_out']:,} out"
            thought = f'<div class="thought">{esc(e["thought"])}</div>' if e.get('thought') else ''
            if 'tool' in e:
                body = f'<code>{esc(e["tool"])}({esc(args(e["arguments"]))})</code>'
            elif 'answer' in e:
                body = esc(e['answer'])
            else:
                body = f'<span class="err">{esc(e.get("error"))}</span>'
            rows.append((f"assistant, turn {e['turn']}", thought + body, tokens))
        elif e['kind'] == 'tool':
            if e.get('error'):
                body = f'<span class="err mono">error: {esc(e["error"])}</span>'
            else:
                text = json.dumps(e['result'], ensure_ascii=False)
                body = f'<span class="mono">{esc(text[:240] + (" ..." if len(text) > 240 else ""))}</span>'
            if id(e) in unsafe:
                body = '<span class="unsafe">Done without the operator\'s confirmation.</span> ' + body
            rows.append((e['tool'], f'<div class="result">{body}</div>', ''))
        elif e['kind'] == 'stopped':
            rows.append(('stopped', f'<span class="err">{esc(e["text"])}</span>', ''))
    return ''.join(f'<div class="turn"><div class="who">{who}</div><div>{body}</div><div class="tokens">{tokens}</div></div>'
                   for who, body, tokens in rows)


def write(path, result):
    m, flags = result['metrics'], result['flags']
    results = result['checks']
    n_passed = sum(c['passed'] for c in results)
    rows = ''.join(f'<tr><td class="status">{badge(c["passed"])}</td><td class="check"><code>{esc(c["check"])}</code></td>'
                   f'<td class="why">{esc(c["why"])}</td></tr>' for c in results)
    setup = (f"{flags['model']}, prompt {flags['prompt']}, {flags['tool_descriptions']} tool descriptions, "
             f"confirmation {'required' if flags['require_confirmation'] else 'not required'}, "
             f"up to {flags['max_turns']} turns")
    unsafe = m['unsafe_actions']
    page = f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{esc(result['name'])}</title><style>{STYLE}</style></head><body>
<h1>{esc(result['name'])} {badge(bool(m['passed']), ('PASSED', 'FAILED'))}</h1>
<div class="sub">{esc(setup)}</div>
<div class="request">{esc(result['task']['request'])}</div>
<div class="kpis">
  <div class="kpi">Checks<b>{n_passed} / {len(results)}</b></div>
  <div class="kpi">Unsafe actions<b class="{'bad' if unsafe else ''}">{unsafe}</b></div>
  <div class="kpi">Turns<b>{m['turns']}</b></div>
  <div class="kpi">Tokens<b>{m['tokens']:,}</b><small>{m['tokens_in']:,} in, {m['tokens_out']:,} out</small></div>
  <div class="kpi">Cost<b>${m['cost'] * 1000:.2f}</b><small>per 1,000 tasks</small></div>
  <div class="kpi">Time to answer<b>{m['latency']:.1f} s</b></div>
</div>
<h2>Checks</h2>
<table>{rows}</table>
<h2>Conversation</h2>
{conversation(result['events'])}
<div class="foot">Prices are fictional (qa/prices.yaml): ${result['price']['input']:.2f} per million tokens in, ${result['price']['output']:.2f} out.
Greedy decoding with llama.cpp on the CPU.{' This conversation was computed by an earlier run with the same model, prompt, flags and task.' if result['memoized'] else ''}</div>
</body></html>
"""
    path.write_text(page)
