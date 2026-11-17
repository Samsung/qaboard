// What a run logged while it ran, e.g. a training's loss at each step (run.log() in Python, see qaboard/series.py):
// one plot per series, the reference run's on the same axes, dashed. While the run goes on, the plots follow it.
import { lazy, Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Callout, Classes, InputGroup, Tag } from "@blueprintjs/core";

import Plot from "../components/Plot";
import { fileQuery } from "../api/queries";
import { ViewerError, ViewerLoading } from "./ViewerStates";
import { plot_color } from "../sideColors";
import { useIsDark } from "../theme";
import { useLabels } from "../hooks";
import { format_duration, smooth, sorted_keys } from "./series/series";
import { REFRESH_INTERVAL, SeriesOptions, parse_file, plot_config, plot_layout, useSeriesOptions } from "./series/SeriesOptions";

const LoadableTextViewer = lazy(() => import('./textViewer'));

// Plots are drawn one after the other: runs with hundreds of series show the first ones, and the others on demand
const SHOWN_AT_FIRST = 12;
const PLOT_WIDTH = 400;
const PLOT_HEIGHT = 250;
const x_values = (series, x) => x === 'time' ? series.time : series.step;

// The traces of one series: the reference's under the new run's. Downsampled series show the range of the values
// each point stands for. With smoothing, the values as they are stay behind, faded.
export const series_traces = (key, { model_new, model_ref, options, names, colors }) => {
  const traces = [];
  for (const [side, model] of [['ref', model_ref], ['new', model_new]]) {
    const series = model?.series?.[key];
    if (!series) continue;
    const x = x_values(series, options.x);
    const color = colors[side];
    const smoothed = options.smoothing > 0;
    if (!smoothed && series.min && series.max) {
      const range = { x, type: 'scatter', mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: side };
      traces.push({ ...range, y: series.min });
      traces.push({ ...range, y: series.max, fill: 'tonexty', fillcolor: `${color}33` });
    }
    if (smoothed)
      traces.push({ x, y: series.value, type: 'scatter', mode: 'lines', line: { color: `${color}44`, width: 1 }, hoverinfo: 'skip', showlegend: false, legendgroup: side });
    traces.push({
      x,
      y: smooth(series.value, options.smoothing),
      type: 'scatter',
      mode: series.step.length > 1 ? 'lines' : 'markers',
      name: names[side],
      legendgroup: side,
      line: { color, width: 2, dash: side === 'ref' ? 'dash' : undefined },
      marker: { color, size: 6 },
      hovertemplate: `%{y:.5g}<extra>${names[side]}</extra>`,
    });
  }
  return traces;
};

const SeriesPlot = ({ name, traces, options }) =>
  <Plot data={traces} layout={plot_layout(name, options, { width: PLOT_WIDTH, height: PLOT_HEIGHT })} config={plot_config}/>;

const toolbar_style = { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', margin: '6px 0' };
const grid_style = { display: 'flex', flexWrap: 'wrap', gap: 4 };

// - series: the options people chose, the same for all the runs' cards (controls.series in the URL)
// - fallback_to_text: the file was picked by its name (series.json...), without `type: series`: if it isn't a series
//   file, it's shown as text, as before the viewer existed
const SeriesViewer = ({ output_new, output_ref, path, path_ref, labels: labels_, series: chosen, onControlsChange, fallback_to_text, style, ...props }) => {
  const labels = useLabels(labels_);
  const is_dark = useIsDark();
  const [options, setOptions, preview] = useSeriesOptions(chosen, onControlsChange);
  const [filter, setFilter] = useState('');
  const [show_all, setShowAll] = useState(false);

  const url_new = output_new?.output_dir_url && path ? `${output_new.output_dir_url}/${path}` : undefined;
  const url_ref = url_new && output_ref?.output_dir_url ? `${output_ref.output_dir_url}/${path_ref ?? path}` : undefined;
  const query_new = useQuery({
    ...fileQuery(url_new, { is_running: output_new?.is_running, responseType: 'text' }),
    refetchInterval: output_new?.is_running ? REFRESH_INTERVAL : false,
  });
  // without the reference's file, we show the new one alone
  const query_ref = useQuery({
    ...fileQuery(url_ref, { is_running: output_ref?.is_running, responseType: 'text' }),
    refetchInterval: output_ref?.is_running ? REFRESH_INTERVAL : false,
  });
  const parsed_new = useMemo(() => parse_file(query_new.data), [query_new.data]);
  const parsed_ref = useMemo(() => parse_file(query_ref.isSuccess ? query_ref.data : undefined), [query_ref.isSuccess, query_ref.data]);

  if (query_new.isError) return <ViewerError path={path} error={query_new.error}/>;
  if (!url_new || query_new.isPending || (url_ref && query_ref.isPending)) return <ViewerLoading height={style?.height}/>;
  if (parsed_new.error) {
    if (fallback_to_text)
      return <>
        <Callout compact icon="info-sign" style={{ marginBottom: 6 }}>
          Not a series file the viewer reads ({parsed_new.error.message}): shown as text.
        </Callout>
        <Suspense fallback={<ViewerLoading height={style?.height}/>}>
          <LoadableTextViewer {...props} output_new={output_new} output_ref={output_ref} path={path} labels={labels_} style={style}/>
        </Suspense>
      </>;
    return <Callout compact intent="warning" icon="warning-sign">Can't read <code>{path}</code> as series: {parsed_new.error.message}</Callout>;
  }

  const model_new = parsed_new.model;
  const model_ref = output_ref?.id !== output_new?.id ? parsed_ref.model : null;
  const keys = sorted_keys(Object.keys(model_new.series));
  if (keys.length === 0)
    return <Callout compact icon="info-sign">{output_new?.is_running ? "The run hasn't logged anything yet." : "The run logged no series."}</Callout>;

  const needle = filter.trim().toLowerCase();
  const matching = needle ? keys.filter(key => key.toLowerCase().includes(needle)) : keys;
  const shown = show_all ? matching : matching.slice(0, SHOWN_AT_FIRST);
  const names = { new: labels?.new ?? 'new', ref: labels?.reference ?? 'reference' };
  const colors = {
    new: labels?.colors?.new ? plot_color(labels.colors.new, is_dark) : '#2d72d2',
    ref: labels?.colors?.reference ? plot_color(labels.colors.reference, is_dark) : '#738091',
  };
  const last = Math.max(...keys.map(key => model_new.series[key].time.at(-1) ?? 0));
  const has_ref = !!model_ref && keys.some(key => model_ref.series[key]);

  return <div data-testid="series-viewer">
    <div style={toolbar_style}>
      {output_new?.is_running && <Tag minimal intent="primary" icon="pulse">Live</Tag>}
      <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
        {keys.length} series{last > 0 && <>, logged over {format_duration(last)}</>}
      </span>
      {has_ref && <span style={{ fontSize: 12 }}>
        <span style={{ color: colors.new, fontWeight: 600 }}>— {names.new}</span>{' '}
        <span style={{ color: colors.ref, fontWeight: 600 }}>- - {names.ref}</span>
      </span>}
      <SeriesOptions options={options} setOptions={setOptions} preview={preview}/>
      {keys.length > 6 && <InputGroup size="small" leftIcon="search" placeholder="Filter series" value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 160 }}/>}
    </div>
    <div style={grid_style}>
      {shown.map(key => <SeriesPlot
        key={key}
        name={key}
        options={options}
        traces={series_traces(key, { model_new, model_ref, options, names, colors })}
      />)}
    </div>
    {matching.length > shown.length && <Button size="small" variant="minimal" icon="chevron-down" onClick={() => setShowAll(true)}>
      Show the {matching.length - shown.length} other series
    </Button>}
    {needle && matching.length === 0 && <span className={Classes.TEXT_MUTED}>No series matches "{filter}".</span>}
  </div>;
};

export default SeriesViewer;
