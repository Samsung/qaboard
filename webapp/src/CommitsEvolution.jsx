import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import Plot from "./components/Plot";
import {
  Callout,
  Classes,
  HTMLSelect,
  NonIdealState,
  Tag,
  Tooltip,
  Colors,
  Intent,
  FormGroup,
  Switch
} from "@blueprintjs/core";

import { useSelected, useSiteConfig, useUrlText, updateSelected } from "./hooks";
import { OutputCard } from "./viewers/OutputCard";
import { useViewerControls } from "./viewers/controls";
import { BitAccuracyForm, bit_accuracy_url_defaults } from "./viewers/bit_accuracy/utils";
import { hash_color, match_query, average, median, matching_output } from "./utils";
import { yAxisSuffix, hasAllMetrics } from "./evolutionAxis";
import CommitRow from "./components/CommitRow";


// As wide as its container
let default_layout = {
  margin: {
    // will eat into the drawing area
    l: 40,
    r: 30,
    b: 40,
    t: 0,
    pad: 0
  },
  autosize: true,
  yaxis: {
    showgrid: false,
    showline: false,
    // the margin grows to fit the tick labels: the top one has the unit, e.g. "1000 ms"
    automargin: true,
  },
  hovermode: "closest",
  hoverinfo: "y",
  hoverlabel: {
    namelength: -1
  },
  legend: {
    "y": 0.01,
  },
};


const make_output_filter = output_filter => {
  const matcher = match_query(output_filter)
  return o => {
    if (o.is_pending) return false;
    if (output_filter.length === 0) return true;
    let metadata_s = Object.keys(o.test_input_metadata ?? {}).length > 0 ? JSON.stringify(o.test_input_metadata) : "";
    let searched = `${o.test_input_path} ${o.platform} ${metadata_s} ${JSON.stringify(o.configurations)}`.replace(/"/g, "");
    return matcher(searched)
  };
};


// A copy of the commit, with only the outputs that match the filter, and their counts
const filter_commit_outputs = (commit, output_filter) => {
  if (!commit) return commit;
  const batches = Object.fromEntries(Object.entries(commit.batches).map(([label, batch]) => {
    const outputs = Object.fromEntries(Object.entries(batch.outputs || {}).filter(([, o]) => output_filter(o)));
    const values = Object.values(outputs);
    return [label, {
      ...batch,
      outputs,
      pending_outputs: values.filter(o => o.is_pending).length,
      failed_outputs: values.filter(o => !o.is_pending && o.is_failed).length,
      valid_outputs: values.filter(o => !o.is_pending && !o.is_failed).length,
    }];
  }));
  return { ...commit, batches };
};


const color_line = { default: Colors.BLUE3 };
const color_marker = { default: Colors.BLUE2 };

// One trace per batch: a metric aggregated over all the outputs
const traces_per_batch = ({ commits, metrics, aggregation, available_metrics, per_output_granularity, output_filter, shown_batches }) => {
  let shown_aggregation = aggregation || "median";
  let traces = [];
  let traces_metadata = [];
  const output_filter_ = per_output_granularity ? make_output_filter(output_filter) : null;
  metrics.forEach(key => {
    let metric = available_metrics[key];
    if (metric === undefined)
      return
    shown_batches.forEach(label => {
      const commits_with_batch = per_output_granularity
        ? commits.filter(c => !!c.batches[label])
        : commits.filter(c => hasAllMetrics(c, label, metrics, shown_aggregation));
      if (commits_with_batch.length === 0) return;
      let y;
      if (!per_output_granularity) {
        y = commits_with_batch.map(c => c.batches[label].aggregated_metrics[`${metric.key}_${shown_aggregation}`])
      } else {
        let aggregation_func = shown_aggregation === 'median' ? median : average;
        y = commits_with_batch
              .map(c => Object.values(c.batches[label].outputs || {}).filter(output_filter_))
              .map(outputs => aggregation_func(outputs.map(o => o.metrics[metric.key])))
      }
      // remove NaN
      y = y.map(x => (x === undefined || x === null || isNaN(x)) ? null : x)
      traces.push({
        name: `${label === "default" ? "CI" : label} ${metrics.length > 1 ? metric.label : ""}`,
        type: "scatter",
        mode: "lines+markers",
        x: commits_with_batch.map(c => c.authored_datetime),
        y,
        text: commits_with_batch.map(c => c.message),
        marker: { size: 10, color: color_marker[label] },
        line: { width: 2, color: color_line[label] },
      });
      traces_metadata.push({ label, commits: commits_with_batch });
    });
  });
  return { traces, traces_metadata };
}

// One trace per test (input+configuration)
const traces_per_test = ({ commits, metrics, available_metrics, output_filter, relative, shown_batches }) => {
  const output_filter_ = make_output_filter(output_filter);
  let traces = [];
  let traces_metadata = [];
  metrics.forEach(key => {
    let metric = available_metrics[key];
    if (metric === undefined)
      return
    shown_batches.forEach(label => {
      const commits_with_batch = commits.filter(c => !!c.batches[label]);
      // test => commit => first matching output, computed in one pass
      const by_test = new Map();
      commits_with_batch.forEach(c => {
        Object.values(c.batches[label].outputs || {})
          .filter(output_filter_)
          .forEach(o => {
            const test = JSON.stringify([o.test_input_path, o.configurations]);
            if (!by_test.has(test)) by_test.set(test, new Map());
            const outputs = by_test.get(test);
            if (!outputs.has(c)) outputs.set(c, o);
          });
      });
      by_test.forEach((outputs, test) => {
        const [test_input_path, configurations] = JSON.parse(test);
        const valid = m => !(isNaN(m) || m === null || m === undefined);
        const commits_with_output = commits_with_batch.filter(c => outputs.has(c) && valid(outputs.get(c).metrics[metric.key]));
        const values = commits_with_output.map(c => outputs.get(c).metrics[metric.key] * metric.scale);
        const y0 = values[values.length - 1];
        const y = (relative && !!y0) ? values.map(v => 100 * v / y0) : values;
        const color = hash_color(test_input_path, label);
        traces.push({
          name: `${test_input_path} @${JSON.stringify(configurations)}`,
          type: "scatter",
          mode: "lines+markers",
          x: commits_with_output.map(c => c.authored_datetime),
          y,
          marker: { size: 7, color, opacity: 0.95 },
          line: { width: 3, color, dash: label === "default" ? "solid" : "dot", opacity: 0.5 },
          legendgroup: test_input_path,
          showlegend: false,
          connectgap: true,
        });
        traces_metadata.push({ test_input_path, configurations, label, commits: commits_with_output });
      });
    });
  });
  return { traces, traces_metadata };
}


const commit_line = (commit, color) => ({
  type: "line",
  layer: "below",
  xref: "x",
  x0: commit.authored_datetime,
  x1: commit.authored_datetime,
  yref: "paper",
  y0: 0,
  y1: 1,
  line: { color, width: 3, dash: "dashdot" },
});

const make_layout = ({ metric = {}, aggregation, relative, hovered_commit, hovered_commit_ref }) => {
  const threshold = metric.target * metric.scale;
  const shapes = [];
  if (!relative && !!threshold)
    shapes.push({
      type: "line",
      layer: "below",
      xref: "paper",
      x0: 0,
      x1: 1,
      yref: "y",
      y0: threshold,
      y1: threshold,
      line: { color: "rgba(150, 150, 150, 0.5)", width: 3, dash: "dashdot" },
    })
  if (!!hovered_commit)
    shapes.push(commit_line(hovered_commit, "rgba(217, 130, 43, 0.5)"))
  if (!!hovered_commit_ref)
    shapes.push(commit_line(hovered_commit_ref, "rgba(19, 124, 189, 0.5)"))
  return {
    ...default_layout,
    // plotly keeps the user's zoom and pan while the uirevision doesn't change
    uirevision: 'evolution',
    height: !!aggregation ? 180 : 250,
    yaxis: {
      ...default_layout.yaxis,
      ticksuffix: yAxisSuffix(metric, relative),
      showticksuffix: 'last',
      type: metric.plot_scale || 'linear',
    },
    shapes,
  };
}


const CommitsEvolutionPerTest = props => {
  const {
    project,
    project_data,
    commits,
    new_commit,
    ref_commit,
    shown_batches,
    metrics,
    output_filter = '',
    aggregation,
    per_output_granularity,
    relative,
    show_bit_accuracy,
    available_metrics = {},
    onSelect,
  } = props;
  const qatools_config = project_data?.data?.qatools_config;

  const [hovered, setHovered] = useState({ label: null, test_input_path: "", configurations: "" });
  const [hovered_commit, setHoveredCommit] = useState(undefined);
  const [hovered_commit_ref, setHoveredCommitRef] = useState(undefined);
  // after a click, the reference stays the same
  const [selected_ref, setSelectedRef] = useState(false);

  // controls of the output viewers
  const [controls, updateControls] = useViewerControls(qatools_config);

  const { traces, traces_metadata } = useMemo(() => {
    const params = { commits, metrics, aggregation, available_metrics, per_output_granularity, output_filter, relative, shown_batches };
    return !!aggregation ? traces_per_batch(params) : traces_per_test(params);
  }, [commits, metrics, aggregation, available_metrics, per_output_granularity, output_filter, relative, shown_batches]);

  const shown_commit = hovered_commit ?? new_commit;
  const shown_commit_ref = hovered_commit_ref ?? ref_commit;
  const layout = useMemo(
    () => make_layout({ metric: available_metrics[metrics[0]], aggregation, relative, hovered_commit: shown_commit, hovered_commit_ref: shown_commit_ref }),
    [available_metrics, metrics, aggregation, relative, shown_commit, shown_commit_ref],
  );

  // Moving over the plot hovers many points: the page shows the commits once the pointer pauses on one
  const select_timer = useRef(null);
  useEffect(() => () => clearTimeout(select_timer.current), []);
  const onHover = e => {
    const { pointNumber: point_number, curveNumber: curve_number } = e.points[0];
    // when not doing per-input display, test_input_path and configuration will be undefined
    const { label, test_input_path, configurations, commits } = traces_metadata[curve_number];
    const commit = commits[point_number];
    const commit_ref = point_number < commits.length ? commits[point_number + 1] : null;
    const update_ref = !selected_ref && !!commit_ref;
    clearTimeout(select_timer.current);
    select_timer.current = setTimeout(() => onSelect?.({ new_commit_id: commit.id, ...(update_ref ? { ref_commit_id: commit_ref.id } : {}) }), 150);
    setHovered({ label, test_input_path, configurations });
    setHoveredCommit(commit);
    if (update_ref) setHoveredCommitRef(commit_ref);
  };
  const onClick = e => {
    const { pointNumber: point_number, curveNumber: curve_number } = e.points[0];
    const { label, test_input_path, configurations, commits } = traces_metadata[curve_number];
    const commit = commits[point_number];
    clearTimeout(select_timer.current);
    onSelect?.({ ref_commit_id: commit.id, new_commit_id: commit.id });
    setSelectedRef(true);
    setHovered({ label, test_input_path, configurations });
    setHoveredCommit(commit);
    setHoveredCommitRef(commit);
  };

  const toggle = name => () => updateControls({ ...controls, [name]: !controls[name] });
  const toggle_show = name => () => updateControls({ ...controls, show: { ...controls.show, [name]: !controls.show[name] } });

  // With a filter, the commits' counts are only about the outputs that match
  const legend_commits = useMemo(() => {
    if (!aggregation || !per_output_granularity || output_filter.length === 0)
      return [shown_commit, shown_commit_ref];
    const output_filter_ = make_output_filter(output_filter);
    return [filter_commit_outputs(shown_commit, output_filter_), filter_commit_outputs(shown_commit_ref, output_filter_)];
  }, [aggregation, per_output_granularity, output_filter, shown_commit, shown_commit_ref]);

  let legend = null;
  if (!!shown_commit) {
    const { label: hovered_label, test_input_path: hovered_test_input_path, configurations: hovered_test_configurations } = hovered;
    const hovered_test_configurations_str = JSON.stringify(hovered_test_configurations);
    const hovered_output = Object.values(shown_commit.batches[hovered_label]?.outputs || {})
      .find(o => o.test_input_path === hovered_test_input_path && o.configurations_str === hovered_test_configurations_str);
    const ref_batch = shown_commit_ref?.batches[hovered_label];
    const { output_ref, mismatch } = (hovered_output && ref_batch)
      ? matching_output({ output: hovered_output, batch: ref_batch })
      : { output_ref: undefined, mismatch: null };
    const controls_extra = qatools_config?.outputs?.controls || []
    const visualizations = qatools_config?.outputs?.visualizations || qatools_config?.outputs?.detailed_views || []
    const controls_switches = <>
      {!show_bit_accuracy && visualizations.map((view, idx) => {
        if (!view.default_hidden || controls.show?.[view.name] === undefined || controls.show?.[view.name] === null)
          return <Fragment key={idx}></Fragment>
        return <Switch
                style={{marginRight: "8px"}}
                key={idx}
                checked={controls.show[view.name]}
                onChange={toggle_show(view.name)}
                label={view.label || view.name || view.path}
               />
      })}
      {controls_extra.map(control => <Switch
          style={{marginRight: "8px"}}
          key={control.name}
          checked={controls[control.name]}
          onChange={toggle(control.name)}
          label={control.label || control.name}
        />
      )}
    </>
    const [legend_commit, legend_commit_ref] = legend_commits;
    legend = <div style={{ marginTop: "30px", background: "var(--qa-surface)", padding: "10px" }}>
      {hovered_test_input_path && <Tag style={{ background: hash_color(hovered_test_input_path) }}>
          {hovered_test_input_path} @{JSON.stringify(hovered_test_configurations)}
      </Tag>}
      <CommitRow
        default_batch={hovered_label}
        commit={legend_commit}
        project={project}
        project_data={project_data}
        tag={<Tag style={{marginRight: '8px'}} intent={Intent.WARNING}>New</Tag>}
      />
      {!!legend_commit_ref && <div><CommitRow
        default_batch={hovered_label}
        commit={legend_commit_ref}
        project={project}
        project_data={project_data}
        tag={<Tag style={{marginRight: '8px'}} intent={Intent.PRIMARY}>Reference</Tag>}
      /></div>}
      {!aggregation && <div style={{display: 'flex', flex: '0 0 auto'}}>{controls_switches}</div>}
      {!!hovered_output && <OutputCard
        project={project}
        config={qatools_config}
        metrics={project_data.data?.qatools_metrics}
        commit={shown_commit}
        output_new={hovered_output}
        output_ref={output_ref?.id ? output_ref : undefined}
        mismatch={mismatch}
        style={{ width: '100%', maxWidth: '1180px', height: '300px' }}
        no_header={true}
        type={show_bit_accuracy ? 'bit_accuracy' : undefined}
        show_all_files={props.show_all_files}
        expand_all={props.expand_all}
        files_filter={props.files_filter}
        controls={controls}
        onControlsChange={changes => updateControls(controls => ({ ...controls, ...changes }))}
      />}
    </div>;
  }

  // e.g. when the metric is new, or the filter matches no runs
  const has_data = traces.some(t => t.y.some(v => v !== null));
  if (!has_data) {
    // pages say already when there are no commits
    if (commits.length === 0) return null;
    const metric_label = available_metrics[metrics[0]]?.label ?? metrics[0];
    return <NonIdealState
      icon="timeline-line-chart"
      title="Nothing to plot"
      description={<span>
        No commit in this range has <strong>{metric_label}</strong> for {shown_batches.length > 1 ? 'these batches' : 'this batch'}
        {output_filter.length > 0 && <> and runs that match the filter</>}.
        {" "}Try another metric or a longer date range.
      </span>}
    />;
  }

  return (
    <div>
      <Plot
        data={traces}
        layout={layout}
        useResizeHandler
        style={{ width: '100%' }}
        onHover={onHover}
        onClick={onClick}
        onDoubleClick={() => setSelectedRef(false)}
      />
      <p className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
        {!!aggregation
          ? <span>The performance for each commit may not be evaluated on the same tests</span>
          : <span>Hover over a run to see {show_bit_accuracy
                                           ? `the files it created `
                                           : `its visualizations `}
                compared to the previous commit. Click on a commit to freeze it as a reference, double-click to unfreeze it.</span>
        }
      </p>
      {legend}
    </div>
  );
}


// The plot's options are kept in the URL
const CommitsEvolution = ({ project, project_data, commits = [], new_commit, ref_commit, style, default_breakdown_per_test, output_filter, per_output_granularity, shown_batches, select_metrics, onSelect }) => {
  const { query } = useSelected();
  const { docs_root } = useSiteConfig();
  const { available_metrics = {}, main_metrics = [], default_metric } = project_data?.data?.qatools_metrics || {};
  const flag = (name, default_value) => query[name] !== undefined ? query[name] === 'true' : default_value;

  const selected_metric = query.selected_metric || default_metric;
  const selected_aggregation = query.selected_aggregation || "median";
  const breakdown_per_test = flag('breakdown_per_test', !!default_breakdown_per_test);
  const relative = flag('relative', default_breakdown_per_test !== true);
  const show_bit_accuracy = flag('show_bit_accuracy', false);
  const metrics = useMemo(() => !!selected_metric ? [selected_metric] : [], [selected_metric]);
  const batches = useMemo(
    () => shown_batches || Object.keys(commits[0]?.batches || {}),
    [shown_batches, commits],
  );

  // Changing the plot's options doesn't add browser history entries, and default values are not in the URL
  const url_defaults = {
    ...bit_accuracy_url_defaults,
    selected_metric: default_metric,
    selected_aggregation: 'median',
    breakdown_per_test: !!default_breakdown_per_test,
    relative: default_breakdown_per_test !== true,
    show_bit_accuracy: false,
  };
  const save = (name, value) => updateSelected({ [name]: value }, { replace: true, defaults: url_defaults });
  const update = name => e => save(name, (e?.target && e.target.value !== undefined) ? e.target.value : e);
  const [files_filter, onFilesFilterChange] = useUrlText(query.files_filter || '', update('files_filter'));
  const toggle = name => () => {
    const values = { breakdown_per_test, relative, show_bit_accuracy };
    save(name, !(values[name] ?? query[name] === 'true'));
  };

  if (!default_metric)
    return <Callout icon="timeline-line-chart" title="No metrics to plot">
      To see metrics over time, <a target="_blank" rel="noopener noreferrer" href={`${docs_root}docs/computing-quantitative-metrics`}>define your project's metrics</a>.
    </Callout>;

  const offer_breakdown_per_test = default_breakdown_per_test !== undefined && default_breakdown_per_test !== null;
  return (
    <div style={style}>
      <FormGroup inline>
        <HTMLSelect
          id="select-metric"
          aria-label="Metric"
          value={selected_metric}
          onChange={update("selected_metric")}
          minimal
        >
          {(select_metrics || main_metrics).map(m => (
            <option key={m} value={m}>
              {available_metrics[m]?.label ?? m}
            </option>
          ))}
        </HTMLSelect>
        {!breakdown_per_test && (
          <HTMLSelect
            id="select-aggregation"
            aria-label="Aggregation over the tests"
            value={selected_aggregation}
            onChange={update("selected_aggregation")}
            minimal
          >
            <option key="median" value="median">median</option>
            <option key="average" value="average">average</option>
          </HTMLSelect>
        )}
        {offer_breakdown_per_test && (
          <Switch
            inline
            label="Breakdown per test"
            checked={breakdown_per_test}
            onChange={toggle("breakdown_per_test")}
          />
        )}
        {offer_breakdown_per_test && breakdown_per_test && (
          <Fragment>
            <Switch
              inline
              labelElement={<Tooltip content="Each test's values as a % of its value at the oldest commit shown">
                <span>Relative to start (@100)</span>
              </Tooltip>}
              checked={relative}
              onChange={toggle("relative")}
            />
            <Switch
              inline
              label="Show output files"
              checked={show_bit_accuracy}
              onChange={toggle("show_bit_accuracy")}
            />
          </Fragment>
        )}
      </FormGroup>
      <CommitsEvolutionPerTest
        project={project}
        project_data={project_data}
        commits={commits}
        new_commit={new_commit}
        ref_commit={ref_commit}
        shown_batches={batches}
        metrics={metrics}
        output_filter={output_filter}
        aggregation={breakdown_per_test ? null : selected_aggregation}
        per_output_granularity={per_output_granularity}
        relative={relative}
        show_bit_accuracy={show_bit_accuracy}
        available_metrics={available_metrics}
        show_all_files={query.show_all_files === 'true'}
        expand_all={query.expand_all === 'true'}
        files_filter={query.files_filter || ''}
        onSelect={onSelect}
      />
      {show_bit_accuracy && <BitAccuracyForm
        show_all_files={query.show_all_files === 'true'}
        hide_runs_without_files={query.hide_runs_without_files === 'true'}
        expand_all={query.expand_all === 'true'}
        files_filter={files_filter}
        toggle={name => () => save(name, query[name] !== 'true')}
        update={name => name === 'files_filter' ? onFilesFilterChange : update(name)}
      />}
    </div>
  );
}

export default CommitsEvolution;
