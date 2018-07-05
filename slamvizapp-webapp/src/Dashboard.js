import React from "react";
import { withRouter } from "react-router";
import { Link } from "react-router-dom";
import { get } from "axios";
import moment from "moment";
import qs from "qs";

import {
  Card,
  Spinner,
  NonIdealState,
  Tabs,
  Tab,
  Button,
  MenuItem,
  Colors,
  FormGroup,
  InputGroup
} from "@blueprintjs/core";
import { MultiSelect, Classes } from "@blueprintjs/select";
import { DateRangeInput } from "@blueprintjs/datetime";

import { Container, Section } from "./common/containers";
import { noMetrics } from "./common/metricSelect";
import { shortId, filter_batch } from "./common/utils";

import { CommitsEvolution } from "./CommitsEvolution";
import { MetricsSummary } from "./MetricsSummary";
import { TableCompare, TableKpi } from "./Tables";
import { metrics } from "./metrics";

class Dashboard extends React.Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(this.props.location.search);
    const project = params.get("project") || "dvs/psp_swip";
    const available_metrics = metrics[project].available_metrics;
    let aggregation_metrics = {};
    metrics[project].dashboard_metrics.forEach(m => {
      aggregation_metrics[m] = available_metrics[m].threshold;
    });
    this.state = {
      project,
      branch: params.get("branch") || "develop",
      date_range: [new Date(moment().subtract(31, "d")), new Date()],
      // error: null,
      is_loaded: false,
      commits: new Map(),

      latest_commit: null,
      filter: 'small-scale',
      sort_by: metrics[project].default_metric,
      sort_order: -1,
      aggregation_metrics,

      available_metrics,
      evolution_metrics: metrics[project].dashboard_evolution_metrics || metrics[project].main_metrics,
      selected_metrics: metrics[project].dashboard_metrics.map(
        k => available_metrics[k]
      )
    };
  }

  componentDidMount() {
    document.title = `Dashboard - ${this.state.project}`;
    this.getData(this.props);
  }

  getData(props) {
    const params = new URLSearchParams(this.props.location.search);
    this.setState({ is_loaded: false });
    Promise.all([
      this.getCommits(props),
      this.getCommit(params.get("commit_id")),
      this.getCommit(params.get("commit_android_id"))
    ]).then(() => {
      this.setState({ is_loaded: true });
    });
  }

  getCommit(commit_id) {
    if (commit_id === null || commit_id === undefined) return;
    get(`/api/v1/commit/${commit_id}`, {
      params: { project: this.state.project }
    }).then(response => {
      this.setState((previous_state, props) => ({
        commits: new Map([
          ...previous_state.commits,
          [commit_id, response.data]
        ])
      }));
    });
  }

  getCommits(props) {
    var url = `/api/v1/commits/origin/${this.state.branch}`;
    const { project, date_range } = this.state;
    get(url, {
      params: {
        project,
        only_when_first_pushed_as: true,
        only_ci_batches: true,
        with_outputs: true,
        from: date_range[0],
        to: date_range[1],
        metrics: JSON.stringify(this.state.aggregation_metrics),
        commits: new Map()
      }
    }).then(response => {
      let new_commits = response.data;
      const has_outputs_in_batch = label => commit =>
        !!commit.batches[label] && commit.batches[label].valid_outputs > 0;
      let latest_commits_android = new_commits.filter(
        c =>
          has_outputs_in_batch("ci-android-rt")(c) ||
          has_outputs_in_batch("manual-android-rt")(c)
      );
      let latest_commit_android_id =
        latest_commits_android.length > 0
          ? latest_commits_android[0].id
          : new_commits[0].id;
      this.setState((previous_state, props) => ({
        commits: new Map([
          ...previous_state.commits,
          ...new_commits.map(commit => [commit.id, commit])
        ]),
        latest_commit_android_id
      }));
      if (new_commits.length > 0)
        this.setState({
          date_range: [
            new Date(new_commits[new_commits.length - 1].authored_datetime),
            new Date(new_commits[0].authored_datetime)
          ]
        });
    });
  }


  UpdateFilter = e => {
    this.setState({ filter: e.target.value });
    let query = qs.parse(this.props.location.search);
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
    const {
      is_loaded,
      commits,
      latest_commit_android_id,
      date_range
    } = this.state;
    var { selected_metrics } = this.state;

    // console.log(commits.size)
    // console.log(is_loaded);
    if (!is_loaded || commits.size === 0)
      return (
        <Container>
          <NonIdealState title="Loading" visual={<Spinner />} />
        </Container>
      );
    // if (commits.size===0) return <Container>
    //   <NonIdealState title="Empty" visual='folder' />
    // </Container>
    // console.log(commits)

    const params = new URLSearchParams(this.props.location.search);
    let commit_id = params.get("commit_id") || latest_commit_android_id;
    let commit_android_id =
      params.get("commit_android_id") || latest_commit_android_id;
    let commit = commits.get(commit_id);
    let commit_android = commits.get(commit_android_id);

    let linux_batch = commit.batches.default;
    let empty_batch = {
      outputs: {},
      failed_outputs: 0,
      valid_outputs: 0,
      pending_outputs: 0
    };
    let android_batch =
      commit_android.batches["manual-android-rt"] ||
      commit_android.batches["ci-android-rt"] ||
      empty_batch;
    let has_android = Object.keys(android_batch.outputs).length > 0;


    linux_batch = filter_batch(linux_batch, this.state.filter);
    android_batch = filter_batch(android_batch, this.state.filter);

    // console.log(linux_batch)
    // console.log(android_batch)
    // console.log(has_android)

    let clearButton =
      selected_metrics.length > 0 ? (
        <Button icon="cross" minimal={true} onClick={this.handleClear} />
      ) : null;
    let metricTableSelect = (
      <MultiSelect
        items={Object.values(this.state.available_metrics)}
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

    let selected_commits = Array.from(commits.values()).filter(
      c =>
        new Date(c.authored_datetime) >= date_range[0] &&
        new Date(c.authored_datetime) <= date_range[1]
    );
    let pretty_commit_android_id =
      commit_android.type === "git"
        ? shortId(this.state.project, commit_android_id)
        : commit_android_id.replace("/f2/algo_archive/PTAM_Results/", "");
    let pretty_commit_id = shortId(this.state.project, commit_id);

    return (
      <Container>
        <Section>
          <h1>Dashboard</h1>
          <DateRangeInput
            value={date_range}
            maxDate={new Date()}
            allowSingleDayRange
            formatDate={date => (date == null ? "" : date.toLocaleDateString())}
            parseDate={str => new Date(Date.parse(str))}
            onChange={new_date_range => {
              this.setState(
                { date_range: new_date_range, isLoaded: false },
                c => this.getData(this.props)
              );
            }}
            shortcuts
          />
          {!is_loaded && <Spinner />}
        </Section>

        <Section>
          <Card elevation={1} style={{ breakInside: "avoid" }}>
            <h2>Improvement over time</h2>
            <CommitsEvolution
              project={this.state.project}
              commits={selected_commits}
              select_metrics={this.state.evolution_metrics}
              per_output_granularity
              offer_breakdown_per_test={true}
              style={{ marginTop: "20px" }}
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
              <h2>
                Metrics on Android{" "}
                <span style={{ color: Colors.BLUE2 }}>vs LSF</span>
              </h2>
              <ul>
                <li>
                  <strong>Android:</strong>{" "}
                  {Object.keys(android_batch.outputs).length} results from{" "}
                  <Link to={`/commit/${commit_android_id}`}>
                    <code className="pt-text-muted">
                      {pretty_commit_android_id}
                    </code>
                  </Link>
                </li>
                <li>
                  <strong>LSF:</strong>{" "}
                  {Object.keys(linux_batch.outputs).length} results from{" "}
                  <Link to={`/commit/${commit_id}`}>
                    <code className="pt-text-muted">{pretty_commit_id}</code>
                  </Link>
                </li>
              </ul>
              <MetricsSummary
                selected_metrics={selected_metrics}
                project={this.state.project}
                new_batch={android_batch}
                ref_batch={linux_batch}
                xaxis_labels={["Android", "LSF"]}
              />
            </Card>
          </Section>
        )}


        <Section>
          <Card elevation={1}>
            <h2>Algorithmic bottlenecks</h2>
            <p className='pt-text-muted'>{Object.keys(linux_batch.outputs).length} offline results{" "}
            <Link to={`/commit/${commit_id}`}>
              <code className="pt-text-muted">
                {pretty_commit_id}
              </code>
            </Link>
            </p>
            <MetricsSummary
              breakdown_by_tag
              selected_metrics={selected_metrics}
              project={this.state.project}
              new_batch={linux_batch}
              ref_batch={empty_batch}
            />

          </Card>
        </Section>

        <Section>
          <div>
            <h2>Individual tests</h2>

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
              <div className="pt-select">
                <select
                  defaultValue={this.state.sort_by}
                  onChange={this.selectSortBy}
                >
                  <option value="test_input_path">Sort by Name</option>
                  {Object.values(this.state.available_metrics).map(m => (
                    <option key={m.key} value={m.key}>
                      Sort by {m.label}
                    </option>
                  ))}
                </select>
                <select defaultValue="descending" onChange={this.selectOrder}>
                  <option value={-1}>descending</option>
                  <option value={1}>ascending</option>
                </select>
              </div>
            </Tabs>
          </div>
        </Section>
      </Container>
    );
  }
}

export default withRouter(Dashboard);
