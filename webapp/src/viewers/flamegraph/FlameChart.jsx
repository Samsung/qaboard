// One flame graph: wraps d3-flame-graph, which renders imperatively in a DOM element. We create a new chart when
// what it draws changes (data, layout, order, width); the search and the zoom apply to the chart in place.
//
// We love Brendan Gregg's flame charts, http://www.brendangregg.com/flamegraphs.html,
// and integrated Martin Spier's d3-flame-graph, https://github.com/spiermar/d3-flame-graph
import { useEffect, useRef, useState } from "react";
import { Button } from "@blueprintjs/core";
import { select } from 'd3-selection';
import * as flameGraph from 'd3-flame-graph';

import "./flamegraph.css";


const HIGHLIGHT = '#E600E6';

// d3-flame-graph's differential colors: red for frames that take more than in the reference, blue for less, orange
// for new ones, the darker the bigger the change. Ours knows which frames are new or removed, also when the deltas
// are scaled to compare shares.
export const differentialColor = d => {
  if (d.highlight) return HIGHLIGHT;
  if (d.data.missing === 'new') return 'rgb(255,190,90)';
  const delta = d.delta ?? d.data.delta ?? 0;
  // the frame's own value, not the zoomed one: d3-flame-graph sets the zoomed frame's ancestors to its value
  const value = Math.max(d.data.value || 0, Math.abs(delta));
  const vector = value ? Math.min(1, Math.abs(delta) / value) : 0;
  if (delta > 0) {
    const b = Math.round(235 * (1 - vector));
    return `rgb(220,${b},${b})`;
  }
  if (delta < 0) {
    const r = Math.round(235 * (1 - vector));
    return `rgb(${r},${r},220)`;
  }
  return 'rgb(220,220,220)';
};

// Black text, or white on dark frames (the ends of the diff's color scale)
export const textColor = fill => {
  let [r, g, b] = [200, 200, 200];
  const rgb = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(fill ?? '');
  if (rgb) [r, g, b] = rgb.slice(1).map(Number);
  else if (/^#[0-9a-f]{6}$/i.test(fill ?? '')) [r, g, b] = [1, 3, 5].map(i => parseInt(fill.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 125 ? '#ffffff' : '#000000';
};

const escapeHtml = text => `${text}`.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


// - data: the tree to draw (drawnTree), a copy for this chart: d3-flame-graph writes in it to hide frames when zooming
// - search: {query, matches(name)}, applied in place
// - describe(data): [[label, value]] for a frame's tooltip
// - zoomTo: {key}: zoom on the frame with this path of names (search's next/previous)
const FlameChart = ({ data, title, differential = false, width = 1180, inverted = true, sort = 'name', search, describe, zoomTo }) => {
  const container = useRef(null);
  const chart = useRef(null);
  // what the chart's callbacks read: they're created with the chart, these change without recreating it
  const latest = useRef({ search, describe });
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    latest.current = { search, describe };
  });

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // the tooltip goes in the page's body, so that the card doesn't clip it
    const tip_element = document.createElement('div');
    tip_element.className = 'qa-flame-tooltip';
    tip_element.setAttribute('role', 'tooltip');
    document.body.appendChild(tip_element);
    const describeFrame = d => latest.current.describe?.(d.data) ?? [];
    const tip = () => {};
    tip.show = (d, frame) => {
      tip_element.innerHTML = `<div class="qa-flame-tooltip-name">${escapeHtml(d.data.name)}</div>`
        + `<table>${describeFrame(d).map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</table>`;
      tip_element.style.display = 'block';
      const box = frame.getBoundingClientRect();
      const tip_box = tip_element.getBoundingClientRect();
      const left = Math.max(4, Math.min(window.innerWidth - tip_box.width - 4, box.left));
      const below = box.bottom + 6;
      const top = below + tip_box.height > window.innerHeight ? box.top - tip_box.height - 6 : below;
      tip_element.style.left = `${left + window.scrollX}px`;
      tip_element.style.top = `${top + window.scrollY}px`;
    };
    tip.hide = () => { tip_element.style.display = 'none'; };

    const frames = () => select(element).selectAll('g.frame');
    // Keyboard access: frames are buttons, one of them in the tab order, and arrow keys move between them
    const frameElement = node => frames().filter(d => d === node).node();
    const focusFrame = node => {
      const target = node && frameElement(node);
      if (!target) return;
      frames().attr('tabindex', -1);
      target.setAttribute('tabindex', 0);
      target.focus();
    };
    const drawnChildren = node => (node.children ?? []).filter(c => c.x1 - c.x0 > 0 && frameElement(c)).sort((a, b) => a.x0 - b.x0);
    let instance;
    const onKey = (event, d) => {
      let target;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        instance.zoomTo(d);
        focusFrame(d);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        instance.resetZoom();
        focusFrame(d);
        return;
      }
      if (event.key === (inverted ? 'ArrowDown' : 'ArrowUp')) target = drawnChildren(d)[0];
      else if (event.key === (inverted ? 'ArrowUp' : 'ArrowDown')) target = d.parent;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const siblings = d.parent ? drawnChildren(d.parent) : [];
        target = siblings[siblings.indexOf(d) + (event.key === 'ArrowLeft' ? -1 : 1)];
      } else if (event.key === 'Home') {
        target = d;
        while (target.parent) target = target.parent;
      } else return;
      event.preventDefault();
      focusFrame(target);
    };
    // after each update of the chart: accessibility, and readable labels on dark frames
    const decorate = () => {
      const all = frames();
      // (d3's callbacks get the elements as `nodes[i]`: the React Compiler doesn't handle `this`)
      const focusable = all.nodes().some(node => node.getAttribute('tabindex') === '0');
      all
        .attr('role', 'button')
        .attr('aria-label', d => d.data.name)
        .each((d, i, nodes) => {
          if (nodes[i].getAttribute('tabindex') === null || !focusable) nodes[i].setAttribute('tabindex', d.depth === 0 && !focusable ? 0 : -1);
        })
        .on('keydown', onKey)
        .on('focus', (event, d) => {
          // the full description only when it's needed: there can be thousands of frames
          event.currentTarget.setAttribute('aria-label', `${d.data.name}: ${describeFrame(d).map(([k, v]) => `${k} ${v}`).join(', ')}`);
          tip.show(d, event.currentTarget);
        })
        .on('blur', () => tip.hide());
      all.select('foreignObject div').style('color', (d, i, nodes) =>
        textColor(nodes[i].parentNode?.parentNode?.querySelector('rect')?.getAttribute('fill')));
    };

    instance = flameGraph.flamegraph()
      .transitionDuration(250)
      .width(width)
      .title(title ?? '')
      .inverted(inverted) // by default an icicle: the root on top
      .sort(sort === 'heaviest' ? (a, b) => (b.data.value - a.data.value) || (a.data.name < b.data.name ? -1 : 1) : true)
      .minFrameSize(1)
      .computeDelta(differential)
      .tooltip(tip)
      // clicks, Enter, and our zoomTo, resetZoom
      .onClick(frame => {
        setZoomed(!!frame.parent);
        decorate();
      })
      // the viewer shows the search's results, from the whole profile: the chart doesn't draw the smallest frames
      .setSearchHandler(() => {})
      .setDetailsHandler(() => {})
      .setSearchMatch((d, term) => !!term && !!latest.current.search?.matches?.(d.data.name))
      .setColorMapper(differential ? differentialColor : (d, color) => d.highlight ? HIGHLIGHT : color);
    instance.decorate = decorate;
    instance.zoomToKey = key => {
      const node = select(element).datum()?.descendants?.().find(n => n.data.key === key);
      if (node) instance.zoomTo(node);
    };
    select(element).datum(structuredClone(data)).call(instance);
    decorate();
    chart.current = instance;
    return () => {
      instance.destroy();
      tip_element.remove();
      chart.current = null;
    };
  }, [data, title, differential, width, inverted, sort]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    latest.current.search = search;
    if (search?.query) instance.search(search.query);
    else instance.clear();
    instance.decorate();
  }, [search, data, title, differential, width, inverted, sort]);

  useEffect(() => {
    if (zoomTo?.key) chart.current?.zoomToKey(zoomTo.key);
  }, [zoomTo, data, width, inverted, sort]);

  const resetZoom = () => chart.current?.resetZoom();
  return <>
    <div
      className="flame-graph"
      ref={container}
      role="group"
      aria-label="Flame graph: Tab to its frames, arrow keys to move, Enter to zoom, Escape to zoom out"
    />
    {zoomed && <Button style={{ margin: "5px 0" }} icon="zoom-out" onClick={resetZoom}>Zoom Out</Button>}
  </>;
};

export default FlameChart;
