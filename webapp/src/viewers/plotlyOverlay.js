// Plots saved with `side_by_side: false`: the new run's traces, with the reference's (and the ground truth's) on the
// same axes. Traces that set their colors keep them: the reference's are then dashed and faded.
// The others get the colors of what we compare (src/sideColors.js), and are named after them: "ISP v2 | p99"...
import { Colors } from "@blueprintjs/core";

const groundtruth = { name: 'groundtruth', color: `${Colors.GREEN2}dd` };


export const adapt = (trace, label, name, color) => {
  let width = (trace.line && trace.line.width) || 2;
  let size = (trace.marker && trace.marker.size) || 3;
  if (label === "ref") {
    width += 1;
    size += 1;
  }
  const trace_has_colors = !!(trace.line || {}).color || !!(trace.marker || {}).color
  // console.log(trace)
  return {
    ...trace,
    opacity: (trace_has_colors && label === "ref") ? (!!trace.opacity ? trace.opacity / 2 : 0.4) : undefined,
    name: !!trace.name ? `${name} | ${trace.name}` : name,
    legendgroup: !!trace.legendgroup ? `${name} | ${trace.legendgroup}` : undefined,
    line: {
      ...trace.line,
      // FIXME: if we already use color, use some alpha like below, or dotted lines?
      color: !!(trace.line || {}).color ? trace.line.color : color,
      dash: (!!(trace.line || {}).color && !!!(trace.line || {}).dash && label === "ref") ? 'dashdot' : (trace.line || {}).dash,
      // The reference is wider to make it easy to identify unchanged results
      width,
    },
    marker: {
      ...trace.marker,
      opacity: (!!trace_has_colors && label === "ref") ? (!!(trace.marker || {}).opacity ? trace.marker.opacity / 2 : 0.4) : (trace.marker || {}).opacity,
      color: !!(trace.marker || {}).color ? trace.marker.color : color,
      size,
    },
    // TODO: make other adjustments for other plot types, like tables...
  }
}

// All the traces to draw, the reference's under the new run's.
// names and colors by label, e.g. { new: 'ISP v2', ref: 'v1.4' }: those of the sides compared (useComparison().labels)
export const overlay = (data, has_ref, { names = {}, colors = {} } = {}) => {
  let traces = [];
  ['groundtruth', 'ref', 'new'].forEach(label => {
    let trace = data[label]
    if (!trace)
      return
    // a figure's data is a list of traces
    if (has_ref)
      trace = (Array.isArray(trace) ? trace : [trace]).map(t => adapt(t, label, names[label] ?? groundtruth.name, colors[label] ?? groundtruth.color))
    traces = traces.concat(trace)
  });
  return traces
}
