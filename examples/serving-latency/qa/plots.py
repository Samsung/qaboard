"""
Plotly figures from gateway-bench's results, saved as *.plotly.json ({"data": [...], "layout": {...}}).
Traces set their colors: when a visualization has `side_by_side: false`, QA-Board's viewer overlays the reference
run's traces, dashed and faded.
"""
import json
import math

COLORS = {
    'p50': '#2d72d2', 'p90': '#7961db', 'p99': '#c87619', 'max': '#cd4246', 'depth': '#8f99a8',
    'queue': '#8f99a8', 'batch': '#2d72d2', 'lock': '#cd4246', 'compute': '#238551', 'line': '#404854',
}
PERCENTILE_TICKS = [(1, '0%'), (2, '50%'), (10, '90%'), (100, '99%'), (1000, '99.9%'), (10000, '99.99%'), (100000, '99.999%')]


def save(path, data, layout):
    layout = {'margin': {'l': 60, 'r': 20, 't': 40, 'b': 50}, 'height': 380, **layout}
    path.write_text(json.dumps({'data': data, 'layout': layout}, separators=(',', ':'), allow_nan=False))


def r(value, digits=4):
    return None if value is None or not math.isfinite(value) else round(value, digits)


def latency_cdf(path, cdf, slo_ms, title):
    """Latency against 1/(1-percentile) on a log axis: the tail gets as much room as the body"""
    points = [(p, v) for p, v in cdf if p < 100]
    x = [1 / (1 - p / 100) for p, _ in points]
    y = [v for _, v in points]
    text = [f'p{p:.4g}: {v:.3g} ms' for p, v in points]
    ticks = [(v, t) for v, t in PERCENTILE_TICKS if v <= max(x + [10]) * 1.5]
    save(path, [
        {'type': 'scatter', 'mode': 'lines', 'name': 'Latency', 'x': [r(v, 3) for v in x], 'y': [r(v, 4) for v in y],
         'text': text, 'hoverinfo': 'text', 'line': {'color': COLORS['line'], 'width': 2.5}},
        {'type': 'scatter', 'mode': 'lines', 'name': f'SLO {slo_ms:g} ms', 'x': [1, ticks[-1][0]], 'y': [slo_ms, slo_ms],
         'hoverinfo': 'name', 'line': {'color': COLORS['max'], 'width': 1, 'dash': 'dot'}},
    ], {
        'title': {'text': title},
        'xaxis': {'title': {'text': 'Percentile'}, 'type': 'log', 'tickvals': [v for v, _ in ticks], 'ticktext': [t for _, t in ticks]},
        'yaxis': {'title': {'text': 'Latency (ms)'}, 'type': 'log'},
        'legend': {'x': 0.02, 'y': 0.98},
    })


def breakdown(path, rows):
    """Where the time goes around each percentile: stacked bars"""
    x = [f"p{row['percentile']:g}" for row in rows]
    parts = [('queue_ms', 'Queue', 'queue'), ('batch_ms', 'Batch wait', 'batch'), ('lock_ms', 'Lock wait', 'lock'),
             ('compute_ms', 'Compute', 'compute')]
    save(path, [
        {'type': 'bar', 'name': name, 'x': x, 'y': [r(row[key]) for row in rows], 'marker': {'color': COLORS[color]},
         'hovertemplate': '%{x} ' + name.lower() + ': %{y:.3f} ms<extra></extra>'}
        for key, name, color in parts
    ], {
        'title': {'text': 'Where the time goes, around each percentile'},
        'barmode': 'stack',
        'yaxis': {'title': {'text': 'ms'}},
        'xaxis': {'title': {'text': 'Requests around the percentile'}},
    })


def timeline(path, t, title):
    shapes = [{'type': 'rect', 'xref': 'x', 'yref': 'paper', 'x0': 0, 'x1': t['window_s'][0], 'y0': 0, 'y1': 1,
               'fillcolor': '#8f99a8', 'opacity': 0.12, 'line': {'width': 0}}]
    for s, e in t.get('bursts_s', []):
        shapes.append({'type': 'rect', 'xref': 'x', 'yref': 'paper', 'x0': s, 'x1': e, 'y0': 0, 'y1': 1,
                       'fillcolor': COLORS['p99'], 'opacity': 0.12, 'line': {'width': 0}})
    x = [round(v, 2) for v in t['t_s']]
    save(path, [
        {'type': 'scatter', 'mode': 'lines', 'name': 'Queue depth', 'x': x, 'y': t['queue_depth'], 'yaxis': 'y2',
         'fill': 'tozeroy', 'line': {'color': COLORS['depth'], 'width': 1}},
        {'type': 'scatter', 'mode': 'lines', 'name': 'p50', 'x': x, 'y': [r(v) for v in t['p50_ms']], 'line': {'color': COLORS['p50'], 'width': 2}},
        {'type': 'scatter', 'mode': 'lines', 'name': 'p99', 'x': x, 'y': [r(v) for v in t['p99_ms']], 'line': {'color': COLORS['p99'], 'width': 2}},
        {'type': 'scatter', 'mode': 'lines', 'name': 'max', 'x': x, 'y': [r(v) for v in t['max_ms']], 'line': {'color': COLORS['max'], 'width': 1}},
    ], {
        'title': {'text': title},
        'xaxis': {'title': {'text': 'Time (s), by scheduled send time; gray: warmup'}},
        'yaxis': {'title': {'text': 'Latency per 100 ms (ms)'}, 'type': 'log'},
        'yaxis2': {'title': {'text': 'Queue depth'}, 'overlaying': 'y', 'side': 'right', 'showgrid': False, 'rangemode': 'tozero'},
        'shapes': shapes,
        'legend': {'orientation': 'h', 'y': -0.2},
    })


def throughput_vs_p99(path, steps, slo_ms):
    """The ramp: achieved throughput against p99, one point per step"""
    x = [r(s['throughput'], 1) for s in steps]
    save(path, [
        {'type': 'scatter', 'mode': 'lines+markers', 'name': 'p99', 'x': x, 'y': [r(s['p99_ms']) for s in steps],
         'text': [f"offered {s['offered']:,.0f} req/s" for s in steps], 'line': {'color': COLORS['p99'], 'width': 2.5},
         'marker': {'color': COLORS['p99'], 'size': 7}},
        {'type': 'scatter', 'mode': 'lines+markers', 'name': 'p50', 'x': x, 'y': [r(s['p50_ms']) for s in steps],
         'text': [f"offered {s['offered']:,.0f} req/s" for s in steps], 'line': {'color': COLORS['p50'], 'width': 1.5},
         'marker': {'color': COLORS['p50'], 'size': 5}},
        {'type': 'scatter', 'mode': 'lines', 'name': f'SLO {slo_ms:g} ms', 'x': [min(x), max(x)], 'y': [slo_ms, slo_ms],
         'hoverinfo': 'name', 'line': {'color': COLORS['max'], 'width': 1, 'dash': 'dot'}},
    ], {
        'title': {'text': 'Throughput vs latency, as the load ramps up'},
        'xaxis': {'title': {'text': 'Achieved throughput (req/s)'}},
        'yaxis': {'title': {'text': 'Latency (ms)'}, 'type': 'log'},
        'legend': {'x': 0.02, 'y': 0.98},
    })


def cores(path, c):
    busy = c['busy']
    save(path, [
        {'type': 'heatmap', 'x': [round(v, 2) for v in c['t_s']], 'y': [f'cpu {i}' for i in range(len(busy))],
         'z': [[round(v) for v in row] for row in busy], 'zmin': 0, 'zmax': 100, 'colorscale': 'Blues',
         'colorbar': {'title': {'text': '% busy'}}, 'hovertemplate': '%{y} at %{x}s: %{z}% busy<extra></extra>'},
    ], {
        'title': {'text': 'CPU use per core (whole machine, /proc/stat)'},
        'xaxis': {'title': {'text': 'Time (s)'}},
        'height': 120 + 40 * len(busy),
    })


def batch_sizes(path, counts):
    total = sum(counts) or 1
    sizes = [i for i, c in enumerate(counts) if i > 0]
    save(path, [
        {'type': 'bar', 'name': 'Batches', 'x': sizes, 'y': [round(100 * counts[i] / total, 2) for i in sizes],
         'marker': {'color': COLORS['batch']}},
    ], {
        'title': {'text': f'Batch sizes ({total:,} batches)'},
        'xaxis': {'title': {'text': 'Requests per batch'}, 'dtick': 1 if len(sizes) <= 20 else 4},
        'yaxis': {'title': {'text': '% of batches'}},
    })


def latency_histogram(path, bins):
    total = sum(b[2] for b in bins) or 1
    save(path, [
        {'type': 'bar', 'name': 'Requests', 'x': [round(math.sqrt(lo * hi), 4) for lo, hi, _ in bins],
         'y': [round(100 * c / total, 3) for _, _, c in bins], 'marker': {'color': COLORS['p50']}},
    ], {
        'title': {'text': 'Latency histogram'},
        'xaxis': {'title': {'text': 'Latency (ms)'}, 'type': 'log'},
        'yaxis': {'title': {'text': '% of requests'}},
    })
