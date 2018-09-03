import React, { Component } from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import { Link } from "react-router-dom";

import Moment from "react-moment";

import { Container } from "./common/containers";
import {
  Classes,
  Intent,
  Card,
  Callout,
  NonIdealState,
  Spinner
} from "@blueprintjs/core";
import { Icon, Tooltip } from "@blueprintjs/core";

import { fetchProjects } from './actions/projects'


class LastCommitAt extends Component {
  render() {
    const { project, className } = this.props;
    let date = project.latest_commit_datetime;
    return (
      <span className={className}>
        <Icon style={{ color: "#1aaa55", marginRight: "3px" }} icon="updated" />
        <Tooltip content={date}>
          <Moment
            style={{ color: "#555" }}
            fromNow
            tz="Asia/Jerusalem"
            date={date}
          />
        </Tooltip>
      </span>
    );
  }
}

class ProjectsList extends Component {
  componentDidMount() {
    this.props.dispatch(fetchProjects())
  }

  render() {
    const { error, is_loaded, projects } = this.props;
    console.log(this.props)
    let warnings;
    if (error)
      warnings = <NonIdealState description={error.message} icon="error" />;
    if (!is_loaded)
      warnings = <NonIdealState title="Loading projects..." icon={<Spinner />} />;

    let list_projects = (
      <div>
        {Object.entries(projects)
          .sort(
            ([id0, d0], [id1, d1]) =>
              new Date(d1.latest_commit_datetime) -
              new Date(d0.latest_commit_datetime)
          )
          .map(([id, details]) => {
            return (
              <Card
                key={id}
                style={{ margin: "15px" }}
                interactive
                elevation={2}
                onClick={e => this.props.history.push(`/?project=${id}`)}
              >
                <h5 className={Classes.HEADING}>
                  <Link to={`/?project=${id}`}>{id}</Link>{" "}
                  {details.information &&
                    details.information.git && (
                      <a href={details.information.git.homepage}>
                        <Icon icon="link" />
                      </a>
                    )}
                </h5>
                <LastCommitAt project={details} />
                <br />
                <span style={{ color: "#555" }}>
                  {details.total_commits} commits
                </span>
              </Card>
            );
          })}
      </div>
    );

    return (
      <Container>
        <Callout intent={Intent.PRIMARY}>
          <h4 className={Classes.HEADING}>Your project is missing?</h4>
          <p>
            Learn about <a href="http://gitlab-srv/common-infrastructure/qatools/wikis/step-by-step-tutorial">qatools</a>!
          </p>
        </Callout>
        {warnings}
        {list_projects}
      </Container>
    );
  }
}


const mapStateToProps = state => {
  return {
    error: state.projects.error || null,
    is_loaded: state.projects.is_loaded || false,
    projects: state.projects.data,
  }
}

export default withRouter(connect(mapStateToProps)(ProjectsList) );
