import React from "react";
import { get } from "axios";
import moment from 'moment';

import { Intent, Callout } from "@blueprintjs/core";
import { DateRangeInput } from "@blueprintjs/datetime";
// import { Button, Icon, Intent, Tooltip, NonIdealState, Spinner, Tag, Callout } from "@blueprintjs/core";

import { Container, Section } from "./common/containers";
// import { groupBy, calendarStrings } from "./common/utils";

import { CommitsEvolution } from './CommitsEvolution'
import { slam_metrics, main_metrics } from './slam/metrics'
// import { shortId } from "./common/utils";



class Dashboard extends React.Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(this.props.location.search);
    let aggregation_metrics = {}
    main_metrics.forEach(m => aggregation_metrics[m] = slam_metrics[m].threshold)
    this.state = {
      project: 'dvs/psp_swip',
      date_range: [
        new Date(moment().subtract(31,'d')),
        new Date()
      ],
      error: null,
      isLoaded: false,
      commits: [],
      aggregation_metrics
    };
  }

  componentDidMount() {
    document.title = `Dashboard - ${this.state.project}`;   
    this.getData(this.props)
  }

  getData(props) {
    var url = '/api/v1/commits/origin/develop?only_when_first_pushed_as=true';
    const { project, date_range } = this.state;
    get(url, {
      params: {
        project,
        from: date_range[0],
        to: date_range[1],
        metrics: JSON.stringify(this.state.aggregation_metrics)
      },
    })
    .then(response => {
      let commits = response.data;
      this.setState({
        isLoaded: true,
        commits,
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

  render() {
    const { error, isLoaded, project, commits, date_range } = this.state;

    return <Container>
      <Section>
        <h1>Dashboard</h1>
        <Callout icon="info-sign" intent={Intent.WARNING} title="Work in Progress"/>
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
      <h2>Improvement over time</h2>
      <CommitsEvolution project={this.state.project} commits={commits} style={{marginTop: '20px'}}/>
      <p><a href="http://gitlab-srv/dvs/psp_swip/commits/develop"><img src="http://gitlab-srv/dvs/psp_swip/badges/develop/build.svg" alt="build status"/></a><a href="/s/branches/develop/coverage/index.html"> <img alt="coverage report" src="http://gitlab-srv/dvs/psp_swip/badges/develop/coverage.svg"/></a><a href="/s/branches/develop/doxygen/index.html"> <img src="https://img.shields.io/badge/docs-develop-green.svg" alt="documentation"/></a></p>

    </Section>
      
    <Section>
      <h2>Realtime on Android versus Linux on LSF</h2>
    </Section>

    <Section>
      <h2>Algorithmic bottlenecks</h2>
    </Section>

    <Section>
      <h2>Review of each metric</h2>
    </Section>

    <Section>
      <h2>Review of individual tests</h2>
    </Section>

    <Callout icon="info-sign" intent={Intent.PRIMARY} title="Dashboard" style={{marginBottom:'20px'}}>
      <p></p>
    </Callout>
    </Container>
  }
}




export { Dashboard };