import { useEffect, useMemo, useState } from "react";
import { DateTime } from "luxon";
import styled from "styled-components";

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


// Like the views of the commit pages: the title on a row above the card
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
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 20px;
    line-height: 28px;
    margin: 0;
  }
  p {
    margin: 0;
  }
`;

const Dashboard = () => {
  const { project, project_data, selected, new_commit, ref_commit, new_batch, ref_batch, selected_batch_new } = useComparison();
  const { commits, error, refetch, isPending, isFetching, date_range, qatools_metrics } = useCommitsList();

  useEffect(() => {
    let name = project.split('/').slice(-1)[0];
    document.title = `History - ${name}`;
  }, [project]);

  // On branches, the metrics configuration comes from the latest commit
  const metrics = qatools_metrics ?? {};
  const { available_metrics = {}, main_metrics, dashboard_metrics, dashboard_evolution_metrics, dashboard_breakdown_by_tag } = metrics;
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
      description={<p style={{ overflowWrap: 'anywhere' }}><code>{errorMessage(error)}</code></p>}
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
  const count = outputs_nb > 0 && <p className={Classes.TEXT_MUTED}>{outputs_nb} run{outputs_nb > 1 ? 's' : ''}</p>
  return (
    <Container style={{ marginTop: 0, paddingTop: 50 + 16 }}>
      <ViewSection style={{ breakInside: "avoid" }}>
        <ViewHeader>
          {/* a small spinner while refreshing: a big one would push the page down */}
          <h2 className={Classes.HEADING}>
            Performance over time
            {isFetching && <Spinner size={16} aria-label="Refreshing"/>}
          </h2>
        </ViewHeader>
        <Card>
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
          />
        </Card>
      </ViewSection>

      {has_reference && (
        <ViewSection style={{ breakAfter: "always", breakInside: "avoid" }}>
          <ViewHeader>
            <h2 className={Classes.HEADING}>Metrics distribution</h2>
            {count}
          </ViewHeader>
          <Card>
            <MetricsSummary
              selected_metrics={selected_metrics}
              project={project}
              project_data={project_data}
              metrics={metrics}
              new_batch={new_batch}
              ref_batch={ref_batch}
            />
          </Card>
        </ViewSection>
      )}

      {/* the metrics file's dashboard_breakdown_by_tag: the summary per tag of the inputs' metadata */}
      {dashboard_breakdown_by_tag && <ViewSection>
        <ViewHeader>
          <h2 className={Classes.HEADING}>Metrics per input tag</h2>
          {count}
        </ViewHeader>
        <Card>
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
      </ViewSection>}

      <ViewSection>
        <ViewHeader>
          <h2 className={Classes.HEADING}>Metrics per test</h2>
        </ViewHeader>
        <Card>
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
              aria-label="Sort by"
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
            <HTMLSelect aria-label="Sort order" value={selected.sort_order} onChange={e => updateSelected({ sort_order: e.target.value }, { replace: true })}>
              <option value={-1}>descending</option>
              <option value={1}>ascending</option>
            </HTMLSelect>
          </Tabs>
        </Card>
      </ViewSection>
    </Container>
  );
}

export default Dashboard;
