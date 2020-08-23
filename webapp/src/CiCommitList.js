import React from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import styled from "styled-components";

import Moment from "react-moment";

import {
  Classes,
  NonIdealState,
  Spinner,
  Card,
  Toaster,
} from "@blueprintjs/core";

import CommitRow from "./components/CommitRow";
import { Container, Section } from "./components/layout";
import CommitsEvolution from "./CommitsEvolution";
import { groupBy, calendarStrings, match_query } from "./utils";

import { fetchCommits } from './actions/projects'
import { default_date_range } from './defaults'
import {
	projectSelector,
	projectDataSelector,
	commitsDataSelector,
	commitsSelector,
  selectedSelector,
} from './selectors/projects'


export const toaster = Toaster.create();


const WrapperCommitRows = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
`;

const CommitRows = ({ commits, project, project_data, className }) => (
  <div className={className}>
    <li>
      <WrapperCommitRows>
        {commits.map(commit => (
          <CommitRow
            commit={commit}
            project={project}
            project_data={project_data}
            key={commit.id}
            toaster={toaster}
          />
        ))}
      </WrapperCommitRows>
    </li>
  </div>
);

class CiCommitList extends React.Component {

  componentDidUpdate(prevProps) {
    let changed = (this.props.project               !== prevProps.project              ||
                   this.props.match.params.name     !== prevProps.match.params.name    ||      
                   this.props.match.params.committer!== prevProps.match.params.committer)
    if (!this.props.is_loading && changed) {
      this.getData(this.props);
    }
  }

  getData(props) {
    const { dispatch, project, date_range, aggregated_metrics, match } = props;
    const extended_date_range = [date_range[0], date_range[1]]
    extended_date_range[0].setHours(0,0,0,0);
    extended_date_range[1].setHours(23,59,59,999);
    dispatch(fetchCommits(project, {...match.params}, extended_date_range, aggregated_metrics))
  }

  componentDidMount() {
    const { project, match } = this.props;
    let name = this.props.project.split('/').slice(-1)[0];
    document.title = `${match.params.name || match.params.committer || project} - ${name}`;

    this.getData({...this.props, date_range: default_date_range()});
    this.interval = setInterval(x => this.getData(this.props), 60 * 1000);
  }

  componentWillUnmount() {
    clearInterval(this.interval);
  }

  render() {
    const { error, is_loaded, is_loading, project, match, project_data, commits, date_range } = this.props;
    let is_branch = !!match.params.name;

    let some_commits_loaded = !!commits && commits.length > 0;
    let show_metrics_over_time = (is_loaded || some_commits_loaded) && !error && is_branch;
    let qa_report = show_metrics_over_time && <Section>
      <Card>
        <CommitsEvolution
          project={project}
          project_data={(is_branch && some_commits_loaded && commits[0]) || project_data}
          commits={commits}
          per_output_granularity={false}
          dispatch={this.props.dispatch}
          style={{ marginTop: "20px" }}
        />
      </Card>
    </Section>;

    var list;
    var warning_messages = <>
      {error && <NonIdealState description={error.message} icon="error" />}
      {is_loading && !some_commits_loaded && <NonIdealState title="Loading" icon={<Spinner />} />}
      {is_loaded && !is_loading && !error && !some_commits_loaded &&
      <NonIdealState
          title="Could not find a commit with results"
          description={<span>Searched {" "}
            <strong>from <Moment fromNow date={date_range[0]} title={date_range[0]}/></strong>
            {" "}to{" "}
            {date_range[1] > new Date() ? "today" : <strong><Moment fromNow date={date_range[1]} title={date_range[1]}/></strong>}
          </span>}
          icon="search"
      />}
    </>

    let commits_by_day = groupBy(commits, "authored_date");
    list = (
      <>
        {Object.keys(commits_by_day).map(day => (
          <Card key={day} elevation={0} style={{marginBottom: '15px'}}>
            <h4 className={Classes.HEADING}>
              {(!!day && day !== "undefined") ? <><Moment
                calendar={calendarStrings}
                date={day}
              />{" "}
              &#8212; {commits_by_day[day].length} commits</> : `${commits_by_day[day].length} commits`}
            </h4>
            <CommitRows project={project} project_data={project_data} commits={commits_by_day[day]} />
          </Card>
        ))}
      </>
    );
    return (
      <Container style={{paddingTop: '50px'}}>
        {qa_report}
        {warning_messages}
        {(is_loaded || some_commits_loaded) && list}
      </Container>
    );
  }
}



const commit_search = c => {
  const batches = Object.keys(c.batches).join('|')
  return `${c.committer_name} ${c.message} ${c.branch} ${batches}`
}


const mapStateToProps = (state, ownProps) => {
    const project = projectSelector(state)
    const project_data = projectDataSelector(state)
    const commits_data = commitsDataSelector(state)
    const commits = commitsSelector(state)

    let is_branch = !!ownProps.match.params.name;
    let some_commits_loaded = !!commits && commits.length > 0;
    let project_data_ = (is_branch && some_commits_loaded && commits[0]) || project_data
    let project_metrics = project_data_.data?.qatools_metrics || {};

    let aggregated_metrics = {};
    (project_metrics.main_metrics || []).forEach(m => {
      aggregated_metrics[m] = project_metrics.available_metrics[m].target ?? 0
    });


    const { search } = selectedSelector(state)
    let matcher = match_query(search)
    let commits_filtered = commits.filter(c => matcher(commit_search(c)))

    return {
      project,
      project_data,
      search,
      aggregated_metrics,
      date_range: commits_data.date_range,
      commits: commits_filtered,
      error: commits_data.error,
      is_loaded: commits_data.is_loaded,
      is_loading: commits_data.is_loading,
    };
}

export default withRouter(connect(mapStateToProps)(CiCommitList) );
