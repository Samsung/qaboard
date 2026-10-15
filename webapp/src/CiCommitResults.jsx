import { useEffect, useMemo, useState } from "react";
import styled from "styled-components";

import {
  Button,
  Classes,
  Card,
  NonIdealState,
  Spinner,
} from "@blueprintjs/core";

import { Container, Section } from "./components/layout";
import { MetricsSummary, MetricSelect } from "./components/metrics";
import { CommitWarningMessages, BatchStatusMessages } from "./components/messages";

import { TableCompare, TableKpi } from "./components/tables";
import { BatchLogs } from "./components/BatchLogs";
import { CommitParameters } from "./components/Parameters";
import { OutputCardsList } from "./viewers/OutputCardsList";
import { useComparison, useRefreshCommit, useSiteConfig, useUser, updateSelected } from "./hooks";
import { useDynamicOptions } from "./useDynamicOptions";


import { TuningForm } from "./components/tuning/forms";
import { BatchesEditor } from "./components/tuning/BatchesEditor";
import TuningExploration from "./components/tuning/TuningExploration";
import { useViewerControls } from "./viewers/controls";
import { ExportPlugin } from "./plugins/ExportPlugin";
import { humanFileSize } from "./viewers/bit_accuracy/utils";
import { project_web_url } from "./utils";

import PrivateContent from "./components/authentication/PrivateContent"
import FloatingControlsPanel from "./components/FloatingControlsPanel";


// Every view of the commit: its title (and maybe a few muted details) on one row above its content
const ViewSection = styled(Section)`
  margin-top: 0;
  margin-bottom: 32px;
`;
const ViewHeader = styled.div`
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-bottom: 12px;
  h2 {
    font-size: 20px;
    line-height: 28px;
    margin: 0;
  }
  p {
    margin: 0;
  }
`;
const ViewTitle = ({ title, children }) => <ViewHeader>
  <h2 className={Classes.HEADING}>{title}</h2>
  {children}
</ViewHeader>;

// The warnings and the batch's status: they take room only when they have something to say
const Messages = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* e.g. the <span/> of messages that have nothing to say: they would add gaps */
  & > :empty {
    display: none;
  }
  &:has(> :not(:empty)) {
    margin-bottom: 24px;
  }
`;

// Below the commit's header
const header_gap = 16;


const CiCommitResults = () => {
  const comparison = useComparison();
  const {
    project, selected, project_data, git, config, metrics, selected_metrics: selected_metrics_keys,
    new_commit, ref_commit, new_batch, ref_batch, selected_views, selected_batch_new, selected_batch_ref,
  } = comparison;
  const { new_project, ref_project, new_commit_id, ref_commit_id, filter_batch_new, filter_batch_ref } = selected;
  const { available_metrics } = metrics;
  const { docs_root } = useSiteConfig();
  const user = useUser();
  const refreshCommit = useRefreshCommit();

  useEffect(() => {
    const name = project.split('/').slice(-1)[0];
    if (!!new_commit_id)
      document.title = `${new_commit_id.slice(0, 4)} - ${name}`;
  }, [project, new_commit_id]);

  const [controls, setControls] = useViewerControls(config);
  // Registrations are reset when the commit or batch changes, or when the visualizations change.
  // Which visualizations have files is reset when the filter changes (but we keep registrations for performance).
  const visualizations_key = JSON.stringify(config.outputs?.visualizations || []);
  const dynamic = useDynamicOptions({
    config,
    reset_key: `${new_commit?.id}|${selected_batch_new}|${visualizations_key}`,
    files_key: filter_batch_new,
  });
  const [expand_floating_panel, setExpandFloatingPanel] = useState(false);
  useEffect(() => {
    if (!expand_floating_panel) return;
    // a short pulse: the panel expands, then can be collapsed
    const timer = setTimeout(() => setExpandFloatingPanel(false), 100);
    return () => clearTimeout(timer);
  }, [expand_floating_panel]);

  const toggle = name => () => setControls({ ...controls, [name]: !controls[name] });
  // Visualizations are shown unless hidden by default
  const is_shown = name => controls.show?.[name] ?? !visualizations.find(v => v.name === name)?.default_hidden;
  const toggle_show = name => () => setControls({ ...controls, show: { ...controls.show, [name]: !is_shown(name) } });
  const updateDynamicOption = (name, value) => setControls({
    ...controls,
    dynamic_options: { ...controls.dynamic_options, [name]: [value] },
  });
  // Dynamic options are synced across output cards unless users unlink them
  const toggleDynamicOptionSync = name => {
    const sync = controls.dynamic_options_sync?.[name] === false;
    setControls({ ...controls, dynamic_options_sync: { ...controls.dynamic_options_sync, [name]: sync ? undefined : false } });
    // the option is now changed from the panel
    if (sync) setExpandFloatingPanel(true);
  };

  const update = attribute => e => {
    const value = (e?.target && e.target.value !== undefined) ? e.target.value : e;
    updateSelected({ [attribute]: value }, { replace: attribute.startsWith('filter') || attribute.startsWith('sort') })
  }

  // The metrics shown in tables
  const selected_metrics = useMemo(
    () => selected_metrics_keys.map(m => available_metrics[m]).filter(Boolean),
    [selected_metrics_keys, available_metrics],
  );
  const metricTableSelect = <MetricSelect
    available_metrics={available_metrics}
    used_metrics={new_batch.used_metrics}
    selected={selected_metrics_keys}
    onChange={keys => updateSelected({ selected_metrics: keys }, { defaults: { selected_metrics: metrics.main_metrics } })}
  />;

  const warning_messages = <CommitWarningMessages project={new_project} commit={new_commit} />;
  const config_outputs = config.outputs || {};
  const controls_extra = config_outputs.controls || []
  // we allow both for some leeway with half updated projects
  const visualizations = [...(config_outputs.visualizations || []), ...(config_outputs.detailed_views || [])];
  const tuned_params = new_batch.sorted_extra_parameters.filter(p => new_batch.extra_parameters[p].size > 1)
  const has_tuning = tuned_params.length > 0
  const show_ref_navbar = !(selected_views.includes('logs') || selected_views.includes('tuning') || selected_views.includes('groups'))
  // TODO: migrate the availble-tests-files to DB
  const available_tests_files = { gr: "extra-batches", usr: user.user_name ?? null };
  const export_plugin = <ExportPlugin
    project={new_project}
    ref_project={ref_project}
    config={config}
    new_commit_id={new_commit?.id ?? new_commit_id}
    ref_commit_id={ref_commit?.id ?? ref_commit_id}
    selected_batch_new={selected_batch_new}
    selected_batch_ref={selected_batch_ref}
    filter_batch_new={filter_batch_new}
    filter_batch_ref={filter_batch_ref}
    batch_dir_url={new_batch.batch_dir_url}
  />;
  const output_cards_props = {
    project: new_project,
    config,
    metrics,
    new_commit,
    new_batch,
    ref_batch,
    controls,
    onRegisterOutputOptions: dynamic.register,
    onToggleDynamicOptionSync: toggleDynamicOptionSync,
  };
  const docs_link = <a target="_blank" rel="noopener noreferrer" href={`${docs_root}docs/visualizations`}>Read the docs</a>;

  // Until the commit loads, if it doesn't exist, or if it has no results yet, views of its results would look empty
  const has_batches = Object.keys(new_commit?.batches ?? {}).length > 0;
  const results_views = ['summary', 'table-compare', 'table-kpi', 'logs', 'output-list', 'bit-accuracy', 'optimization'];
  let commit_state = null;
  let hidden_views = [];
  const ci_docs_link = <a target="_blank" rel="noopener noreferrer" href={`${docs_root}docs/ci-integration`} style={{ whiteSpace: 'nowrap' }}>Set up your CI</a>;
  if (!!new_commit && !has_batches) {
    // Without a commit id, we show the latest commit with results on the reference branch: there may be none yet
    const no_commit_with_results = !new_commit_id && !!new_commit.error?.startsWith('404');
    const reference_branch = project_data?.data?.qatools_config?.project?.reference_branch;
    if (no_commit_with_results) {
      hidden_views = [...results_views, 'parameters'];
      commit_state = <NonIdealState
        icon="inbox"
        title={reference_branch ? <>No commit with results on <code>{reference_branch}</code> yet</> : "No commit with results yet"}
        description={<p>Results appear once <code>qa batch</code> runs in your CI. {ci_docs_link}</p>}
      />;
    } else if (new_commit.error) {
      hidden_views = [...results_views, 'parameters'];
      commit_state = <NonIdealState
        icon="error"
        title="Could not load this commit"
        description={<p>
          <code>{new_commit.error}</code>
          {new_commit.error.startsWith('4') && <><br/>Check the commit id, or whether its runs belong to another project.</>}
        </p>}
        action={<Button icon="refresh" text="Retry" onClick={() => refreshCommit(new_project, new_commit.id ?? null)}/>}
      />;
    } else if (!new_commit.is_loaded) {
      hidden_views = [...results_views, 'parameters'];
      commit_state = <NonIdealState icon={<Spinner/>} title="Loading the commit's results…"/>;
    } else {
      hidden_views = results_views;
      commit_state = <NonIdealState
        icon="inbox"
        title="No results for this commit yet"
        description={<p>
          Results appear once <code>qa batch</code> runs on this commit, usually in your CI.{" "}
          {ci_docs_link}
        </p>}
        action={<Button icon="play" text="Run tests on this commit" onClick={() => updateSelected({ selected_views: 'tuning' })}/>}
      />;
    }
  }
  // the views shown on the page
  const views = selected_views.filter(view => !hidden_views.includes(view));
  const shows_state = selected_views.some(view => hidden_views.includes(view));
  const storage = new_batch.filtered.outputs
    .map(id => new_batch.outputs[id]?.data?.storage ?? 0)
    .reduce((running_total, storage) => running_total + storage, 0);
  const nb_runs = new_batch.filtered.outputs.length;

  return (
    <Container style={{ marginTop: 0, paddingTop: (show_ref_navbar ? 150 : 75) + header_gap }}>

      {(!new_commit || !ref_commit) && show_ref_navbar && <Messages>
        {warning_messages}
      </Messages>}

      {(!!new_commit) && (
          <>
            <Messages key="filters">
              {warning_messages}
              {/* the selected batch's runs are unrelated to editing batch definitions, and would push the editor down */}
              {!selected_views.includes('groups') && <BatchStatusMessages project={new_project} commit={new_commit} batch={new_batch} />}
            </Messages>

            {shows_state && <ViewSection>{commit_state}</ViewSection>}

            {views.includes('summary') && <ViewSection>
              <ViewTitle title="Summary"/>
              <Card>
                <MetricsSummary
                  project={new_project}
                  project_data={project_data}
                  metrics={metrics}
                  available_metrics={available_metrics}
                  new_batch={new_batch}
                  ref_batch={ref_batch}
                />
              </Card>
             </ViewSection>}

            {views.includes('parameters') && <ViewSection>
              <ViewTitle title="Artifacts & Configs"/>
              <Card>
                <CommitParameters
                  project={new_project}
                  config={config}
                  new_commit={new_commit}
                  ref_commit={ref_commit}
                />
              </Card>
             </ViewSection>}

            {views.includes('groups') && <ViewSection style={{ width: 'auto', minWidth: 0 }}>
              <ViewTitle title="Available Tests"/>
              <PrivateContent enabled={true}>
                <BatchesEditor
                  project={project}
                  git={git}
                  web_url={(git?.web_url || git?.path_with_namespace) ? project_web_url(project_data) : undefined}
                  commit={new_commit}
                  config={config}
                  available_tests_files={available_tests_files}
                  docs_root={docs_root}
                />
              </PrivateContent>
            </ViewSection>}

            {views.includes('tuning') && <ViewSection>
              <ViewTitle title="Run Tests / Tuning"/>
              {Object.keys(config.artifacts || {}).length === 0
                ? <NonIdealState
                    icon="heatmap"
                    title="Running tests from the web app needs build artifacts"
                    description={<p>
                      QA-Board re-runs your code from the commit's saved build: declare which files to save as <code>artifacts</code> in <em>qaboard.yaml</em>.<br/>
                      <a target="_blank" rel="noopener noreferrer" href={`${docs_root}docs/storage/artifacts`}>Learn how to declare artifacts</a> and <a target="_blank" rel="noopener noreferrer" href={`${docs_root}docs/tuning-from-the-webapp`}>run tests from the web app</a>.
                    </p>}
                  />
                : <Card>
                  <PrivateContent enabled={true}>
                    <TuningForm
                    project={project}
                    git={git}
                    config={config}
                    metrics={metrics}
                    commit={new_commit}
                    available_tests_files={available_tests_files}
                    />
                  </PrivateContent>
                </Card>}
            </ViewSection>}

            {views.includes('table-compare') && <ViewSection>
              <ViewTitle title="Metrics Diff"/>
              <Card>
                  <TableCompare
                    new_batch={new_batch}
                    ref_batch={ref_batch}
                    metrics={selected_metrics_keys}
                    available_metrics={available_metrics}
                    input={metricTableSelect}
                  />
              </Card>
             </ViewSection>}

            {views.includes('table-kpi') && <ViewSection>
              <ViewTitle title="Metrics Table"/>
              <Card>
                  <TableKpi
                    new_batch={new_batch}
                    ref_batch={ref_batch}
                    metrics={selected_metrics_keys}
                    available_metrics={available_metrics}
                    input={metricTableSelect}
                  />
              </Card>
             </ViewSection>}

            {/* as wide as the page, not as its widest log line or run configuration.
                On the right, room for the floating panel's button: it would cover the runs' buttons */}
            {views.includes('logs') && <ViewSection style={{ width: 'auto', minWidth: 0, paddingRight: 30 }}>
                <ViewTitle title="Logs"/>
                <BatchLogs
                  project={new_project}
                  commit={new_commit}
                  batch={new_batch}
                  batch_label={new_batch.label}
                />
             </ViewSection>}

            {views.includes('output-list') && <ViewSection>
              <ViewTitle title="Visualizations"/>
              {visualizations.length === 0
                ? <NonIdealState
                    icon="heatmap"
                    title="Visualizations are not configured yet."
                    description={<p>{docs_link} to learn how to declare visualizations. Meanwhile, you can browse the files each run created.</p>}
                    action={<Button icon="folder-open" text="Show output files" onClick={() => updateSelected({ selected_views: 'bit-accuracy' })}/>}
                  />
                : <>
                  {export_plugin}
                  <OutputCardsList {...output_cards_props}/>
                </>}
            </ViewSection>}

            {views.includes('bit-accuracy') && <ViewSection>
                <ViewTitle title="Output Files">
                  <p className={Classes.TEXT_MUTED}>Storage used by the {nb_runs} run{nb_runs === 1 ? '' : 's'} shown: {humanFileSize(storage, true)}</p>
                </ViewTitle>
                {export_plugin}
                <OutputCardsList type='bit_accuracy' {...output_cards_props}/>
             </ViewSection>}

            {views.includes('optimization') && <ViewSection>
              <ViewTitle title="Tuning Analysis"/>
              <Card>
                <TuningExploration
                  project={new_project}
                  metrics={metrics}
                  available_metrics={available_metrics}
                  selected_metrics={selected_metrics_keys}
                  batch={new_batch}
                  input={metricTableSelect}
                  />
              </Card>
             </ViewSection>}

          </>
        )}

      {/* Only the views of the runs' results use the controls panel: elsewhere (editing batches, the tuning form...) it would
          only cover the page. Without results, there is nothing to control either. */}
      {(!!new_commit) && has_batches && views.some(view => results_views.includes(view)) && (
        <FloatingControlsPanel
          controls={controls}
          visualizations={visualizations}
          controls_extra={controls_extra}
          selected_views={selected_views}
          selected_metrics={selected_metrics}
          new_batch={new_batch}
          available_metrics={available_metrics}
          metricTableSelect={metricTableSelect}
          sort_by={selected.sort_by}
          sort_order={selected.sort_order}
          onToggle={toggle}
          onToggleShow={toggle_show}
          onUpdate={update}
          has_tuning={has_tuning}
          tuned_params={tuned_params}
          dynamic_options={dynamic.dynamic_options}
          onUpdateDynamicOption={updateDynamicOption}
          onToggleDynamicOptionSync={toggleDynamicOptionSync}
          visualizations_with_files={dynamic.visualizations_with_files}
          expandPanel={expand_floating_panel}
        />
      )}
    </Container>
  );
}

export default CiCommitResults;
