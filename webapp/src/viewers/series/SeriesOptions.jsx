// What the two views of logged series share: a run's card (../series.jsx) and all the runs of a batch
// (../SeriesComparison.jsx). The options people choose are the same in both, and kept in the page's address.
import { useState } from "react";
import { HTMLSelect, Slider, Switch } from "@blueprintjs/core";

import { parse_series } from "./series";

// Running runs write their series every few seconds
export const REFRESH_INTERVAL = 10 * 1000;
export const default_options = { smoothing: 0, log: false, x: 'step' };

// { model } or { error }, for files that may not be series
export const parse_file = text => {
  if (text === undefined || text === null) return { model: null };
  try {
    return { model: parse_series(text) };
  } catch (error) {
    return { model: null, error };
  }
};

// The options, and how to change them: [options, setOptions, preview].
// - chosen: the page's (controls.series), onControlsChange: tells the page, so that every card and the URL follow.
//   Without it, e.g. in a preview, the options are the component's own.
// - preview: changes shown before they are chosen, while the smoothing slider is dragged
export const useSeriesOptions = (chosen, onControlsChange) => {
  const [local, setLocal] = useState({});
  const options = { ...default_options, ...chosen, ...local };
  const preview = change => setLocal(local => ({ ...local, ...change }));
  const setOptions = change => {
    if (!onControlsChange) return preview(change);
    setLocal({});
    onControlsChange({ series: { ...chosen, ...change } });
  };
  return [options, setOptions, preview];
};

export const SeriesOptions = ({ options, setOptions, preview }) => <>
  <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
    Smoothing
    <span style={{ width: 110, display: 'inline-block', marginRight: 10 }}>
      <Slider
        min={0} max={0.99} stepSize={0.01} labelRenderer={false}
        value={options.smoothing}
        onChange={smoothing => preview({ smoothing })}
        onRelease={smoothing => setOptions({ smoothing })}
        handleHtmlProps={{ 'aria-label': 'Smoothing' }}
      />
    </span>
  </span>
  <Switch checked={!!options.log} label="Log scale" onChange={e => setOptions({ log: e.target.checked })} style={{ marginBottom: 0, fontSize: 12 }}/>
  <HTMLSelect
    minimal
    aria-label="Horizontal axis"
    value={options.x}
    onChange={e => setOptions({ x: e.target.value })}
    options={[{ value: 'step', label: 'By step' }, { value: 'time', label: 'By time' }]}
  />
</>;

// A plot of one series: small, with its name as title
export const plot_layout = (name, options, { width, height, hovermode = 'x unified' }) => ({
  width,
  height,
  margin: { l: 50, r: 10, t: 30, b: 35 },
  title: { text: name, font: { size: 13 }, x: 0.02, xanchor: 'left' },
  showlegend: false,
  hovermode,
  xaxis: { automargin: true, title: options.x === 'time' ? { text: 'seconds', font: { size: 11 } } : undefined },
  yaxis: { automargin: true, type: options.log ? 'log' : 'linear' },
});

export const plot_config = { displayModeBar: false };
