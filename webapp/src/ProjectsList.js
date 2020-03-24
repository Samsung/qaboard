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
import { project_avatar_style } from "./utils"


class LastCommitAt extends Component {
  render() {
    const { project, className } = this.props;
    let date_commit = project.latest_commit_datetime;
    let date_output = project.latest_output_datetime || project.data.latest_output_datetime;
    let date = date_output || date_commit
    return (
      <span className={className} style={{marginBottom: '5px'}}>
        <Tooltip content={date}>
          <span style={{ color: "#555"}}>latest {!!date_output ? "output" : "commit"} <Moment
            fromNow
            {...!!date_output ? {utc: true} : {tz: "Asia/Jerusalem"}}
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

    const empty_projects = <NonIdealState
      icon="folder-open"
      title="Your projects are not connected to QA-Board yet"
      description={<p>Learn how to to <a href="https://samsung.github.io/qaboard/docs/installation">get started</a>.</p>}
    />;
    let list_projects = Object.keys(projects).length === 0 ? empty_projects : (
      <div>
        {Object.entries(projects)
          .sort(
            ([id0, d0], [id1, d1]) => {
              let fav0 = projects[id0].is_favorite || false
              let fav1 = projects[id1].is_favorite || false
              if (fav0 === fav1) {
                let date0 = d0.latest_output_datetime || (d0.data || {}).latest_output_datetime;
                let date1 = d1.latest_output_datetime || (d1.data || {}).latest_output_datetime;
                if (!!date1  && !!!date0) return 1
                if (!!!date1 &&  !!date0) return -1
                if (!!!date1 && !!!date0) return new Date(d1.latest_commit_datetime) - new Date(d0.latest_commit_datetime)
                return new Date(date1) - new Date(date0);
              }
              else
                return fav1 - fav0;
            }
          )
          .map(([project_id, details]) => {
            let data = details.data || {};
            let git = data.git || {};
            let qatools_config_project = (data.qatools_config || {}).project || {};
            if (details.latest_commit_datetime === undefined || details.latest_commit_datetime === null)
              return <span key={project_id}/>

            const gitlab_host = (git.web_url || 'https://gitlab.com/').split('/').slice(0,3).join('/')
            const avatar_url = qatools_config_project.avatar_url || 
                               !!git.avatar_url ? (git.avatar_url.startsWith('http')
                                                  ? git.avatar_url
                                                  : `${gitlab_host}${git.avatar_url}`)
                                                : null

            const is_subproject = git.path_with_namespace !== project_id;
            const has_custom_avatar = !!((data.qatools_config || {}).project || {}).avatar_url
            const should_tweak_image = is_subproject && !has_custom_avatar;
            const avatar_style = should_tweak_image ? project_avatar_style(project_id) : null;
            // console.log(project_id, `is_subproject:${is_subproject}`, `has_custom_avatar:${has_custom_avatar}`, `should_tweak_image:${should_tweak_image}`)

            return (
              <Card
                key={project_id}
                style={{ margin: "15px", display: 'flex', alignItems: 'center'}}
                elevation={2}
              >
                <div style={{'alignSelf': 'center', flex: '0 0 auto', 'marginRight': '10px'}}>
                  <Avatar
                    src={avatar_url}
                    img_style={avatar_style}
                    href={`/${project_id}`}
                    alt={git.name || project_id}
                    onClick={() => this.props.dispatch(updateSelected(project_id))}
                  />
                </div>
                <div style={{'alignSelf': 'center', 'minWidth': 0}}>
                  <h5 className={Classes.HEADING}><Link onClick={() => this.props.dispatch(updateSelected(project_id))} to={`/${project_id}`}>{project_id}</Link></h5>                  
                  {git.description && <p style={{marginTop: '5px', marginBottom: '0px'}} className={Classes.TEXT_MUTED}>{qatools_config_project.description || git.description}</p>}
                </div>
                <div style={{'alignSelf': 'center', 'marginLeft': 'auto', textAlign: 'right', flex: '0 0 auto'}}>
                  <p style={{marginBottom: '5px'}}>
                    <Tooltip><Icon icon={projects[project_id].is_favorite ? "star" : "star-empty"} onClick={() => this.props.dispatch(updateFavorite(project_id, !!!projects[project_id].is_favorite)) } style={{color: Colors.GOLD5}}/><span>Pin on top of the list.</span></Tooltip>
                    <a href={git.homepage}><Button icon="git-repo" minimal round text="code" style={{color: 'rgb(85, 85, 85)'}}/></a>
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
          <h4 className={Classes.HEADING}>Get started with QA-Board</h4>
          <p>
            Read <a href={`${process.env.REACT_APP_QABOARD_DOCS_ROOT}docs/introduction`}>the docs </a> or check out the code on <a href="https://github.com/Samsung/qaboard">github.com</a>!
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
