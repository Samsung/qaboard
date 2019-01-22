import React from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import { Link } from "react-router-dom";
import qs from "qs";

import {
  Classes,
  Card,
  Spinner,
  NonIdealState,
  Tabs,
  Tab,
  Button,
  MenuItem,
  Colors,
  FormGroup,
  InputGroup,
  HTMLSelect
} from "@blueprintjs/core";
import { MultiSelect } from "@blueprintjs/select";
import { DateRangeInput } from "@blueprintjs/datetime";

import { CommitsEvolution } from "./CommitsEvolution";
import { Container, Section } from "./components/layout";
import { noMetrics } from "./components/metricSelect";
import { MetricsSummary } from "./components/metrics";
import { TableCompare, TableKpi } from "./components/tables";

import { fetchCommit } from "./actions/commit";
import { fetchCommits } from "./actions/projects";

import { shortId, filter_batch } from "./utils";
import { default_project, empty_batch, default_commits_data, default_date_range } from "./defaults"



class Dashboard extends React.Component {
  constructor(props) {
    super(props);
    const { default_metric, available_metrics, dashboard_metrics } = this.props;
    this.state = {
      latest_commit: null,
      filter: '',
      sort_by: default_metric,
      sort_order: -1,
      selected_metrics: dashboard_metrics.map(
        k => available_metrics[k]
      )
    };
  }


  componentDidMount() {
    document.title = `Dashboard - ${this.props.project}`;
    this.fetchCommits();
  }

  componentDidUpdate(prevProps) {
    if (
      this.props.match.url !== prevProps.match.url ||
      this.props.branch.name !== prevProps.branch.name
      // this.props.project_data !== prevProps.project_data
      // this.props.aggregation_metrics !== prevProps.aggregation_metrics
      ) {
      this.fetchCommits();
    }
  }

  fetchCommits() {
    const { params, project, dispatch, branch, date_range, aggregation_metrics } = this.props;
    const extra_params = {
      only_ci_batches: true,
      with_outputs: true,
    } 
    dispatch(fetchCommits(project, branch, date_range, aggregation_metrics, extra_params))
    if (params.get("commit_id"))
      dispatch(fetchCommit(project, params.get("commit_id"), "new_commit_id"));
    if (params.get("commit_android_id"))
      dispatch(fetchCommit(project, params.get("commit_android_id"), "ref_commit_id"));
  }


  UpdateFilter = e => {
    this.setState({ filter: e.target.value });
    let query = qs.parse(this.props.location.search.substring(1));
    this.props.history.push({
      pathname: this.props.location.pathname,
      search: qs.stringify({
        ...query,
        filter: e.target.value
      })
    });
  };


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
    let searched = `${metric.key} ${metric.label} ${
      metric.short_label
    }`.toLowerCase();
    let search = query.toLowerCase();
    return searched.indexOf(search) >= 0;
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
  selectSortBy = e => {
    this.setState({ sort_by: e.target.value });
  };
  selectOrder = e => {
    this.setState({ sort_order: e.target.value });
  };

  render() {
    const { params, project_data, project, commits, available_metrics, date_range } = this.props;
    const { is_loaded, is_loading, error  } = this.props;
    const {
      selected_metrics,
      evolution_metrics,
    } = this.state;

    // console.log("commits.length", commits.length)
    // console.log("is_loaded", is_loaded);
    // console.log("is_loading", is_loading);
    if (is_loading)
      return (
        <Container>
          <NonIdealState title={`Loading @${this.props.branch.name}`} icon={<Spinner />} />
        </Container>
      );
    if (commits.length===0) return <Container>
      <NonIdealState title="No commits found" description="Too bad......" icon='search' />
    </Container>
    if (!!error) return <Container>
      <NonIdealState title="Error" icon='error' text={JSON.stringify(error)}/>
    </Container>
    // console.log(commits)

    // Find the latest commit with android results [Specific to dvs/psp_swip]
    const has_outputs_in_batch = label => commit => !!commit.batches[label] && commit.batches[label].valid_outputs > 0;
    let latest_commits_android = commits.filter(c => has_outputs_in_batch("ci-android-rt")(c) || has_outputs_in_batch("manual-android-rt")(c));
    let latest_commit_android_id = latest_commits_android.length > 0 ? latest_commits_android[0].id : (commits.length > 0 ? commits[0].id : null);

    let commit_id = params.get("commit_id") || latest_commit_android_id;
    let commit_android_id = params.get("commit_android_id") || latest_commit_android_id;
    let commit = commits.find(c => c.id === commit_id);
    let commit_android = commits.find(c => c.id === commit_android_id);

    let linux_batch = commit.batches.default || empty_batch;
    let android_batch = commit_android.batches["manual-android-rt"] || commit_android.batches["ci-android-rt"] || empty_batch;
    let has_android = Object.keys(android_batch.outputs).length > 0;

    // console.log('before filter')
    // console.log("linux_batch", linux_batch)
    // console.log("android_batch", android_batch)

    linux_batch = filter_batch(linux_batch, this.state.filter);
    android_batch = filter_batch(android_batch, this.state.filter);

    // console.log("linux_batch", linux_batch)
    // console.log("android_batch", android_batch)
    // console.log(has_android)

    let clearButton =
      selected_metrics.length > 0 ? (
        <Button icon="cross" minimal={true} onClick={this.handleClear} />
      ) : null;
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

    let selected_commits = commits.filter(
      c =>
        new Date(c.authored_datetime) >= date_range[0] &&
        new Date(c.authored_datetime) <= date_range[1]
    );
    let pretty_commit_android_id =
      commit_android.type === "git"
        ? shortId(project, commit_android_id)
        : commit_android_id.replace("/f2/algo_archive/PTAM_Results/", "");
    let pretty_commit_id = shortId(project, commit_id);

    var effective_date_range = date_range;
    if (commits.length > 0){
      effective_date_range = [
        new Date(commits[commits.length - 1].authored_datetime),
        new Date(commits[0].authored_datetime)
      ]
    }

    return (
      <Container>
        <Section>
          <h1 className={Classes.HEADING}>Dashboard</h1>
          <DateRangeInput
            value={effective_date_range}
            maxDate={new Date()}
            allowSingleDayRange
            formatDate={date => (date == null ? "" : date.toLocaleDateString())}
            parseDate={str => new Date(Date.parse(str))}
            onChange={new_date_range => {
              const { project, branch, aggregation_metrics, dispatch } = this.props; 
              dispatch(fetchCommits(project, branch, new_date_range, aggregation_metrics, {only_ci_batches: true, with_outputs: true}))
            }}
            shortcuts
          />
          {!is_loaded && <Spinner />}
        </Section>

        <Section>
          <Card elevation={1} style={{ breakInside: "avoid" }}>
            <h2 className={Classes.HEADING}>Improvement over time</h2>
            <CommitsEvolution
              project={project}
              project_data={project_data}              
              commits={selected_commits}
              select_metrics={evolution_metrics}
              per_output_granularity
              offer_breakdown_per_test={true}
              style={{ marginTop: "20px" }}
              dispatch={this.props.dispatch}
            />
          </Card>
        </Section>

        <FormGroup
          labelFor="filter-input"
          helperText={`${
            !this.state.filter
              ? "You can filter all the data below."
              : ""
          }`}
        >
          <InputGroup
            value={this.state.filter}
            placeholder="Input path, tags, platform, configuration, or tuning parameters (key:value)"
            onChange={this.UpdateFilter}
            type="search"
            leftIcon="search"
            style={{width: '800px'}}
          />
        </FormGroup>

        {has_android && (
          <Section style={{ breakAfter: "always", breakInside: "avoid" }}>
            <Card elevation={0}>
              <h2 className={Classes.HEADING}>
                Metrics on Android{" "}
                <span style={{ color: Colors.BLUE2 }}>vs LSF</span>
              </h2>
              <ul className={Classes.LIST}>
                <li>
                  <strong>Android:</strong>{" "}
                  {Object.keys(android_batch.outputs).length} results from{" "}
                  <Link to={`/commit/${commit_android_id}?project=${project}`}>
                    <code className={`${Classes.TEXT_MUTED} ${Classes.CODE}`}>
                      {pretty_commit_android_id}
                    </code>
                  </Link>
                </li>
                <li>
                  <strong>LSF:</strong>{" "}
                  {Object.keys(linux_batch.outputs).length} results from{" "}
                  <Link to={`/commit/${commit_id}?project=${project}`}>
                    <code className={`${Classes.TEXT_MUTED} ${Classes.CODE}`}>{pretty_commit_id}</code>
                  </Link>
                </li>
              </ul>
              <MetricsSummary
                selected_metrics={selected_metrics}
                project={project}
                project_data={project_data}
                new_batch={android_batch}
                ref_batch={linux_batch}
                xaxis_labels={["Android", "LSF"]}
              />
            </Card>
          </Section>
        )}


        {project==='dvs/psp_swip' && <Section>
          <Card elevation={1}>
            <h2 className={Classes.HEADING}>Algorithmic bottlenecks</h2>
            <p className={Classes.TEXT_MUTED}>{Object.keys(linux_batch.outputs).length} offline results{" "}
            <Link to={`/commit/${commit_id}`}>
              <code className={`${Classes.TEXT_MUTED} ${Classes.CODE}`}>
                {pretty_commit_id}
              </code>
            </Link>
            </p>
            <MetricsSummary
              breakdown_by_tag
              selected_metrics={selected_metrics}
              project={project}
              project_data={project_data}
              new_batch={linux_batch}
              ref_batch={empty_batch}
            />
          </Card>
        </Section>}

        <Section>
          <div>
            <h2 className={Classes.HEADING}>Individual tests</h2>

            <Tabs
              renderActiveTabPanelOnly
              id="tabs-outputs"
              onChange={(newTabId, prevTabId, event) => {
                this.setState({ selectedTabId: newTabId });
              }}
              selectedTabId={this.state.selectedTabId}
            >
              <Tab
                id="output-table-kpi"
                title="vs KPI"
                panel={
                  <TableKpi
                    sort_order={this.state.sort_order}
                    sort_by={this.state.sort_by}
                    new_batch={has_android ? android_batch : linux_batch}
                    ref_batch={has_android ? linux_batch : android_batch}
                    labels={
                      has_android ? ["Android", "LSF"] : ["LSF", "Android"]
                    }
                    metrics={selected_metrics}
                    input={metricTableSelect}
                  />
                }
              />
              {has_android && (
                <Tab
                  id="output-table-compare"
                  title="Android vs LSF"
                  panel={
                    <TableCompare
                      sort_order={this.state.sort_order}
                      sort_by={this.state.sort_by}
                      new_batch={android_batch}
                      ref_batch={linux_batch}
                      labels={["Android", "LSF"]}
                      metrics={selected_metrics}
                      input={metricTableSelect}
                    />
                  }
                />
              )}
              <Tabs.Expander />
                <HTMLSelect
                  defaultValue={this.state.sort_by}
                  onChange={this.selectSortBy}
                >
                  <option value="test_input_path">Sort by Name</option>
                  {Object.values(available_metrics).map(m => (
                    <option key={m.key} value={m.key}>
                      Sort by {m.label}
                    </option>
                  ))}
              </HTMLSelect>
              <HTMLSelect defaultValue="descending" onChange={this.selectOrder}>
                <option value={-1}>descending</option>
                <option value={1}>ascending</option>
              </HTMLSelect>
            </Tabs>
          </div>
        </Section>
      </Container>
    );
  }
}


const mapStateToProps = (state, ownProps) => {
    const params = new URLSearchParams(ownProps.location.search);

    // project information
    let project = params.get("project") || state.selected.project;
    let project_data = state.projects.data[project] || default_project

    // metrics
    let project_metrics = project_data.information.qatools_metrics    
    const { available_metrics, default_metric, main_metrics, dashboard_metrics, dashboard_evolution_metrics } = project_metrics
    let aggregation_metrics = {};
    (dashboard_metrics || main_metrics).forEach(m => {
      aggregation_metrics[m] = available_metrics[m].target;
    });


    // selection
    let branch = {name: params.get("branch") || project_data.information.qatools_config.project.reference_branch}
    let branch_key = branch.name || branch.committer || 'default'
    let commits_data = project_data.commits[branch_key] || default_commits_data;

    return {
      // URL
      params,
      // project information
      project,
      project_data,
      // selection
      branch,
      date_range: commits_data.date_range || default_date_range,
      commits: commits_data.ids.map(id=>state.commits[id]),
      // state
      error: commits_data.error,
      is_loaded: commits_data.is_loaded,
      is_loading: commits_data.is_loading,
      // metrics
      aggregation_metrics,
      evolution_metrics: (dashboard_evolution_metrics || main_metrics),
      default_metric,
      main_metrics,
      available_metrics,
      dashboard_metrics,
      dashboard_evolution_metrics,
    }
}

export default withRouter(connect(mapStateToProps)(Dashboard) );
