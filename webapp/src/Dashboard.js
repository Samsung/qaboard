import React from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";

import {
  Classes,
  Card,
  Spinner,
  NonIdealState,
  Tabs,
  Tab,
  Button,
  MenuItem,
  HTMLSelect,
} from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";

import CommitsEvolution from "./CommitsEvolution";
import { Container, Section } from "./components/layout";
import { noMetrics } from "./components/metricSelect";
import { MetricsSummary } from "./components/metrics";
import { TableCompare, TableKpi } from "./components/tables";
import { match_query } from "./utils";

import { fetchCommits } from "./actions/projects";
import { updateSelected } from "./actions/selected";

import { empty_batch, default_date_range } from "./defaults";
import {
  projectSelector,
  projectDataSelector,
	configSelector,
  commitsDataSelector,
  commitsSelector,
  commitSelector,
  batchSelector,
  selectedSelector,
} from './selectors/projects'


class Dashboard extends React.Component {
  constructor(props) {
    super(props);
    const { available_metrics, dashboard_metrics, main_metrics } = this.props;
    this.state = {
      latest_commit: null,
      selected_metrics: (dashboard_metrics || main_metrics || []).map(
        k => available_metrics[k]
      )
    };
  }


  componentDidMount() {
    let name = this.props.project.split('/').slice(-1)[0];
    document.title = `History - ${name}`;
    this.fetchCommits();
  }

  componentDidUpdate(prevProps) {
    if (this.props.match.url !== prevProps.match.url)
      this.fetchCommits();
  }

  fetchCommits() {
    const { match, project, selected_batch_new, dispatch, aggregation_metrics } = this.props;
    const extra_params = {
      // only_ci_batches: selected_batch_new === 'default',
      with_outputs: true,
    }
    dispatch(fetchCommits(project, {...match.params}, default_date_range(), aggregation_metrics, extra_params))
  }


  renderMetric = (metric, { handleClick, modifiers, query }) => {
    if (!modifiers.matchesPredicate) {
      return null;
    }
    return (
      <MenuItem
        active={modifiers.active}
        icon={this.isMetricSelected(metric) ? "tick" : "blank"}
        key={metric.key}
        label={metric.key}
        text={`${metric.label} [${metric.suffix}]`}
        onClick={handleClick}
        shouldDismissPopover={false}
      />
    );
  };
  filterMetric = (query, metric) => {
    return match_query(query)(`${metric.key} ${metric.label} ${metric.short_label}`)
  };
  handleClear = () => this.setState({ selected_metrics: [] });
  handleTagRemove = (_tag, index) => {
    this.deselectMetric(index);
  };
  getSelectedMetricIndex = metric => {
    return this.state.selected_metrics.indexOf(metric);
  };
  isMetricSelected(metric) {
    return this.getSelectedMetricIndex(metric) !== -1;
  }
  deselectMetric = index => {
    this.setState({
      selected_metrics: this.state.selected_metrics.filter(
        (metric, i) => i !== index
      )
    });
  };
  handleMetricSelect = metric => {
    if (!this.isMetricSelected(metric)) {
      this.setState({
        selected_metrics: [...this.state.selected_metrics, metric]
      });
    } else {
      this.deselectMetric(this.getSelectedMetricIndex(metric));
    }
  };

  update = (attribute, attribute_url) => e => {
  	const value = (e.target && e.target.value !==undefined) ? e.target.value : e;
    this.props.dispatch(updateSelected(this.props.project, { [attribute]: value }))
  } 

  render() {
    const { project_data, project, commits, available_metrics, output_filter } = this.props;
    const { is_loaded, is_loading, error  } = this.props;
    const { selected_metrics, evolution_metrics } = this.state;

    if (is_loading)
      return (
        <Container style={{paddingTop: '50px'}}>
          <NonIdealState title={`Loading ${!!this.props.match.name ? this.props.match.name : ''}`} icon={<Spinner />} />
        </Container>
      );
    if (commits.length===0) return <Container style={{paddingTop: '50px'}}>
      <NonIdealState title="No commits found" description="Try expanding the date range." icon='search' />
    </Container>
    if (!!error) return <Container style={{paddingTop: '50px'}}>
      <NonIdealState title="Error" icon='error' text={JSON.stringify(error)}/>
    </Container>


    const { new_commit, ref_commit, new_batch, ref_batch } = this.props;
    const has_reference = !!ref_batch && !!ref_batch.filtered && !!ref_batch.filtered.outputs && Object.keys(ref_batch.filtered.outputs).length > 0

    let clearButton = selected_metrics.length > 0 ? <Button icon="cross" minimal={true} onClick={this.handleClear} /> : null;
    let metricTableSelect = (
      <MultiSelect
        items={Object.values(available_metrics)}
        itemPredicate={this.filterMetric}
        itemRenderer={this.renderMetric}
        onItemSelect={this.handleMetricSelect}
        tagRenderer={m => m.label}
        tagInputProps={{
          onRemove: this.handleTagRemove,
          rightElement: clearButton
        }}
        noResults={noMetrics}
        selectedItems={selected_metrics}
        popoverProps={Classes.MINIMAL}
      />
    );

    let outputs_nb = Object.keys(new_batch.filtered.outputs).length
    let count = outputs_nb > 0 ? <p className={Classes.TEXT_MUTED}>{outputs_nb} output{outputs_nb > 1 ? 's' : ''}</p> : <span/>
    return (
      <Container style={{paddingTop: '50px'}}>
        <Section>
          {!is_loaded && <Spinner />}
          <Card elevation={1} style={{ breakInside: "avoid" }}>
            <h2 className={Classes.HEADING}>Performance over time</h2>
            <CommitsEvolution
              project={project}
              project_data={project_data}
              commits={commits}
              shown_batches={[this.props.selected_batch_new]}
              new_commit={new_commit}
              ref_commit={ref_commit}
              select_metrics={evolution_metrics}
              output_filter={output_filter}
              per_output_granularity
              default_breakdown_per_test={this.props.breakdown_per_test}
              style={{ marginTop: "20px" }}
              dispatch={this.props.dispatch}
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
                new_batch={new_batch}
                ref_batch={ref_batch}
              />
            </Card>
          </Section>
        )}


        {project==='dvs/psp_swip' && <Section>
          <Card elevation={1}>
            <h2 className={Classes.HEADING}>Algorithmic bottlenecks</h2>
            {count}
            <MetricsSummary
              breakdown_by_tag
              selected_metrics={selected_metrics}
              project={project}
              project_data={project_data}
              new_batch={new_batch}
              ref_batch={empty_batch}
            />
          </Card>
        </Section>}

        <Section>
          <Card>
            <h2 className={Classes.HEADING}>Metrics per-test</h2>
            <Tabs
              renderActiveTabPanelOnly
              id="tabs-outputs"
              onChange={(newTabId, prevTabId, event) => {
                this.setState({ selectedTabId: newTabId });
              }}
              selectedTabId={this.state.selectedTabId}
            >
              <Tab
                id="table-kpi"
                title="vs KPI"
                panel={
                  <TableKpi
                    new_batch={new_batch}
                    ref_batch={ref_batch}
                    metrics={selected_metrics}
                    input={metricTableSelect}
                  />
                }
              />
              {has_reference && (
                <Tab
                  id="table-compare"
                  panel={
                    <TableCompare
                      new_batch={new_batch}
                      ref_batch={ref_batch}
                      metrics={selected_metrics}
                      input={metricTableSelect}
                    />
                  }
                />
              )}
              <Tabs.Expander />
                <HTMLSelect
                  defaultValue={this.state.sort_by}
                  onChange={this.update('sort_by')}
                  >
                  <option value="test_input_path">Sort by Name</option>
                  <option value="id">Sort by ID</option>
                  {Object.values(available_metrics).map(m => (
                    <option key={m.key} value={m.key}>
                      Sort by {m.label}
                    </option>
                  ))}
              </HTMLSelect>
              <HTMLSelect defaultValue="descending" onChange={this.update('sort_order')}>
                <option value={-1}>descending</option>
                <option value={1}>ascending</option>
              </HTMLSelect>
            </Tabs>
          </Card>
        </Section>
      </Container>
    );
  }
}


const mapStateToProps = (state, ownProps) => {
    const params = new URLSearchParams(ownProps.location.search);

    let project = projectSelector(state)
    let project_data = projectDataSelector(state)

    let selected = selectedSelector(state)
    let new_commit_id = selected.new_commit_id
    let ref_commit_id = selected.ref_commit_id

    let { new_commit, ref_commit } = commitSelector(state)

    let {
      selected_batch_new,
      new_batch,
      ref_batch,
    } = batchSelector(state)

    let commits_data = commitsDataSelector(state)
    let commits = commitsSelector(state)

    let { project_config, project_metrics } = configSelector(state)

    let some_commits_loaded = !!commits && commits.length > 0;
    let metrics = (some_commits_loaded && commits[0]).data?.qatools_metrics || project_metrics || {}
    const { available_metrics, default_metric, main_metrics, dashboard_metrics, dashboard_evolution_metrics } = metrics
    let aggregation_metrics = {};
    (dashboard_metrics || main_metrics || []).filter(m => available_metrics[m] !== undefined)
    .forEach(m => {
      aggregation_metrics[m] = available_metrics[m].target;
    });

    return {
      params,
      project,
      project_config,
      project_data,
      date_range: commits_data.date_range,
      commits: commits.filter(c => !!c),
      // commits
      new_commit_id,
      ref_commit_id,
      new_commit,
      ref_commit,
      // state
      error: commits_data.error,
      is_loaded: commits_data.is_loaded,
      is_loading: commits_data.is_loading,
      // outputs
      selected_batch_new,
      new_batch,
      ref_batch,
      // metrics
      aggregation_metrics,
      evolution_metrics: (dashboard_evolution_metrics || main_metrics || []),
      default_metric,
      main_metrics,
      available_metrics,
      dashboard_metrics,
      dashboard_evolution_metrics,

      breakdown_per_test: (params.get("breakdown_per_test") || '').toLowerCase() === 'true' || true,
      output_filter: selected.filter_batch_new,
      sort_by: selected.sort_by,
      sort_order: selected.sort_order || 'input_test_path',
    }
}

export default withRouter(connect(mapStateToProps)(Dashboard) );
