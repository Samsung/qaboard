import React, { Component } from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import { Link } from "react-router-dom";

import Moment from "react-moment";

import {
  Classes,
  Colors,
  Intent,
  Card,
  Icon,
  Button,
  Callout,
  Tooltip,
  NonIdealState,
  Spinner
} from "@blueprintjs/core";
import { Container } from "./components/layout";
import { Avatar } from "./components/avatars";

import { fetchProjects, updateFavorite } from './actions/projects'
import { updateSelected } from './actions/selected'


class LastCommitAt extends Component {
  render() {
    const { project, className } = this.props;
    let date = project.latest_commit_datetime;
    return (
      <span className={className} style={{marginBottom: '5px'}}>
        <Tooltip content={date}>
          <span style={{ color: "#555"}}>updated <Moment
            fromNow
            tz="Asia/Jerusalem"
            date={date}
          /></span>
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
    let warnings;
    if (error)
      warnings = <NonIdealState description={error.message} icon="error" />;
    if (!is_loaded && Object.keys(projects).length===0 )
      warnings = <NonIdealState title="Loading projects..." icon={<Spinner />} />;

    let list_projects = (
      <div>
        {Object.entries(projects)
          .sort(
            ([id0, d0], [id1, d1]) => {
              let fav0 = projects[id0].is_favorite || false
              let fav1 = projects[id1].is_favorite || false
              if (fav0 === fav1)
                return new Date(d1.latest_commit_datetime) - new Date(d0.latest_commit_datetime);
              else
                return fav1 - fav0;
            }
          )
          .map(([project_id, details]) => {
            let git = details.data.git || {};
            if (details.latest_commit_datetime === undefined || details.latest_commit_datetime === null)
              return <span key={project_id}/>

            return (
              <Card
                key={project_id}
                style={{ margin: "15px", display: 'flex', alignItems: 'center'}}
                elevation={2}
              >
                <div style={{'alignSelf': 'center', flex: '0 0 auto', 'marginRight': '10px'}}>
                  <Avatar
                    src={!!git.avatar_url ? `http://gitlab-srv${git.avatar_url}` : null}
                    href={`/${project_id}`}
                    alt={git.name || project_id}
                    onClick={() => this.props.dispatch(updateSelected(project_id))}
                  />
                </div>
                <div style={{'alignSelf': 'center', 'minWidth': 0}}>
                  <h5 className={Classes.HEADING}><Link onClick={() => this.props.dispatch(updateSelected(project_id))} to={`/${project_id}`}>{project_id}</Link></h5>                  
                  {git.description && <p style={{marginTop: '5px', marginBottom: '0px'}} className={Classes.TEXT_MUTED}>{git.description}</p>}
                </div>
                <div style={{'alignSelf': 'center', 'marginLeft': 'auto', textAlign: 'right', flex: '0 0 auto'}}>
                  <p style={{marginBottom: '5px'}}>
                    <Icon icon={projects[project_id].is_favorite ? "star" : "star-empty"} onClick={() => this.props.dispatch(updateFavorite(project_id, !!!projects[project_id].is_favorite)) } style={{color: Colors.GOLD5}}/>
                    <a href={git.homepage}><Button icon="code" minimal round text="code" style={{color: 'rgb(85, 85, 85)'}}/></a>
                  </p>
                  <p style={{marginBottom: '5px'}}><LastCommitAt project={details} /></p>
                  <p style={{marginBottom: '0px'}}><span style={{ color: "#555" }}>
                    {details.total_commits} commits
                  </span></p>
                </div>
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
