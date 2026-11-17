// The series of all the runs shown, on the same plots: one plot per series, one line per run (run.log() in Python,
// see qaboard/series.py). In the Summary view. People show and hide runs, color them by a parameter, and compare
// them with their reference runs. A run's card has the same series against its reference alone (series.jsx).
import { useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Button, Callout, Card, Classes, HTMLSelect, InputGroup, Spinner, Switch, Tag } from "@blueprintjs/core";

import Plot, { restylePlot } from "../components/Plot";
import { fileQuery } from "../api/queries";
import { sorted_keys } from "./series/series";
import { REFRESH_INTERVAL, SeriesOptions, parse_file, plot_config, plot_layout, useSeriesOptions } from "./series/SeriesOptions";
import { comparison_traces, highlight_update, run_labels, run_styles, series_counts, varying_params } from "./series/comparison";
import { started_from_code } from "./runView";

// More lines than that can't be told apart, and each run is a request: people filter the runs
export const MAX_RUNS = 40;
const SHOWN_AT_FIRST = 8;
const SERIES_FILE = 'series.json';
const PLOT_WIDTH = 460;
const PLOT_HEIGHT = 300;

// runs whose file isn't series are left out
const parse = text => parse_file(text).model;

const series_query = output => ({
  ...fileQuery(output?.output_dir_url ? `${output.output_dir_url}/${SERIES_FILE}` : undefined, { is_running: output?.is_running, responseType: 'text' }),
  select: parse,
  // runs without series: no file
  retry: false,
  refetchInterval: output?.is_running ? REFRESH_INTERVAL : false,
});

// with many runs, a label with every run's value hides the plot: only the closest
// register: tells the comparison the plot's element once Plotly drew it, null when it is removed
const ComparisonPlot = ({ name, traces, options, many, register }) => <Plot
  data={traces}
  layout={plot_layout(name, options, { width: PLOT_WIDTH, height: PLOT_HEIGHT, hovermode: many ? 'closest' : 'x unified' })}
  config={plot_config}
  onInitialized={(_, element) => register(element)}
  onPurge={() => register(null)}
/>;

const swatch_style = (style, shown) => ({
  display: 'inline-block', flex: 'none', width: 18, height: 0, marginRight: 8,
  borderTop: `3px ${style.dash === 'solid' ? 'solid' : 'dotted'} ${style.color}`,
  opacity: shown ? 1 : 0.25,
});
const legend_style = { flex: '0 0 270px', maxWidth: 320, maxHeight: 620, overflowY: 'auto', fontSize: 12 };
const row_style = { display: 'flex', alignItems: 'center', width: '100%', padding: '3px 4px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', color: 'inherit', borderRadius: 3 };
const label_style = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const toolbar_style = { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 8 };

// - new_batch, ref_batch: the batches compared, with the runs the page's filters keep (.filtered.outputs)
// - controls.series: the options shared with the runs' cards (smoothing, log scale, by step or time), in the URL
const SeriesComparison = ({ new_batch, ref_batch, controls, onControlsChange, labels }) => {
  const [options, setOptions, preview] = useSeriesOptions(controls?.series, onControlsChange);
  const [hidden, setHidden] = useState(() => new Set());
  // The run under the pointer, in the list: its lines come forward in every plot. Not React state: Plotly restyles
  // the plots that are drawn, instead of React drawing them all again each time the pointer moves over the list
  const plots = useRef(new Map());
  const highlight = id => plots.current.forEach(element => restylePlot(element, highlight_update(element.data, id)));
  const register = key => element => element ? plots.current.set(key, element) : plots.current.delete(key);
  const [color_by, setColorBy] = useState('');
  const [filter, setFilter] = useState('');
  const [show_all, setShowAll] = useState(false);
  const [with_reference, setWithReference] = useState(false);

  // Only the runs started from code can have series: for the others we would ask for files that don't exist
  const candidates = useMemo(() => (new_batch?.filtered?.outputs ?? [])
    .map(id => new_batch.outputs[id])
    .filter(output => output && started_from_code(output) && !output.deleted && output.output_dir_url),
  [new_batch]);
  const outputs = candidates.slice(0, MAX_RUNS);
  const references = outputs.map(output => {
    const reference = ref_batch?.outputs?.[output.reference_id];
    return reference && reference.id !== output.id && !reference.deleted ? reference : undefined;
  });
  const has_references = references.some(Boolean);
  const queries = useQueries({ queries: outputs.map(series_query) });
  // several runs can share a reference run: one request each
  const reference_runs = with_reference ? [...new Map(references.filter(Boolean).map(reference => [reference.id, reference])).values()] : [];
  const reference_queries = useQueries({ queries: reference_runs.map(series_query) });
  const reference_models = new Map(reference_runs.map((reference, index) => [reference.id, reference_queries[index]?.data]));

  if (outputs.length === 0) return null;
  const loading = queries.some(query => query.isPending);
  // the runs that logged something
  const logged = outputs.map((output, index) => ({ output, model: queries[index].data, ref_model: references[index] ? reference_models.get(references[index].id) : null }))
    .filter(({ model }) => model && Object.keys(model.series).length > 0);
  if (logged.length === 0)
    return loading ? <Card style={{ marginTop: 12 }}><Spinner size={20} aria-label="Loading the runs' series"/></Card> : null;

  const logged_outputs = logged.map(({ output }) => output);
  const names = run_labels(logged_outputs);
  const params = varying_params(logged_outputs);
  const color_param = params.includes(color_by) ? color_by : '';
  const { styles, groups } = run_styles(logged_outputs, color_param);
  const runs = logged.map(({ output, model, ref_model }) => ({ id: output.id, label: names[output.id], style: styles[output.id], model, ref_model, output }));

  const counts = series_counts(runs.map(run => run.model));
  const keys = sorted_keys(Object.keys(counts));
  const needle = filter.trim().toLowerCase();
  const matching = needle ? keys.filter(key => key.toLowerCase().includes(needle)) : keys;
  const shown = show_all ? matching : matching.slice(0, SHOWN_AT_FIRST);
  const visible = runs.filter(run => !hidden.has(run.id));

  const toggle = id => setHidden(hidden => {
    const next = new Set(hidden);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const only = ids => setHidden(new Set(runs.filter(run => !ids.includes(run.id)).map(run => run.id)));
  const is_only = ids => visible.length === ids.length && ids.every(id => !hidden.has(id));

  const legend_row = run => {
    const is_shown = !hidden.has(run.id);
    return <div key={run.id} className="qa-series-run" style={{ display: 'flex', alignItems: 'center' }} onMouseEnter={() => is_shown && highlight(run.id)} onMouseLeave={() => highlight(null)}>
      <button
        type="button"
        style={row_style}
        aria-pressed={is_shown}
        aria-label={`${is_shown ? 'Hide' : 'Show'} ${run.label}`}
        title={`${run.label}: click to ${is_shown ? 'hide' : 'show'}`}
        onClick={() => toggle(run.id)}
      >
        <span style={swatch_style(run.style, is_shown)}/>
        <span style={{ ...label_style, opacity: is_shown ? 1 : 0.5, textDecoration: is_shown ? 'none' : 'line-through' }}>{run.label}</span>
        {run.output.is_running && <Tag minimal intent="primary" style={{ marginLeft: 4 }}>live</Tag>}
        {run.output.is_failed && <Tag minimal intent="danger" style={{ marginLeft: 4 }}>failed</Tag>}
      </button>
      <Button
        size="small" variant="minimal" className={Classes.TEXT_MUTED}
        aria-label={`Show only ${run.label}`}
        title={is_only([run.id]) ? 'Show all the runs' : 'Show only this run'}
        onClick={() => is_only([run.id]) ? setHidden(new Set()) : only([run.id])}
      >only</Button>
    </div>;
  };

  return <Card style={{ marginTop: 12 }} data-testid="series-comparison">
    <style>{'.qa-series-run:hover { background: var(--qa-hover); border-radius: 3px; }'}</style>
    <h4 className={Classes.HEADING} style={{ marginBottom: 10 }}>
      Logged series
      <span className={Classes.TEXT_MUTED} style={{ fontSize: 12, fontWeight: 'normal', marginLeft: 10 }}>
        {visible.length === runs.length ? `${runs.length} run${runs.length === 1 ? '' : 's'}` : `${visible.length} of ${runs.length} runs`}, {keys.length} series
      </span>
      {loading && <Spinner size={14} style={{ display: 'inline-block', marginLeft: 8 }} aria-label="Loading more runs"/>}
    </h4>
    {candidates.length > MAX_RUNS && <Callout compact icon="info-sign" style={{ marginBottom: 8 }}>
      Showing the first {MAX_RUNS} of {candidates.length} runs. Filter the runs at the top of the page to compare others.
    </Callout>}
    <div style={toolbar_style}>
      <SeriesOptions options={options} setOptions={setOptions} preview={preview}/>
      {params.length > 0 && <HTMLSelect
        minimal
        aria-label="Color the runs by"
        value={color_param}
        onChange={e => setColorBy(e.target.value)}
        options={[{ value: '', label: 'One color per run' }, ...params.map(param => ({ value: param, label: `Color by ${param}` }))]}
      />}
      {has_references && <Switch
        checked={with_reference}
        label={`With ${labels?.reference ?? 'the reference'}'s runs, dashed`}
        onChange={e => setWithReference(e.target.checked)}
        style={{ marginBottom: 0, fontSize: 12 }}
      />}
      {keys.length > 4 && <InputGroup size="small" leftIcon="search" placeholder="Filter series" value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 160 }}/>}
    </div>
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={legend_style} role="group" aria-label="Runs">
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          <Button size="small" variant="minimal" disabled={hidden.size === 0} onClick={() => setHidden(new Set())}>Show all</Button>
          <Button size="small" variant="minimal" disabled={visible.length === 0} onClick={() => setHidden(new Set(runs.map(run => run.id)))}>Hide all</Button>
        </div>
        {groups.length > 0
          ? groups.map(group => <div key={group.value} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', fontWeight: 600, padding: '2px 4px' }}>
                <span style={swatch_style(group.style, group.ids.some(id => !hidden.has(id)))}/>
                <span style={label_style} title={`${color_param} = ${group.value}`}>{color_param} = {group.value}</span>
                <Button
                  size="small" variant="minimal" className={Classes.TEXT_MUTED}
                  aria-label={`Show only ${color_param} = ${group.value}`}
                  onClick={() => is_only(group.ids) ? setHidden(new Set()) : only(group.ids)}
                >only</Button>
              </div>
              {runs.filter(run => group.ids.includes(run.id)).map(legend_row)}
            </div>)
          : runs.map(legend_row)}
      </div>
      <div style={{ flex: '1 1 0', minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {shown.map(key => <ComparisonPlot
            key={key}
            name={counts[key] < runs.length ? `${key} (${counts[key]} of ${runs.length} runs)` : key}
            options={options}
            many={visible.length > 6}
            register={register(key)}
            traces={comparison_traces(key, { runs, hidden, options, reference_name: labels?.reference ?? 'reference' })}
          />)}
        </div>
        {matching.length > shown.length && <Button size="small" variant="minimal" icon="chevron-down" onClick={() => setShowAll(true)}>
          Show the {matching.length - shown.length} other series
        </Button>}
        {needle && matching.length === 0 && <span className={Classes.TEXT_MUTED}>No series matches "{filter}".</span>}
        {visible.length === 0 && <p className={Classes.TEXT_MUTED}>Every run is hidden: click a run to show it.</p>}
      </div>
    </div>
  </Card>;
};

export default SeriesComparison;
