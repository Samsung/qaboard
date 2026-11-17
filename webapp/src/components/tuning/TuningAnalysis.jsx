// The Tuning Analysis view: what a batch that tried several parameters found.
// - an automated tuning (`qa optimize`): OptimizationReport.jsx
// - runs that differ by their parameters (a grid, a sampling, values tried by hand): TuningReport.jsx
// - anything else: how to get there, in three steps, and the commit's batches that have something to show
import { useMemo, useState } from "react";
import styled from "styled-components";
import { Button, Callout, Card, Classes, Collapse, Icon, Intent, NonIdealState, Spinner, Tag } from "@blueprintjs/core";

import { updateSelected, useSiteConfig } from "../../hooks";
import { usePrefsStore } from "../../stores/prefs";
import { metric_info } from "../../utils";
import { MetricsScript } from "../../plugins/ScriptPlugin";
import { analyze, is_tuning, tuning_kind } from "./analysis";
import { plural } from "./report";
import Learn from "./learn";
import OptimizationReport from "./OptimizationReport";
import TuningReport from "./TuningReport";

const Steps = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
  margin-top: 14px;
  h4 { display: flex; align-items: center; gap: 10px; margin: 0 0 6px; font-size: 15px; }
  p { margin: 0 0 10px; }
  .qa-tuning-step-number { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%;
    font-size: 12px; font-weight: 600; background: var(--qa-intent-primary); color: #fff; flex: none; }
  .qa-tuning-step-done { background: #238551; }
  .qa-tuning-step-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
`;

// What a batch found, in a few words
export const tuning_description = kind => kind.kind === 'automated'
  ? `automated tuning, ${plural(kind.evaluations, 'evaluation')}`
  : `${plural(kind.sets, 'parameter set')} of ${kind.parameters.slice(0, 3).join(', ')}${kind.parameters.length > 3 ? '…' : ''}`;

// The other batches of the commit that tried several parameters
const other_tunings = (commit, label) => Object.values(commit?.batches ?? {})
  .filter(batch => batch.label !== label)
  .map(batch => ({ batch, kind: tuning_kind(batch) }))
  .filter(({ kind }) => kind !== null);

const GetStarted = ({ batch, commit, project, commit_id, available_metrics, filtered_out }) => {
  const { docs_root } = useSiteConfig();
  const updateTuning = usePrefsStore(state => state.updateTuning);
  const [script, setScript] = useState(false);
  const tunings = useMemo(() => other_tunings(commit, batch.label), [commit, batch.label]);
  const runs = Object.values(batch.outputs ?? {});
  const returned = useMemo(() => {
    const keys = new Set();
    for (const output of Object.values(batch.outputs ?? {}))
      for (const [key, value] of Object.entries(output.metrics ?? {}))
        if (typeof value === 'number' && key !== 'is_failed' && key !== 'compute_time') keys.add(key);
    return [...keys];
  }, [batch.outputs]);
  const start = search_type => () => {
    updateTuning(project, { search_type });
    updateSelected({ selected_views: 'tuning' });
  };

  return <div data-testid="tuning-get-started">
    {filtered_out
      ? <Callout icon="filter" intent={Intent.PRIMARY} title="The filter leaves a single parameter set">
          <p>This batch tried {tuning_description(filtered_out)}, but the runs shown share the same parameters: there is nothing to compare.</p>
          <Button icon="filter-remove" text="Clear the filter" onClick={() => updateSelected({ filter_batch_new: '' })}/>
        </Callout>
      : <Callout icon="predictive-analysis" title={runs.length ? <>All the runs of <em>{batch.label}</em> use the same parameters</> : 'No runs to analyze'}>
          <p style={{ marginBottom: 0 }}>
            Tuning Analysis compares runs that tried different parameters: which values are best, which parameters matter, and what to try next.
          </p>
        </Callout>}

    {tunings.length > 0 && <Card compact style={{ marginTop: 12 }} data-testid="other-tunings">
      <h4 style={{ margin: '0 0 8px' }}>This commit has {plural(tunings.length, 'batch', 'batches')} to analyze</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
        {tunings.slice(0, 8).map(({ batch: other, kind }) => <Button
          key={other.label}
          variant="minimal"
          icon={kind.kind === 'automated' ? 'predictive-analysis' : 'properties'}
          endIcon="arrow-right"
          onClick={() => updateSelected({ selected_batch_new: other.label, filter_batch_new: '' })}
        >
          <strong>{other.label}</strong> <span className={Classes.TEXT_MUTED}>· {tuning_description(kind)}</span>
        </Button>)}
        {tunings.length > 8 && <span className={Classes.TEXT_MUTED}>And {tunings.length - 8} more, in the batch selector at the top.</span>}
      </div>
    </Card>}

    {!filtered_out && <>
      <h3 style={{ margin: '20px 0 0' }}>Find better parameters in three steps</h3>
      <Steps>
        <Card compact>
          <h4>
            <span className={`qa-tuning-step-number${returned.length ? ' qa-tuning-step-done' : ''}`} aria-hidden="true">{returned.length ? <Icon icon="tick" size={12}/> : 1}</span>
            Score your runs <Learn topic="metrics"/>
          </h4>
          {returned.length > 0
            ? <p>
                Done: the runs have {plural(returned.length, 'metric')}, like{' '}
                {returned.slice(0, 3).map((key, i) => <span key={key}>{i > 0 && ', '}<Tag minimal>{metric_info(available_metrics, key).label}</Tag></span>)}.
                Missing the one you care about? A script can add it to the runs you have.
              </p>
            : <p>
                Tuning compares parameters with <strong>metrics</strong>: numbers that score each run. These runs have none yet.
                A short script can add some to the runs you have, without running again.
              </p>}
          <div className="qa-tuning-step-actions">
            <Button icon="code" text={script ? 'Hide the script' : 'Add a metric with a script'} intent={returned.length ? Intent.NONE : Intent.PRIMARY} onClick={() => setScript(!script)} data-testid="show-metrics-script"/>
          </div>
        </Card>
        <Card compact>
          <h4><span className="qa-tuning-step-number" aria-hidden="true">2</span>Try other parameters <Learn topic="search"/></h4>
          <p>
            Run this commit again with other values. Choose them yourself, or say what to improve and let QA-Board search: it usually finds
            better values with fewer runs.
          </p>
          <div className="qa-tuning-step-actions">
            <Button icon="predictive-analysis" intent={returned.length ? Intent.PRIMARY : Intent.NONE} text="Search automatically…" onClick={start('optimize')} data-testid="start-automated"/>
            <Button icon="grid-view" text="Try values I choose…" onClick={start('grid')} data-testid="start-manual"/>
          </div>
        </Card>
        <Card compact>
          <h4><span className="qa-tuning-step-number" aria-hidden="true">3</span>Read the results here</h4>
          <p>
            Pick the new batch at the top of the page, and come back: this view shows the best parameters, how much each one matters,
            where they lose, and what to try next.
          </p>
          <div className="qa-tuning-step-actions">
            <a href={`${docs_root}docs/user-guide/tuning`} target="_blank" rel="noopener noreferrer">Tuning, step by step</a>
          </div>
        </Card>
      </Steps>
      <Collapse isOpen={script}>
        <Card compact style={{ marginTop: 12 }}>
          <MetricsScript project={project} commit_id={commit_id} batch={batch.label}/>
        </Card>
      </Collapse>
    </>}
  </div>;
};


const TuningAnalysis = ({ batch, commit, project, commit_id, available_metrics, selected_metrics }) => {
  const automated = !!batch?.data?.optimization;
  const outputs = useMemo(
    () => automated ? [] : (batch?.filtered?.outputs ?? []).map(id => batch.outputs[id]).filter(Boolean),
    [batch, automated],
  );
  const has_tuning = useMemo(() => is_tuning(analyze(outputs)), [outputs]);

  if (!batch)
    return <NonIdealState icon={<Spinner/>} title="Loading the runs…"/>;
  if (automated)
    return <OptimizationReport batch={batch} project={project} commit_id={commit_id} available_metrics={available_metrics}/>;
  if (has_tuning)
    return <TuningReport batch={batch} outputs={outputs} project={project} commit_id={commit_id} available_metrics={available_metrics} selected_metrics={selected_metrics}/>;
  // the filter may hide what the batch tried
  const unfiltered = outputs.length < Object.keys(batch.outputs ?? {}).length ? tuning_kind(batch) : null;
  return <GetStarted batch={batch} commit={commit} project={project} commit_id={commit_id} available_metrics={available_metrics} filtered_out={unfiltered}/>;
};

export default TuningAnalysis;
