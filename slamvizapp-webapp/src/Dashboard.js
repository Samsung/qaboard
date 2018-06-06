import React from "react";
import { get } from "axios";
import moment from 'moment';

import { Card, Intent, Callout, Spinner, NonIdealState, Tabs, Tab, Button, MenuItem } from "@blueprintjs/core";
import { MultiSelect, Classes }  from "@blueprintjs/select";
import { DateRangeInput } from "@blueprintjs/datetime";
// import { Button, Icon, Intent, Tooltip, NonIdealState, Spinner, Tag, Callout } from "@blueprintjs/core";

import { Container, Section } from "./common/containers";
import { noMetrics } from "./common/metricSelect";
// import { MetricTag } from "./MetricsSummary"
// import { groupBy, calendarStrings } from "./common/utils";

import { CommitsEvolution } from './CommitsEvolution'
import { MetricsSummary } from './MetricsSummary'
import { TableCompare, TableKpi } from './Tables'
import { slam_metrics, main_metrics, default_metric } from './slam/metrics'



class Dashboard extends React.Component {
  constructor(props) {
    super(props);
    // const params = new URLSearchParams(this.props.location.search);
    let aggregation_metrics = {}
    main_metrics.forEach(m => aggregation_metrics[m] = slam_metrics[m].threshold)
    this.state = {
      project: 'dvs/psp_swip',
      date_range: [
        new Date(moment().subtract(31,'d')),
        new Date()
      ],
      // error: null,
      is_loaded: false,
      commits: [],
      latest_commit: null,
      sort_by: default_metric,
      sort_order: -1,
      aggregation_metrics,

      available_metrics: slam_metrics,
      selected_metrics: main_metrics.map(k=>slam_metrics[k]),
    };
  }

  componentDidMount() {
    document.title = `Dashboard - ${this.state.project}`;   
    this.getData(this.props)
  }

  getData(props) {
    var url = '/api/v1/commits/origin/develop';
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
      },
    })
    .then(response => {
      let commits = response.data;
      // TODO: get the id from the URL
      let latest_android_commit = commits.filter( c => !!c.batches['ci-android-rt'] && c.batches['ci-android-rt'].valid_outputs>0)[0]
      this.setState({
        is_loaded: true,
        commits,
        latest_android_commit,
      });
      if (commits.length > 0)
        this.setState({
          date_range: [
            new Date(commits[commits.length-1].authored_datetime),
            new Date(commits[0].authored_datetime)
          ],            
        })
    })
  }

  renderMetric = (metric, {handleClick, modifiers, query} ) => {
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
    let searched = `${metric.key} ${metric.label} ${metric.short_label}`.toLowerCase();
    let search = query.toLowerCase();
    return searched.indexOf(search) >= 0;
  }
  handleClear = () => this.setState({ selected_metrics: [] });
  handleTagRemove = (_tag, index) => {
    this.deselectMetric(index);
  };
  getSelectedMetricIndex = metric => {
    return this.state.selected_metrics.indexOf(metric);
  }
  isMetricSelected(metric) {
      return this.getSelectedMetricIndex(metric) !== -1;
  }
  deselectMetric = index => {
      this.setState({ selected_metrics: this.state.selected_metrics.filter( (metric, i) => i !== index) });
  }
  handleMetricSelect = metric => {
    if (!this.isMetricSelected(metric)) {
      this.setState({ selected_metrics: [...this.state.selected_metrics, metric] });
    } else {
      this.deselectMetric(this.getSelectedMetricIndex(metric));
    }
  };
  selectSortBy = e => {
    this.setState({sort_by: e.target.value})
  }
  selectOrder = e => {
    this.setState({sort_order: e.target.value})
  }

  render() {
    const { is_loaded, commits, date_range } = this.state;
    var { selected_metrics } = this.state;

    if (!is_loaded) return <Container>
      <NonIdealState title="Loading" visual={<Spinner/>} />
    </Container>

    let linux_batch = this.state.latest_android_commit.batches.default
    let android_batch = this.state.latest_android_commit.batches['ci-android-rt']

    let clearButton = selected_metrics.length > 0 ? <Button icon="cross" minimal={true} onClick={this.handleClear} /> : null;
    let metricTableSelect = <MultiSelect
      items={Object.values(this.state.available_metrics)}
      itemPredicate={this.filterMetric}
      itemRenderer={this.renderMetric}
      onItemSelect={this.handleMetricSelect}
      tagRenderer={m => m.label}
      tagInputProps={{ onRemove: this.handleTagRemove, rightElement: clearButton }}
      noResults={noMetrics}
      selectedItems={selected_metrics}
      popoverProps={Classes.MINIMAL}
    />


    return <Container>
      <Section>
        <Callout icon="info-sign" intent={Intent.WARNING} title="Work in Progress"/>

        <h1>SLAM Dashboard</h1>
        <p><a href="http://gitlab-srv/dvs/psp_swip/commits/develop"><img src="http://gitlab-srv/dvs/psp_swip/badges/develop/build.svg" alt="build status"/></a><a href="/s/branches/develop/coverage/index.html"> <img alt="coverage report" src="http://gitlab-srv/dvs/psp_swip/badges/develop/coverage.svg"/></a><a href="/s/branches/develop/doxygen/index.html"> <img src="https://img.shields.io/badge/docs-develop-green.svg" alt="documentation"/></a></p>

        <DateRangeInput
          value={date_range}
          maxDate={new Date()}
          allowSingleDayRange
          formatDate={date => (date == null ? "" : date.toLocaleDateString())}
          parseDate={str => new Date(Date.parse(str))}
          onChange={new_date_range => {this.setState({ date_range: new_date_range, isLoaded: false }, c => this.getData(this.props))} }
          shortcuts
        />
      </Section>
    
      <Section>
        <Card elevation={1}>
          <h2>Improvement over time</h2>
          <CommitsEvolution offer_breakdown_per_test={true} project={this.state.project} commits={commits} style={{marginTop: '20px'}}/>
       </Card>
      </Section>

      {false && <Section>
        <Card elevation={1}>
          <h2>KPI Status</h2>
          <span></span>
        </Card>
      </Section>}
              
      
      {false && <Section>
        <Card elevation={1}>
          <h2>Realtime on Android versus Linux on LSF</h2>
       </Card>
      </Section>}

      {false && <Section>
        <Card elevation={1}>
          <h2>Algorithmic bottlenecks</h2>
       </Card>
      </Section>}

      <Section>
        <Card elevation={0}>
          <h2>Review of each metric</h2>
          <MetricsSummary project='dvs/psp_swip' new_batch={android_batch} ref_batch={linux_batch} xaxis_labels={['Android', 'LSF']} />
       </Card>
      </Section>

      <Section>
        <Card elevation={0}>
          <h2>Review of individual tests</h2>

          <Tabs renderActiveTabPanelOnly id="tabs-outputs" onChange={(newTabId, prevTabId, event)=>{this.setState({selectedTabId: newTabId})}} selectedTabId={this.state.selectedTabId}>
            <Tab
              id="output-table-kpi"
              title="vs KPI"
              panel={
                <TableKpi
                  sort_order={this.state.sort_order}
                  sort_by={this.state.sort_by}
                  new_batch={android_batch}
                  ref_batch={linux_batch}
                  labels={['Android', 'LSF']}
                  metrics={selected_metrics}
                  input={metricTableSelect}
                />}
            />
            <Tab
              id="output-table-compare"
              title="Android vs LSF"
              panel={
                <TableCompare
                  sort_order={this.state.sort_order}
                  sort_by={this.state.sort_by}
                  new_batch={android_batch}
                  ref_batch={linux_batch}
                  labels={['Android', 'LSF']}
                  metrics={selected_metrics}
                  input={metricTableSelect}
                />}
            />
            <Tabs.Expander />
            <div className="pt-select">
              <select defaultValue={this.state.sort_by} onChange={this.selectSortBy}>
                <option value="test_input_path">Sort by Name</option>
                {Object.values(this.state.available_metrics).map(m => <option key={m.key} value={m.key}>Sort by {m.label}</option>)}
              </select>
              <select defaultValue="descending" onChange={this.selectOrder}>
                <option value={-1}>descending</option>
                <option value={1}>ascending</option>
              </select>
            </div>
          </Tabs>
       </Card>
      </Section>

    </Container>
  }
}




export { Dashboard };