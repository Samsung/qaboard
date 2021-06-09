import React, { Component } from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import { Link } from "react-router-dom";

import { DateTime } from 'luxon';

import {
  Classes,
  Colors,
  Card,
  Button,
  Icon,
  Tag,
  Intent,
  InputGroup,
  Tooltip,
  NonIdealState,
  Spinner,
  Navbar,
  NavbarDivider,
  NavbarGroup,
  NavbarHeading,
  Alignment,
} from "@blueprintjs/core";
import { Container } from "./components/layout";
import { Avatar } from "./components/avatars";
import AuthButton from "./components/authentication/Auth"

import { fetchProjects, updateFavorite } from './actions/projects'
import { updateSelected } from './actions/selected'
import { match_query } from "./utils"
import { project_avatar_style, git_hostname, default_git_hostname } from "./utils"


class LastCommitAt extends Component {
  render() {
    const { project, className } = this.props;
    let date_commit = project.latest_commit_datetime;
    let date_output = project.latest_output_datetime || project.data.latest_output_datetime;
    let date = date_output || date_commit
    return (
      <span className={className} style={{marginBottom: '5px'}}>
        <Tooltip content={date}>
          <span style={{ color: "#555"}}>latest {!!date_output ? "output" : "commit"}
          {" "}
          <span title={date}>{DateTime.fromISO(date).toRelative()}</span>
          </span>
        </Tooltip>
      </span>
    );
  }
}

class ProjectsList extends Component {
  constructor(props) {
    super(props);
    this.state = {
      query: null,
    };
  }

  componentDidMount() {
    this.props.dispatch(fetchProjects())
  }

  render() {
    const { error, is_loaded, projects } = this.props;
    const { query } = this.state;
    let warnings;
    if (error)
      warnings = <NonIdealState description={error.message} icon="error" />;
    if (!is_loaded && Object.keys(projects).length===0 )
      warnings = <NonIdealState title="Loading projects..." icon={<Spinner />} />;

    const empty_projects = <div style={{marginTop: '10vh'}}>
      <NonIdealState    
        icon="heatmap"
        title="No projects yet."
        intent={Intent.PRIMARY}
        description={<p>Learn how to to <a href="https://samsung.github.io/qaboard/docs/installation">get started, and<br/><a href="https://spectrum.chat/qaboard">chat with the maintainers</a> if you run into issues</a>.</p>}
      />
    </div>;

    const matcher = match_query(query)
    let rendered_projects = Object.entries(projects)
                            .filter( ([id, data]) => matcher(id))
    let list_projects = rendered_projects.length === 0 ? empty_projects : (
      <div>
        {rendered_projects
          .sort(
            ([id0, d0], [id1, d1]) => {
              let fav0 = projects[id0].is_favorite || false
              let fav1 = projects[id1].is_favorite || false
              if (fav0 === fav1) {
                let date0 = d0.latest_output_datetime || d0.data?.latest_output_datetime;
                let date1 = d1.latest_output_datetime || d1.data?.latest_output_datetime;
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
            let qatools_config_project = data.qatools_config?.project || {};
            if (details.latest_commit_datetime === undefined || details.latest_commit_datetime === null)
              return <span key={project_id}/>

            const project_git_hostname = git_hostname(data.qatools_config) ?? default_git_hostname
            git.web_url = git.web_url ?? `${project_git_hostname}/${git.path_with_namespace}`
            const gitlab_host = git.web_url.split('/').slice(0,3).join('/')
            let avatar_url = qatools_config_project.avatar_url ?? git.avatar_url
            if (!!avatar_url && avatar_url.startsWith(gitlab_host)) {
              avatar_url = encodeURI(`/api/v1/gitlab/proxy?url=${avatar_url}`)
            }
            const is_subproject = git.path_with_namespace !== project_id;
            const has_custom_avatar = !!data.qatools_config?.project?.avatar_url
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
                    <Tooltip>
                      <Button
                        minimal
                        icon={<Icon
                          icon={projects[project_id].is_favorite ? "star" : "star-empty"}
                          onClick={() => this.props.dispatch(updateFavorite(project_id, !!!projects[project_id].is_favorite)) }
                          style={{color: Colors.GOLD5}}
                        />}
                      />
                      <span>Pin on top of the list.</span>
                    </Tooltip>
                    <a href={git.web_url} style={{textDecoration: "none"}}><Button icon="git-repo" minimal round text="Source" style={{color: 'rgb(85, 85, 85)'}}/></a>
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

    const github_cat = <>
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="#fff">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
        </svg>
      </>

    return (
      <>
        <Navbar className={Classes.DARK}>
            <NavbarGroup align={Alignment.LEFT}>
                <NavbarHeading><b>QA-Board</b></NavbarHeading>
                <NavbarDivider />
                <a href="https://github.com/Samsung/qaboard"><Button className={Classes.MINIMAL} icon={github_cat} text="GitHub" style={{color : "#fff"}}/></a>
                <a href={`${process.env.REACT_APP_QABOARD_DOCS_ROOT}docs/introduction`}><Button className={Classes.MINIMAL} icon={<Icon icon="help" color="#fff"/>} text="Docs" style={{color : "#fff"}}/></a>
            </NavbarGroup>
            <NavbarGroup align={Alignment.RIGHT}>
              <AuthButton/>
            </NavbarGroup>
        </Navbar>
        <Container>
          <div style={{display: "flex", justifyContent: "space-between", alignItems: "baseline"}}>
            <div style={{width: '300px', marginTop: '30px', marginBottom: '10px'}}>
                <InputGroup
                  intent={!!query ? Intent.PRIMARY : undefined}
                  value={query}
                  round
                  large
                  leftIcon="search"
                  placeholder="filter projects..."
                  onChange={e => this.setState({query: e.target.value})}
                />
              </div>
            <div style={{}}>
              <Tag intent={!!query ? Intent.PRIMARY : undefined} minimal>{rendered_projects.length} {!!query ? 'filtered ' : ''}projects</Tag>
            </div>
          </div>
          {warnings}
          {list_projects}
        </Container>
      </>
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
