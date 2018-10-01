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
  Intent,
  NonIdealState,
  Spinner,
  Callout
} from "@blueprintjs/core";
import { DateRangeInput } from "@blueprintjs/datetime";

import { CommitRow } from "./components/CommitRow";
import { Container, Section } from "./components/layout";
import { CommitsEvolution } from "./CommitsEvolution";
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
    const { is_loading, dispatch, project, date_range, aggregated_metrics, branch } = this.props;
    if (!is_loading)
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

    this.getData(this.props);
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
    else tag = "all latest commits";

    // commits.filter( c => c.batches.default!==undefined )
    // .map( c => c.batches.default.aggregated_metrics.translation_aape_average )
    let reference_branch = project_data.information.qatools_config.project.reference_branch;
    var information = (
      <>
        <Section>
          {project !== "dvs/psp_swip" && project !== "tof/swip_tof" && <Callout
              icon="info-sign"
              intent={Intent.PRIMARY}
              title="Want to view your CI results here?"
              style={{ marginBottom: "20px" }}
            >
              <p>
                Read the <a href="http://gitlab-srv/common-infrastructure/qatools/wikis/introduction">qatools introduction</a>.
              </p>
            </Callout>}
          <Callout
            icon="info-sign"
            intent={Intent.PRIMARY}
            title="Useful links"
            style={{ marginBottom: "20px" }}
          >
            <ul className={Classes.LIST}>
              <li>
                <a href={`http://gitlab-srv/${project}/pipelines`}>
                  Gitlab CI pipelines
                </a>
              </li>
              <li>
                <Link to={`/dashboard?project=${project}`}>Dashboard</Link>
              </li>
              <li>
                <a href="http://gitlab-srv/dvs/psp_swip/wikis/faq/ci-failures">
                  FAQ: When did my CI fail?
                </a>
              </li>
            </ul>
          </Callout>
        </Section>
        <Section>
          <h3 className={Classes.HEADING}>
            Reports for{" "}
            <Link to={`/branch/origin/${reference_branch}?project=${project}`}>
              <Button icon="git-branch">develop</Button>
            </Link>
          </h3>
          <p>
            <a href={`http://gitlab-srv/${project}/commits/${reference_branch}`}>
              <img
                src={`http://gitlab-srv/${project}/badges/${reference_branch}/build.svg`}
                alt="build status"
              />
            </a>
            <a href={`/s/${project}/branches/develop/coverage/index.html`}>
              {" "}
              <img
                alt="coverage report"
                src={`http://gitlab-srv/${project}/badges/${reference_branch}/coverage.svg`}
              />
            </a>
            {<a href={`/s/${project}/branches/${reference_branch}/doxygen/index.html`}>
              {" "}
              <img
                src={`https://img.shields.io/badge/docs-${reference_branch}-blue.svg`}
                alt="documentation"
              />
            </a>}
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
    var effective_date_range = date_range;
    if (commits.length > 0){
      effective_date_range = [
        new Date(commits[commits.length - 1].authored_datetime),
        new Date(commits[0].authored_datetime)
      ]
    }

    let qa_report = (
      <Section>
        {is_loaded &&
          !error && (
            <div>
              <h3 className={Classes.HEADING}>Evolution for {link_to_tag}</h3>
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
              <CommitsEvolution
                project={project}
                project_data={project_data}
                commits={commits}
                style={{ marginTop: "20px" }}
              />
            </div>
          )}
      </Section>
    );

    var list;
    var warning_messages = <>
      {error && <NonIdealState description={error.message} icon="error" />}
      {is_loading && <NonIdealState title="Loading" icon={<Spinner />} />}
      {is_loaded && !error && commits.length === 0 &&
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
        <h3 className={Classes.HEADING}>Selected commits</h3>
        {Object.keys(commits_by_day).map(day => (
          <React.Fragment key={day}>
            <HeaderDay>
              <Moment
                calendar={calendarStrings}
                tz="Asia/Jerusalem"
                date={day}
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
        {is_loaded && commits.length>0 && list}
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
      commits: commits_data.ids.map(id=>state.commits[id]),
      error: commits_data.error,
      is_loaded: commits_data.is_loaded,
      is_loading: commits_data.is_loading,
    };
}

export default withRouter(connect(mapStateToProps)(CiCommitList) );
