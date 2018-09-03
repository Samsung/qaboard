import React, { Fragment } from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import { Link } from "react-router-dom";
import styled from "styled-components";

import Moment from "react-moment";
import moment from "moment";
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

import { CommitRow } from "./CommitRow";
import { Container, Section } from "./common/containers";
import { groupBy, calendarStrings } from "./common/utils";
import { CommitsEvolution } from "./CommitsEvolution";

import { fetchCommits } from './actions'
import { default_project, default_reference_data, default_date_range } from "./defaults"

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

const CommitRows = ({ commits, project, className }) => (
  <div className={className}>
    <DayRows>
      <WrapperCommitRows>
        {commits.map(commit => (
          <CommitRow
            commit={commit}
            project={project}
            key={commit.id}
            toaster={toaster}
          />
        ))}
      </WrapperCommitRows>
    </DayRows>
  </div>
);

class CiCommitList extends React.Component {

  componentWillReceiveProps(nextProps) {
    let changed = (this.props.project            !== nextProps.project             ||
                   this.props.reference          !== nextProps.reference           ||      
                   this.props.aggregated_metrics!== nextProps.aggregated_metrics   ||
                   this.props.date_range         !== nextProps.date_range           )
    if (!nextProps.is_loading && changed) {
      this.getData(nextProps);
    }
  }

  getData(props) {
    const { is_loading, dispatch, project, date_range, aggregated_metrics, reference } = this.props;
    if (!is_loading)
      dispatch(fetchCommits(project, reference, date_range, aggregated_metrics))
  }

  componentDidMount() {
    const { match, project } = this.props;
    document.title = match.params[0] || project;    

    this.getData(this.props);
    this.interval = setInterval(x => this.getData(this.props), 60 * 1000);
  }

  componentWillUnmount() {
    clearInterval(this.interval);
  }

  render() {
    const { error, is_loaded, is_loading, project, project_data, commits, date_range } = this.props;
    const { match } = this.props;
    let is_committer = match.path.startsWith("/committer");
    let is_branch = match.path.startsWith("/branch");
    if (is_branch || is_committer) var tag = this.props.match.params[0];
    else tag = "all latest commits";

    // commits.filter( c => c.batches.default!==undefined )
    // .map( c => c.batches.default.aggregated_metrics.translation_aape_average )
    let reference_branch = project_data.information.qatools_config.project.reference_branch;
    var information = (
      <Fragment>
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
      </Fragment>
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
    let qa_report = (
      <Section>
        {is_loaded &&
          !error && (
            <div>
              <h3 className={Classes.HEADING}>Evolution for {link_to_tag}</h3>
              <DateRangeInput
                value={date_range}
                maxDate={new Date()}
                allowSingleDayRange
                formatDate={date =>
                  date == null ? "" : date.toLocaleDateString()
                }
                parseDate={str => new Date(Date.parse(str))}
                onChange={new_date_range => {
                  this.setState(
                    { date_range: new_date_range, is_loaded: false },
                    c => this.getData(this.props)
                  );
                }}
                shortcuts
              />
              <CommitsEvolution
                project={project}
                commits={commits}
                style={{ marginTop: "20px" }}
              />
            </div>
          )}
      </Section>
    );

    var list;
    var warning_messages;
    if (error)
      warning_messages = (
        <NonIdealState description={error.message} icon="error" />
      );
    if (is_loading)
      warning_messages = <NonIdealState title="Loading" icon={<Spinner />} />;
    if (commits.length === 0 && is_loaded)
      warning_messages = (
        <NonIdealState
          title="No results"
          description={`Searched commits from ${date_range[0]} to ${
            date_range[1]
          }`}
          icon="folder-open"
        />
      );

    let commits_by_day = groupBy(commits, "authored_date");

    list = (
      <Fragment>
        <h3 className={Classes.HEADING}>Selected commits</h3>
        {Object.keys(commits_by_day).map(day => (
          <Fragment key={day}>
            <HeaderDay>
              <Moment
                calendar={calendarStrings}
                tz="Asia/Jerusalem"
                date={day}
              />{" "}
              &#8212; {commits_by_day[day].length} commits
            </HeaderDay>
            <CommitRows project={project} commits={commits_by_day[day]} />
          </Fragment>
        ))}
      </Fragment>
    );
    return (
      <Container>
        {information}
        {qa_report}
        {warning_messages}
        {is_loaded && list}
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
        (aggregated_metrics[m] = project_metrics.available_metrics[m].threshold)
    );

    var reference;
    if (ownProps.match.path.startsWith("/committer")) {
      reference = {committer: ownProps.match.params[0]}
    } else {
      reference = {name: ownProps.match.params[0]}
    }
    // console.log(reference)
    let reference_key = reference.name || reference.committer || 'default'
    let reference_data = project_data.commits[reference_key] || default_reference_data;
    // console.log(reference_key)
    // console.log(project_data.commits)
    // console.log(project_data)
    return {
      project,
      project_data,
      reference,
      aggregated_metrics,
      date_range: reference_data.date_range || default_date_range,
      commits: reference_data.ids.map(id=>state.commits[id]),
      error: reference_data.error,
      is_loaded: reference_data.is_loaded,
      is_loading: reference_data.is_loading,
    };
}

export default withRouter(connect(mapStateToProps)(CiCommitList) );
