import { useEffect, useMemo, useState } from "react";
import { DateTime } from "luxon";

import {
  Button,
  Classes,
  Card,
  Spinner,
  NonIdealState,
  Tabs,
  TabsExpander,
  Tab,
  HTMLSelect,
} from "@blueprintjs/core";

import CommitsEvolution from "./CommitsEvolution";
import { Container, Section } from "./components/layout";
import { MetricsSummary, MetricSelect } from "./components/metrics";
import { TableCompare, TableKpi } from "./components/tables";

import { useCommitsList, useComparison, updateSelected } from "./hooks";
import { empty_batch } from "./defaults";
import { errorMessage } from "./api/http";




// Servers or proxies can answer errors with whole HTML pages: we only show their status
const readable_error = error => {
  const data = error?.response?.data;
  const is_html = typeof data === 'string' && /<\/?[a-z][^>]*>/i.test(data);
  const text = is_html ? `${error.response.status} ${error.response.statusText || 'Server error'}` : errorMessage(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};


const Dashboard = () => {
  const { project, project_data, selected, new_commit, ref_commit, new_batch, ref_batch, selected_batch_new } = useComparison();
  const { commits, error, refetch, isPending, isFetching, date_range, qatools_metrics } = useCommitsList();

  useEffect(() => {
    let name = project.split('/').slice(-1)[0];
    document.title = `History - ${name}`;
  }, [project]);

  // On branches, the metrics configuration comes from the latest commit
  const metrics = qatools_metrics ?? {};
  const { available_metrics = {}, main_metrics, dashboard_metrics, dashboard_evolution_metrics } = metrics;
  const evolution_metrics = dashboard_evolution_metrics || main_metrics || [];

  // null: the project's default metrics
  const [user_selected_metrics, setSelectedMetrics] = useState(null);
  const selected_metrics_keys = user_selected_metrics ?? (dashboard_metrics || main_metrics || []).filter(k => !!available_metrics[k]);
  const selected_metrics = selected_metrics_keys.map(k => available_metrics[k]).filter(Boolean);
  const [selected_tab, setSelectedTab] = useState(undefined);

  const used_metrics = useMemo(
    () => Object.values(available_metrics).filter(m => new_batch.used_metrics.has(m.key)),
    [available_metrics, new_batch.used_metrics],
  );

  if (!!error && commits.length === 0) return <Container style={{paddingTop: '50px'}}>
    <NonIdealState
      title="Could not load the history"
      icon='error'
      description={<p style={{ overflowWrap: 'anywhere' }}><code>{readable_error(error)}</code></p>}
      action={<Button icon="refresh" text="Retry" onClick={() => refetch()}/>}
    />
  </Container>
  if (isPending || (isFetching && commits.length === 0))
    return (
      <Container style={{paddingTop: '50px'}}>
        <NonIdealState title={`Loading the history${selected.branch ? ` of ${selected.branch}` : ''}…`} icon={<Spinner />} />
      </Container>
    );
  const show_older = () => updateSelected({ from: DateTime.fromJSDate(date_range[0]).minus({ days: 30 }).toJSDate() }, { replace: true });
  if (commits.length === 0) return <Container style={{paddingTop: '50px'}}>
    <NonIdealState
      title="No commits found"
      description="There are no commits with results in this date range."
      icon='search'
      action={<Button icon="history" text="Search 30 more days" onClick={show_older}/>}
    />
  </Container>

  const has_reference = Object.keys(ref_batch?.filtered?.outputs ?? {}).length > 0

  const metricTableSelect = <MetricSelect
    available_metrics={available_metrics}
    used_metrics={new_batch.used_metrics}
    selected={selected_metrics_keys}
    onChange={setSelectedMetrics}
  />;

  const outputs_nb = new_batch.filtered.outputs.length
  const count = outputs_nb > 0 ? <p className={Classes.TEXT_MUTED}>{outputs_nb} output{outputs_nb > 1 ? 's' : ''}</p> : <span/>
  return (
    <Container style={{paddingTop: '50px'}}>
      <Section>
        <Card elevation={1} style={{ breakInside: "avoid" }}>
          {/* a small spinner while refreshing: a big one would push the page down */}
          <h2 className={Classes.HEADING} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            Performance over time
            {isFetching && <Spinner size={16} aria-label="Refreshing"/>}
          </h2>
          <CommitsEvolution
            project={project}
            project_data={project_data}
            commits={commits}
            shown_batches={[selected_batch_new]}
            new_commit={new_commit}
            ref_commit={ref_commit}
            select_metrics={evolution_metrics}
            output_filter={selected.filter_batch_new}
            per_output_granularity
            default_breakdown_per_test={true}
            onSelect={commits => updateSelected(commits, { replace: true })}
            style={{ marginTop: "20px" }}
          />
        </Card>
      </Section>

      {has_reference && (
        <Section style={{ breakAfter: "always", breakInside: "avoid" }}>
          <Card elevation={0}>
            <h2 className={Classes.HEADING}>Metrics distribution</h2>
            {count}
            <MetricsSummary
              selected_metrics={selected_metrics}
              project={project}
              project_data={project_data}
              metrics={metrics}
              new_batch={new_batch}
              ref_batch={ref_batch}
            />
          </Card>
        </Section>
      )}

      {project === 'dvs/psp_swip' && <Section>
        <Card elevation={1}>
          <h2 className={Classes.HEADING}>Algorithmic bottlenecks</h2>
          {count}
          <MetricsSummary
            breakdown_by_tag
            selected_metrics={selected_metrics}
            project={project}
            project_data={project_data}
            metrics={metrics}
            new_batch={new_batch}
            ref_batch={empty_batch}
          />
        </Card>
      </Section>}

      <Section>
        <Card>
          <h2 className={Classes.HEADING}>Metrics per-test</h2>
          {/* Named like the views of the commit pages */}
          <Tabs
            renderActiveTabPanelOnly
            id="tabs-outputs"
            onChange={setSelectedTab}
            selectedTabId={selected_tab}
          >
            <Tab
              id="table-kpi"
              title="Metrics Table"
              panel={
                <TableKpi
                  new_batch={new_batch}
                  ref_batch={ref_batch}
                  metrics={selected_metrics_keys}
                  available_metrics={available_metrics}
                  input={metricTableSelect}
                />
              }
            />
            {has_reference && (
              <Tab
                id="table-compare"
                title="Metrics Diff"
                panel={
                  <TableCompare
                    new_batch={new_batch}
                    ref_batch={ref_batch}
                    metrics={selected_metrics_keys}
                    available_metrics={available_metrics}
                    input={metricTableSelect}
                  />
                }
              />
            )}
            <TabsExpander />
            <HTMLSelect
              value={selected.sort_by ?? metrics.default_metric ?? 'test_input_path'}
              onChange={e => updateSelected({ sort_by: e.target.value }, { replace: true })}
            >
              <option value="test_input_path">Sort by Name</option>
              <option value="id">Sort by ID</option>
              {used_metrics.map(m => (
                <option key={m.key} value={m.key}>
                  Sort by {m.label}
                </option>
              ))}
            </HTMLSelect>
            <HTMLSelect value={selected.sort_order} onChange={e => updateSelected({ sort_order: e.target.value }, { replace: true })}>
              <option value={-1}>descending</option>
              <option value={1}>ascending</option>
            </HTMLSelect>
          </Tabs>
        </Card>
      </Section>
    </Container>
  );
}

export default Dashboard;
