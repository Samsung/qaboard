"""
Plotly figures, saved as *.plotly.json ({"data": [...], "layout": {...}}): QA-Board's viewer overlays the reference
run's traces, dashed because ours set their colors.
"""
import json

import numpy as np

COLORS = {'R': '#cd4246', 'G': '#238551', 'B': '#2d72d2', 'Y': '#404854', 'accent': '#c87619'}


def save(path, data, layout):
    layout = {'margin': {'l': 60, 'r': 20, 't': 40, 'b': 50}, 'height': 360, **layout}
    path.write_text(json.dumps({'data': data, 'layout': layout}, separators=(',', ':')))


def rounded(values, digits=4):
    return [round(float(v), digits) for v in values]


def edge_profile(path, edge):
    """The slanted edge's spread function, with the overshoot past the bright level annotated."""
    x, esf = edge['position'], edge['esf']
    peak = int(np.argmax(esf))
    save(path, [
        {'type': 'scatter', 'mode': 'lines', 'name': 'Edge profile', 'x': rounded(x, 2), 'y': rounded(esf, 2),
         'line': {'color': COLORS['Y'], 'width': 2}},
        {'type': 'scatter', 'mode': 'lines', 'name': 'Bright level', 'x': [float(x[0]), float(x[-1])],
         'y': [round(edge['bright'], 2)] * 2, 'line': {'color': COLORS['accent'], 'width': 1, 'dash': 'dot'}},
    ], {
        'title': {'text': f"Edge profile: overshoot {edge['overshoot']:.1%}"},
        'xaxis': {'title': {'text': 'Distance to the edge (pixels)'}, 'range': [-8, 8]},
        'yaxis': {'title': {'text': 'Luma (8-bit)'}},
        'annotations': [{'x': float(x[peak]), 'y': float(esf[peak]), 'text': f"+{edge['overshoot']:.1%}",
                         'showarrow': True, 'arrowhead': 2, 'ax': 40, 'ay': -30}],
    })


def mtf(path, edge):
    keep = edge['frequency'] <= 1.0
    save(path, [
        {'type': 'scatter', 'mode': 'lines', 'name': 'MTF', 'x': rounded(edge['frequency'][keep], 3),
         'y': rounded(edge['mtf'][keep], 3), 'line': {'color': COLORS['Y'], 'width': 2}},
        {'type': 'scatter', 'mode': 'markers', 'name': 'MTF50', 'x': [round(edge['mtf50'], 4)], 'y': [0.5],
         'marker': {'color': COLORS['accent'], 'size': 9}},
    ], {
        'title': {'text': f"MTF50 {edge['mtf50']:.3f} cycles/pixel"},
        'xaxis': {'title': {'text': 'Spatial frequency (cycles/pixel)'}, 'range': [0, 1]},
        'yaxis': {'title': {'text': 'Contrast'}, 'range': [0, 1.6]},
        'shapes': [{'type': 'line', 'x0': 0.5, 'x1': 0.5, 'y0': 0, 'y1': 1.6, 'line': {'dash': 'dot', 'color': '#8f99a8'}}],
    })


def color_errors(path, names, srgb, delta_e):
    colors = [f'rgb({r},{g},{b})' for r, g, b in srgb]
    save(path, [
        {'type': 'bar', 'name': 'ΔE2000', 'x': names, 'y': rounded(delta_e, 3),
         'marker': {'color': colors, 'line': {'color': '#404854', 'width': 1}}},
    ], {
        'title': {'text': f'Color error ΔE2000, mean {np.mean(delta_e):.2f}'},
        'yaxis': {'title': {'text': 'ΔE2000'}},
        'xaxis': {'tickangle': -45},
        'height': 400,
    })


def noise_vs_signal(path, signal, noise):
    """signal, noise: (patches, 4) for R, G, B and luma."""
    order = np.argsort(signal[:, 3])
    save(path, [
        {'type': 'scatter', 'mode': 'lines+markers', 'name': name, 'x': rounded(signal[order, i], 2),
         'y': rounded(noise[order, i], 3), 'line': {'color': COLORS[name], 'width': 2}}
        for i, name in enumerate('RGBY')
    ], {
        'title': {'text': 'Noise in the gray patches'},
        'xaxis': {'title': {'text': 'Signal (8-bit)'}},
        'yaxis': {'title': {'text': 'Noise, standard deviation (8-bit)'}, 'rangemode': 'tozero'},
    })
