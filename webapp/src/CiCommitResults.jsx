import { useEffect, useMemo, useState } from "react";
import styled from "styled-components";

import {
  Button,
  Classes,
  Card,
  NonIdealState,
  Spinner,
} from "@blueprintjs/core";

import { Container, Section, commit_header_height, shows_reference_bar } from "./components/layout";
import { MetricsSummary, MetricSelect } from "./components/metrics";
import { CommitWarningMessages, BatchStatusMessages } from "./components/messages";

import { TableCompare, TableKpi } from "./components/tables";
import { BatchLogs } from "./components/BatchLogs";
import { CommitParameters } from "./components/Parameters";
import { OutputCardsList } from "./viewers/OutputCardsList";
import { useComparison, useRefreshCommit, useSelected, useSiteConfig, useUser, updateSelected } from "./hooks";
import { useDynamicOptions } from "./useDynamicOptions";


import { TuningForm } from "./components/tuning/forms";
import { BatchesEditor } from "./components/tuning/BatchesEditor";
import TuningExploration from "./components/tuning/TuningExploration";
import { useViewerControls, controls_changes, controls_defaults, config_visualizations } from "./viewers/controls";
import { ExportPlugin } from "./plugins/ExportPlugin";
import { humanFileSize, file_options as file_options_list, bit_accuracy_url_defaults } from "./viewers/bit_accuracy/utils";
import { project_web_url } from "./utils";

import PrivateContent from "./components/authentication/PrivateContent"
import ViewOptionsPanel from "./components/ViewOptionsPanel";
import { useSidePanelExpanded } from "./components/SidePanel";
import { SharedConfigurationContext } from "./configurations/ConfigurationsTags";
import { ConfigurationOverview } from "./configurations/ConfigurationOverview";
import { shared_configuration, reference_pairs, changes_in_all_runs } from "./configurations/tokens";


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
// Actions on the view, e.g. Export, go to the right of its title
const ViewActions = styled.div`
  margin-left: auto;
  align-self: center;
  display: flex;
  gap: 8px;
`;
const ViewTitle = ({ title, actions, children }) => <ViewHeader>
  <h2 className={Classes.HEADING}>{title}</h2>
  {children}
  {actions && <ViewActions>{actions}</ViewActions>}
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
  const visualizations_key = JSON.stringify(config_visualizations(config.outputs));
  const dynamic = useDynamicOptions({
    config,
    reset_key: `${new_commit?.id}|${selected_batch_new}|${visualizations_key}`,
    files_key: filter_batch_new,
  });
  // The view options, docked on the right: open or collapsed
  const [view_options_expanded, setViewOptionsExpanded] = useSidePanelExpanded();
  // incremented to bring their Files to show into view
  const [reveal_files, setRevealFiles] = useState(0);
  // a section of the view options to open and bring into view: { id }, a new object each time
  const [reveal_section, setRevealSection] = useState(null);

  // The output files' options, in the URL like their filter (see OutputCardsList)
  const { query } = useSelected();
  const file_options = Object.fromEntries(file_options_list.map(({ name }) => [name, query[name] === 'true']));
  const has_file_options = Object.values(file_options).some(Boolean);
  const saveFileOptions = changes => updateSelected(changes, { replace: true, defaults: bit_accuracy_url_defaults });
  const toggleFileOption = name => () => saveFileOptions({ [name]: !file_options[name] });
  const showFileOptions = () => {
    setViewOptionsExpanded(true);
    setRevealSection({ id: 'files' });
  };

  const toggle = name => () => setControls({ ...controls, [name]: !controls[name] });
  // e.g. how image viewers compare images, set from any of them
  const updateControls = changes => setControls(controls => ({ ...controls, ...changes }));
  // Visualizations are shown unless hidden by default
  const is_shown = name => controls.show?.[name] ?? !visualizations.find(v => v.name === name)?.default_hidden;
  const toggle_show = name => () => setControls({ ...controls, show: { ...controls.show, [name]: !is_shown(name) } });
  const updateDynamicOption = (name, value) => setControls({
    ...controls,
    dynamic_options: { ...controls.dynamic_options, [name]: [value] },
  });
  const resetDynamicOption = name => setControls({
    ...controls,
    dynamic_options: { ...controls.dynamic_options, [name]: undefined },
  });
  // What users changed, e.g. visualizations shown or dynamic options, can be reset to the project's defaults
  const has_controls_changes = Object.keys(controls_changes(controls, controls_defaults(config, ''))).length > 0 || has_file_options;
  const resetControls = () => {
    setControls(controls_defaults(config, ''));
    saveFileOptions(Object.fromEntries(file_options_list.map(({ name }) => [name, false])));
  };
  // Dynamic options are synced across output cards unless users unlink them
  const toggleDynamicOptionSync = name => {
    const sync = controls.dynamic_options_sync?.[name] === false;
    setControls({ ...controls, dynamic_options_sync: { ...controls.dynamic_options_sync, [name]: sync ? undefined : false } });
    // the option is now changed from the view options
    if (sync) {
      setViewOptionsExpanded(true);
      setRevealFiles(count => count + 1);
    }
  };

  const update = attribute => e => {
    const value = (e?.target && e.target.value !== undefined) ? e.target.value : e;
    updateSelected({ [attribute]: value }, { replace: attribute.startsWith('filter') || attribute.startsWith('sort') })
  }

  // The metrics shown in tables
  const metricTableSelect = <MetricSelect
    available_metrics={available_metrics}
    used_metrics={new_batch.used_metrics}
    selected={selected_metrics_keys}
    onChange={keys => updateSelected({ selected_metrics: keys }, { defaults: { selected_metrics: metrics.main_metrics } })}
  />;

  const warning_messages = <CommitWarningMessages project={new_project} commit={new_commit} />;
  const config_outputs = config.outputs || {};
  const controls_extra = config_outputs.controls || []
  const visualizations = config_visualizations(config_outputs);
  const tuned_params = new_batch.sorted_extra_parameters.filter(p => new_batch.extra_parameters[p].size > 1)
  const has_tuning = tuned_params.length > 0
  const show_ref_navbar = shows_reference_bar(selected_views)
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
    onControlsChange: updateControls,
    onRegisterOutputOptions: dynamic.register,
    onToggleDynamicOptionSync: toggleDynamicOptionSync,
    // what viewers call the new and reference results, e.g. their milestones' names
    labels: comparison.labels,
  };
  // the tables' columns: [new, reference]
  const { new: label_new, reference: label_ref } = comparison.labels;
  const table_labels = useMemo(() => [label_new, label_ref], [label_new, label_ref]);
  // What the runs shown share is hidden in each run: it updates as users filter runs.
  // shared_configuration and changes_in_all_runs return the same objects when they don't change, so cards don't re-render
  const shared_settings = shared_configuration(new_batch.filtered.outputs.map(id => new_batch.outputs[id]));
  const all_runs_changes = changes_in_all_runs(reference_pairs(new_batch));
  const shared = useMemo(
    () => shared_settings && { ...shared_settings, changes_in_all_runs: all_runs_changes },
    [shared_settings, all_runs_changes],
  );
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
  const shows_runs = ['output-list', 'bit-accuracy', 'table-compare', 'table-kpi'].some(view => views.includes(view));
  const shows_state = selected_views.some(view => hidden_views.includes(view));
  const storage = new_batch.filtered.outputs
    .map(id => new_batch.outputs[id]?.data?.storage ?? 0)
    .reduce((running_total, storage) => running_total + storage, 0);
  const nb_runs = new_batch.filtered.outputs.length;
  // the commits' fixed headers
  const header_height = commit_header_height({ selected_views, references: comparison.references });

  return (
    <SharedConfigurationContext value={shared}>
    <Container style={{ marginTop: 0, paddingTop: header_height + header_gap }}>

      {(!new_commit || !ref_commit) && show_ref_navbar && <Messages>
        {warning_messages}
      </Messages>}

      {(!!new_commit) && (
          <>
            <Messages key="filters">
              {warning_messages}
              {/* the selected batch's runs are unrelated to editing batch definitions, and would push the editor down */}
              {!selected_views.includes('groups') && <BatchStatusMessages project={new_project} commit={new_commit} batch={new_batch} />}
              {shows_runs && <ConfigurationOverview new_batch={new_batch} />}
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
                  labels={comparison.labels}
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
                    labels={table_labels}
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
                    labels={table_labels}
                  />
              </Card>
             </ViewSection>}

            {/* as wide as the page, not as its widest log line or run configuration */}
            {views.includes('logs') && <ViewSection style={{ width: 'auto', minWidth: 0 }}>
                <ViewTitle title="Logs"/>
                <BatchLogs
                  project={new_project}
                  commit={new_commit}
                  batch={new_batch}
                  batch_label={new_batch.label}
                />
             </ViewSection>}

            {views.includes('output-list') && <ViewSection>
              <ViewTitle title="Visualizations" actions={visualizations.length > 0 && export_plugin}/>
              {visualizations.length === 0
                ? <NonIdealState
                    icon="heatmap"
                    title="Visualizations are not configured yet."
                    description={<p>{docs_link} to learn how to declare visualizations. Meanwhile, you can browse the files each run created.</p>}
                    action={<Button icon="folder-open" text="Show output files" onClick={() => updateSelected({ selected_views: 'bit-accuracy' })}/>}
                  />
                : <OutputCardsList {...output_cards_props}/>}
            </ViewSection>}

            {views.includes('bit-accuracy') && <ViewSection>
                <ViewTitle title="Output Files" actions={export_plugin}>
                  <p className={Classes.TEXT_MUTED}>Storage used by the {nb_runs} run{nb_runs === 1 ? '' : 's'} shown: {humanFileSize(storage, true)}</p>
                </ViewTitle>
                <OutputCardsList type='bit_accuracy' {...output_cards_props} onShowFileOptions={showFileOptions}/>
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

      {/* Only the views of the runs' results have view options: elsewhere (editing batches, the tuning form...) they would
          only take room. Without results, there is nothing to change either. */}
      {(!!new_commit) && has_batches && views.some(view => results_views.includes(view)) && (
        <ViewOptionsPanel
          top={header_height}
          controls={controls}
          visualizations={visualizations}
          controls_extra={controls_extra}
          selected_views={selected_views}
          new_batch={new_batch}
          available_metrics={available_metrics}
          sort_by={selected.sort_by}
          default_sort_by={metrics.default_metric}
          sort_order={selected.sort_order}
          onToggle={toggle}
          onUpdateControls={updateControls}
          onToggleShow={toggle_show}
          onUpdate={update}
          has_tuning={has_tuning}
          tuned_params={tuned_params}
          dynamic_options={dynamic.dynamic_options}
          onUpdateDynamicOption={updateDynamicOption}
          onResetDynamicOption={resetDynamicOption}
          has_changes={has_controls_changes}
          onResetControls={resetControls}
          docs_root={docs_root}
          onToggleDynamicOptionSync={toggleDynamicOptionSync}
          visualizations_with_files={dynamic.visualizations_with_files}
          expanded={view_options_expanded}
          setExpanded={setViewOptionsExpanded}
          revealFiles={reveal_files}
          revealSection={reveal_section}
          file_options={file_options}
          onToggleFileOption={toggleFileOption}
        />
      )}
    </Container>
    </SharedConfigurationContext>
  );
}

export default CiCommitResults;
