"""
The run's HTML report (report.html): per-class AP, AP and recall by object size, latency, and the images with the
most missed objects. QA-Board shows it in an iframe; the images are the run's own images/<n>.jpg.
"""
import html

from detector import CLASSES
from plots import CLASS_COLORS

STYLE = """
body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1c2127; margin: 16px; }
h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 20px 0 8px; }
.sub { color: #5f6b7c; margin-bottom: 12px; }
table { border-collapse: collapse; } th, td { padding: 4px 10px; border-bottom: 1px solid #e5e8eb; text-align: right; }
th:first-child, td:first-child { text-align: left; } th { font-weight: 600; color: #404854; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
.bar { display: inline-block; height: 8px; background: #2d72d2; border-radius: 2px; vertical-align: middle; }
.none { color: #8f99a8; }
.worst { display: flex; flex-wrap: wrap; gap: 12px; }
.worst figure { margin: 0; width: 300px; } .worst img { width: 300px; border-radius: 3px; }
.worst figcaption { font-size: 12px; color: #404854; }
.kpis { display: flex; gap: 24px; } .kpi b { display: block; font-size: 20px; }
"""


def fmt(value, digits=3):
    return f'{value:.{digits}f}' if value is not None else '<span class="none">-</span>'


def write(path, title, subtitle, metrics, results, counts, worst, latency):
    """worst: [(image number, file name, missed, labeled)]"""
    rows = []
    for class_id, name in CLASSES.items():
        ap = results['ap'].get(class_id)
        n = counts['by_class'].get(class_id, 0)
        if not n:
            continue
        bar = f'<span class="bar" style="width:{int(round((ap or 0) * 120))}px; background:{CLASS_COLORS[class_id]}"></span>' if ap is not None else ''
        rows.append(
            f'<tr><td><span class="swatch" style="background:{CLASS_COLORS[class_id]}"></span>{html.escape(name)}</td>'
            f'<td>{n}</td><td>{fmt(ap)} {bar}</td><td>{fmt(results["ap50"].get(class_id))}</td>'
            f'<td>{fmt(results["ap_area"]["small"].get(class_id))}</td></tr>'
        )
    sizes = []
    for size in ('small', 'medium', 'large'):
        if not counts['by_size'].get(size):
            continue
        sizes.append(f'<tr><td>{size}</td><td>{counts["by_size"].get(size, 0)}</td><td>{fmt(metrics.get(f"ap_{size}"))}</td>'
                     f'<td>{fmt(metrics.get(f"recall_{size}"), 2)}</td></tr>')
    figures = ''.join(
        f'<figure><a href="images/{n}.jpg"><img src="images/{n}.jpg" alt="{html.escape(name)}"></a>'
        f'<figcaption>#{n} {html.escape(name)}: {missed} of {labeled} objects missed</figcaption></figure>'
        for n, name, missed, labeled in worst
    )
    page = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{html.escape(title)}</title><style>{STYLE}</style></head><body>
<h1>{html.escape(title)}</h1>
<div class="sub">{html.escape(subtitle)}</div>
<div class="kpis">
  <div class="kpi">mAP<b>{fmt(metrics.get('map'))}</b></div>
  <div class="kpi">AP50<b>{fmt(metrics.get('map50'))}</b></div>
  <div class="kpi">AP small<b>{fmt(metrics.get('ap_small'))}</b></div>
  <div class="kpi">Latency<b>{latency['median_ms']:.1f} ms</b></div>
  <div class="kpi">Model<b>{metrics['model_mb']:.1f} MB</b></div>
</div>
<h2>Per class</h2>
<table><tr><th>Class</th><th>Objects</th><th>AP</th><th>AP50</th><th>AP small</th></tr>{''.join(rows)}</table>
<h2>By object size (in the 320x320 frame: small under 64x64 px, large over 128x128)</h2>
<table><tr><th>Size</th><th>Objects</th><th>AP</th><th>Recall</th></tr>{''.join(sizes)}</table>
<h2>Latency</h2>
<table><tr><th></th><th>ms per image</th></tr>
<tr><td>median</td><td>{latency['median_ms']:.2f}</td></tr><tr><td>p90</td><td>{latency['p90_ms']:.2f}</td></tr>
<tr><td>images</td><td>{latency['images']} (after {latency['warmup']} warmup runs, {latency['threads']} threads)</td></tr></table>
<h2>Most missed objects</h2>
<div class="worst">{figures or '<span class="none">Nothing missed.</span>'}</div>
</body></html>
"""
    path.write_text(page)
