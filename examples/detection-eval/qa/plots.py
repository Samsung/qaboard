"""
Plotly figures, saved as *.plotly.json ({"data": [...], "layout": {...}}). With `side_by_side: false`, QA-Board's viewer
draws the reference run's traces on the same axes: our traces set their colors, so the reference's are dashed and faded.
"""
import json

import numpy as np

from detector import CLASSES

# One color per class, the same in the plots, the images and the report
CLASS_COLORS = {
    1: '#2d72d2',    # person: blue
    2: '#c87619',    # bicycle: orange
    3: '#00a396',    # car: turquoise
    8: '#634dbf',    # truck: indigo
    62: '#d1980b',   # chair: gold
    44: '#9d3f9d',   # bottle: violet
    27: '#946638',   # backpack: sepia
    64: '#29a634',   # potted plant: forest
}
GRAY = '#5f6b7c'


def save(path, data, layout):
    layout = {'margin': {'l': 60, 'r': 20, 't': 50, 'b': 50}, 'height': 380, **layout}
    if 'title' in layout:   # left-aligned, clear of the plot's toolbar
        layout['title'] = {'x': 0.01, 'xanchor': 'left', 'font': {'size': 14}, **layout['title']}
    path.write_text(json.dumps({'data': data, 'layout': layout}, separators=(',', ':')))


def rounded(values, digits=4):
    return [round(float(v), digits) for v in values]


def envelope(recall, precision, points=101):
    """The interpolated precision-recall curve AP is computed from, sampled on a recall grid"""
    if not len(recall):
        return [], []
    env = np.maximum.accumulate(np.asarray(precision)[::-1])[::-1]
    grid = np.linspace(0, float(recall[-1]), points)
    idx = np.minimum(np.searchsorted(recall, grid, side='left'), len(env) - 1)
    return grid, env[idx]


def precision_recall(path, curves, ap50, title):
    """One curve per class at IoU 0.5"""
    data = []
    for class_id, curve in curves.items():
        r, p = envelope(curve['recall'], curve['precision'])
        if not len(r):
            continue
        data.append({
            'type': 'scatter', 'mode': 'lines', 'name': f"{CLASSES[class_id]} (AP50 {ap50[class_id]:.2f})",
            'x': rounded(r, 3), 'y': rounded(p, 3), 'line': {'color': CLASS_COLORS[class_id], 'width': 2, 'shape': 'hv'},
        })
    save(path, data, {
        'title': {'text': title},
        'xaxis': {'title': {'text': 'Recall'}, 'range': [0, 1.0]},
        'yaxis': {'title': {'text': 'Precision'}, 'range': [0, 1.05]},
        'legend': {'orientation': 'v'},
    })


def recall_by_size(path, recall, counts, title):
    """Recall at IoU 0.5 by object size: bars, next to the reference's (faded)"""
    sizes = [s for s in ('small', 'medium', 'large') if counts.get(s)]
    save(path, [
        {'type': 'bar', 'name': 'Recall', 'x': [f'{s} ({counts[s]})' for s in sizes],
         'y': [round(recall[s], 3) for s in sizes], 'marker': {'color': '#2d72d2'},
         'text': [f'{recall[s]:.0%}' for s in sizes], 'textposition': 'outside'},
    ], {
        'title': {'text': title},
        'xaxis': {'title': {'text': 'Object size in the 320x320 frame (objects)'}},
        'yaxis': {'title': {'text': 'Recall at IoU 0.5'}, 'range': [0, 1.1], 'tickformat': '.0%'},
        'barmode': 'group',
    })


def confusions(path, matrix, labels, title):
    """Heatmap: rows are the ground truth's class (or background), columns the detection's"""
    z = np.asarray(matrix, dtype=float)
    shares = z / np.maximum(z.sum(axis=1, keepdims=True), 1)
    text = [[str(int(v)) if v else '' for v in row] for row in z]
    save(path, [
        {'type': 'heatmap', 'z': [rounded(row, 3) for row in shares], 'x': labels, 'y': labels,
         'text': text, 'texttemplate': '%{text}', 'colorscale': 'Blues', 'zmin': 0, 'zmax': 1, 'showscale': False,
         'hovertemplate': 'labeled %{y}, detected %{x}: %{text}<extra></extra>'},
    ], {
        'title': {'text': title},
        'xaxis': {'title': {'text': 'Detected as'}, 'side': 'bottom'},
        'yaxis': {'title': {'text': 'Labeled'}, 'autorange': 'reversed'},
        'height': 460,
    })
