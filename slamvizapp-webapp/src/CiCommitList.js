import React from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import { Link } from "react-router-dom";
import qs from "qs";
import styled from "styled-components";

import Moment from "react-moment";
import "moment-timezone";

import {
  Classes,
  Button,
  NonIdealState,
  Spinner,
} from "@blueprintjs/core";
import { DateRangeInput } from "@blueprintjs/datetime";

import CommitRow from "./components/CommitRow";
import { Container, Section } from "./components/layout";
import CommitsEvolution from "./CommitsEvolution";
import { groupBy, calendarStrings } from "./utils";

import { fetchCommits } from './actions/projects'
import { default_project, default_commits_data, default_date_range } from "./defaults"

import { Toaster } from "@blueprintjs/core";

export const toaster = Toaster.create();

const HeaderDay = styled.li`
  border-top-width: 0;
  padding: 5px 10px;
  background-color: #fafafa;
  border-bottom: 1px solid #eee;
  border-top: 1px solid #eee;
  font-size: 14px;
`;

const DayRows = styled.li``;

const WrapperCommitRows = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
`;

const CommitRows = ({ commits, project, project_data, className }) => (
  <div className={className}>
    <DayRows>
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
    </DayRows>
  </div>
);

class CiCommitList extends React.Component {

  componentDidUpdate(prevProps) {
    let changed = (this.props.project            !== prevProps.project            ||
                   this.props.branch.name        !== prevProps.branch.name        ||      
                   this.props.branch.committer   !== prevProps.branch.committer)
    if (!this.props.is_loading && changed) {
      this.getData(this.props);
    }
  }

  getData(props) {
    const { dispatch, project, date_range, aggregated_metrics, branch } = props;
    dispatch(fetchCommits(project, branch, date_range, aggregated_metrics))
  }

  componentDidMount() {
    const { project, branch } = this.props;
    document.title = branch.name || branch.committer || project;    
    let query = qs.parse(this.props.location.search.substring(1));
    this.props.history.push({
      pathname: this.props.location.pathname,
      search: qs.stringify({
        ...query,
        project,
      })
    });

    this.getData({...this.props, date_range: default_date_range});
    this.interval = setInterval(x => this.getData(this.props), 60 * 1000);
  }

  componentWillUnmount() {
    clearInterval(this.interval);
  }

  render() {
    const { error, is_loaded, is_loading, project, project_data, branch, commits, date_range } = this.props;
    let is_committer = !!branch.committer;
    let is_branch = !!branch.name;
    if (is_branch || is_committer)
      var tag = branch.name || branch.committer;
    else tag = "Latest commits";

    // commits.filter( c => c.batches.default!==undefined )
    // .map( c => c.batches.default.aggregated_metrics.translation_aape_average )
    let reference_branch = project_data.information.qatools_config.project.reference_branch;
    let ci_root = project_data.information.qatools_config.ci_root.linux.replace("/home/arthurf/ci", "")
    let project_repo = project_data && project_data.information && project_data.information.git && project_data.information.git.path_with_namespace;
    var information = (
      <>
        <Section>
          <h3 className={Classes.HEADING}>
            Status{" "}
            <Link to={`/branch/origin/${reference_branch}?project=${project}`}>
              <Button icon="git-branch">{reference_branch}</Button>
            </Link>
          </h3>
          <p>
            <a href={`http://gitlab-srv/${project_repo}/pipelines`}>
              <img
                src={`http://gitlab-srv/${project_repo}/badges/${reference_branch}/build.svg`}
                alt="build status"
              />
            </a>
            <Link to={`/dashboard?project=${project}`}>
              {" "}
              <img
                src={`https://img.shields.io/badge/dashboard-${reference_branch}-9933CC.svg`}
                alt="dashboard"
              />
            </Link>
            <a href={`/s${ci_root}/${project}/branches/${reference_branch}/doxygen/index.html`}>
              {" "}
              <img
                src={`https://img.shields.io/badge/docs-${reference_branch}-blue.svg`}
                alt="documentation"
              />
            </a>
            <a href={`/s${ci_root}/${project}/branches/${reference_branch}/coverage/index.html`}>
              {" "}
              <img
                alt="coverage report"
                src={`http://gitlab-srv/${project_repo}/badges/${reference_branch}/coverage.svg`}
              />
            </a>
          </p>
        </Section>
      </>
    );

    let link_to_tag = is_branch ? (
      <Link to={`/branch/${tag}?project=${project}`}>
        <Button icon="git-branch">{tag}</Button>
      </Link>
    ) : is_committer ? (
      <Link to={`/committer/${tag}?project=${project}`}>
        <Button icon="user">{tag}</Button>
      </Link>
    ) : (
      tag
    );

    let some_commits_loaded = !!commits && commits.length > 0;

    var effective_date_range = date_range;
    if (some_commits_loaded){
      let first_commit_date = commits[commits.length - 1].authored_datetime || date_range[0]
      let last_commit_date = commits[0].authored_datetime  || date_range[1]
      effective_date_range = [
        (!!first_commit_date ? new Date(first_commit_date) : null),
        (!!first_commit_date ? new Date(last_commit_date) : null)
      ]
    }
    let qa_report = (
      <Section>
        {(is_loaded || some_commits_loaded) &&
          !error && (
            <div>
              <h3 className={Classes.HEADING}>{link_to_tag}</h3>
              <DateRangeInput
                value={effective_date_range}
                maxDate={new Date()}
                allowSingleDayRange
                formatDate={date =>
                  date == null ? "" : date.toLocaleDateString()
                }
                parseDate={str => new Date(Date.parse(str))}
                onChange={new_date_range => {
                  const { project, branch, aggregated_metrics, dispatch } = this.props; 
                  dispatch(fetchCommits(project, branch, new_date_range, aggregated_metrics))
                }}
                shortcuts
              />
              {(is_branch || is_committer) && <CommitsEvolution
                project={project}
                project_data={project_data}
                commits={commits}
                style={{ marginTop: "20px" }}
              />}
            </div>
          )}
      </Section>
    );

    var list;
    var warning_messages = <>
      {error && <NonIdealState description={error.message} icon="error" />}
      {is_loading && !some_commits_loaded && <NonIdealState title="Loading" icon={<Spinner />} />}
      {is_loaded && !error && !some_commits_loaded &&
      <NonIdealState
          title="No results"
          description={`Searched commits from ${date_range[0]} to ${
            date_range[1]
          }`}
          icon="folder-open"
      />}
    </>

    let commits_by_day = groupBy(commits, "authored_date");
    list = (
      <>
        {Object.keys(commits_by_day).map(day => (
          <React.Fragment key={day}>
            <HeaderDay>
              <Moment
                calendar={calendarStrings}
                tz="Asia/Jerusalem"
                date={day !== "undefined" ? day : null}
              />{" "}
              &#8212; {commits_by_day[day].length} commits
            </HeaderDay>
            <CommitRows project={project} project_data={project_data} commits={commits_by_day[day]} />
          </React.Fragment>
        ))}
      </>
    );
    return (
      <Container>
        {information}
        {qa_report}
        {warning_messages}
        {(is_loaded || some_commits_loaded) && list}
      </Container>
    );
  }
}




const mapStateToProps = (state, ownProps) => {
    const params = new URLSearchParams(ownProps.location.search);
    let project = params.get("project") || state.selected.project;
    let project_data = state.projects.data[project] || default_project

    let project_metrics = project_data.information.qatools_metrics
    let aggregated_metrics = {};
    project_metrics.main_metrics.forEach(
      m =>
        (aggregated_metrics[m] = project_metrics.available_metrics[m].target)
    );

    var branch;
    if (ownProps.match.path.startsWith("/committer")) {
      branch = {committer: ownProps.match.params[0]}
    } else {
      branch = {name: ownProps.match.params[0]}
    }
    let branch_key = branch.name || branch.committer || 'default'
    let commits_data = project_data.commits[branch_key] || default_commits_data;

    return {
      project,
      project_data,
      branch,
      aggregated_metrics,
      date_range: commits_data.date_range || default_date_range,
      commits: commits_data.ids.map(id=> state.commits[id] || {id, batches: {}}),
      error: commits_data.error,
      is_loaded: commits_data.is_loaded,
      is_loading: commits_data.is_loading,
    };
}

export default withRouter(connect(mapStateToProps)(CiCommitList) );
