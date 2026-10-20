"""
tools.plotly.json: the conversation as a timeline, one column per assistant turn: which tool it called (or whether it
answered), and how it went. QA-Board shows the reference run's next to it.
"""
import json

import tools
import checks

ANSWER = 'answer the operator'
# Blueprint's intent colors, readable on light and dark backgrounds
COLORS = {'ok': '#2d72d2', 'error': '#c87619', 'action': '#238551', 'unsafe': '#cd4246', 'answer': '#8f99a8'}
LABELS = {'ok': 'tool call', 'error': 'tool error', 'action': 'action', 'unsafe': 'action without confirmation',
          'answer': 'answer'}


def args(arguments: dict) -> str:
    return ', '.join(f'{k}={json.dumps(v)}' for k, v in arguments.items())


def tool_calls(path, events, title):
    unsafe = {id(e) for e in checks.unsafe_actions(events)}
    points = []   # (turn, row, outcome, hover)
    for i, e in enumerate(events):
        if e['kind'] != 'assistant':
            continue
        if 'tool' in e:
            result = next((r for r in events[i + 1:] if r['kind'] == 'tool'), {})
            if id(result) in unsafe:
                outcome = 'unsafe'
            elif result.get('error'):
                outcome = 'error'
            elif result.get('executed'):
                outcome = 'action'
            else:
                outcome = 'ok'
            detail = f"error: {result['error']}" if result.get('error') else json.dumps(result.get('result'))[:120]
            points.append((e['turn'], e['tool'], outcome, f"{e['tool']}({args(e['arguments'])})<br>{detail}"))
        elif 'answer' in e:
            points.append((e['turn'], ANSWER, 'answer', e['answer'][:120]))
        else:
            points.append((e['turn'], ANSWER, 'error', e.get('error', '')))
    rows = [*tools.TOOLS, ANSWER]
    data = [{
        # every tool gets its row, called or not
        'type': 'scatter', 'mode': 'markers', 'showlegend': False, 'hoverinfo': 'skip',
        'x': [1] * len(rows), 'y': rows, 'marker': {'opacity': 0},
    }, {
        'type': 'scatter', 'mode': 'lines', 'showlegend': False, 'hoverinfo': 'skip',
        'x': [p[0] for p in points], 'y': [p[1] for p in points], 'line': {'color': '#8f99a8', 'width': 1, 'dash': 'dot'},
    }]
    for outcome in ('ok', 'action', 'unsafe', 'error', 'answer'):
        selected = [p for p in points if p[2] == outcome]
        if not selected:
            continue
        data.append({
            'type': 'scatter', 'mode': 'markers', 'name': LABELS[outcome],
            'x': [p[0] for p in selected], 'y': [p[1] for p in selected], 'text': [p[3] for p in selected],
            'hovertemplate': 'turn %{x}: %{text}<extra></extra>',
            'marker': {'color': COLORS[outcome], 'size': 13, 'symbol': 'x' if outcome == 'unsafe' else 'circle',
                       'line': {'width': 0}},
        })
    turns = max((p[0] for p in points), default=1)
    layout = {
        'title': {'text': title, 'x': 0.01, 'xanchor': 'left', 'font': {'size': 14}},
        'margin': {'l': 150, 'r': 20, 't': 50, 'b': 70}, 'height': 360,
        'xaxis': {'title': {'text': 'Turn'}, 'dtick': 1, 'range': [0.5, max(turns, 3) + 0.5], 'zeroline': False},
        'yaxis': {'type': 'category', 'categoryorder': 'array', 'categoryarray': rows[::-1]},
        'legend': {'orientation': 'h', 'y': -0.3},
    }
    path.write_text(json.dumps({'data': data, 'layout': layout}, separators=(',', ':')))
