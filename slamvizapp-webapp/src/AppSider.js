import React from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import { Route } from "react-router-dom";
import { Link } from "react-router-dom";
import styled from "styled-components";
import qs from "qs";

import {
  Classes,
  Divider,
  Intent,
  Menu,
  Navbar,
  Icon,
  Button,
} from "@blueprintjs/core";

import { Avatar } from "./components/avatars";
import { default_project } from "./defaults"

import { updateSelected } from "./actions/selected";


const sider_width = '151px'

const Sider = styled.div`
    flex: 0 0 ${sider_width};
    max-width: ${sider_width};
    min-width: ${sider_width};
    width: ${sider_width};

    z-index: 15 !important;

    position: fixed !important;
    height: 100%!important;
    bottom: 0;

    transition: all .2s;
    // padding-bottom: 48px;   

    transform: translate3d(0, 0, 0);

    padding-left: 0 !important;
    margin-top: 0;
    list-style: none;
    display: flex;

    & a:hover {
  	  text-decoration: none;
    }
`


class ProjectSideAvatar extends React.Component {
  toHome = () => {
    const { dispatch, project } = this.props;
  	dispatch(updateSelected(project, {branch: null, committer: null}))
  }

	render() {
    const { project, project_data } = this.props;
    let git = ((project_data || {}).information || {}).git || {};

    return <span className={Classes.MENU_ITEM} style={{fontWeight: '200', minWidth: '151px', marginBottom: '25px'}}>
    <Link onClick={this.toHome} className={Classes.FILL} to={`/${project}`} style={{color: 'inherit'}}><><Avatar
	      src={!!git.avatar_url ? `http://gitlab-srv${git.avatar_url}` : null}
	      alt={project}
	     />{project}</>
    </Link></span>

	}
}

class ProjectSideCommitList extends React.Component {
  updateBranch = branch => {
    this.props.history.push(`/${this.props.project}/commits/${branch}`);
    this.props.dispatch(updateSelected(this.props.project, {branch, committer: null}))
  }

	render() {
    const { error, is_loaded, is_loading, project, project_data, match, commits, date_range } = this.props;

    let reference_branch = project_data.information.qatools_config.project.reference_branch;
    let ci_root = project_data.information.qatools_config.ci_root.linux.replace("/home/arthurf/ci", "")
    let project_repo = project_data && project_data.information && project_data.information.git && project_data.information.git.path_with_namespace;

    let is_project_home = this.props.match.path === "/:project_id+/commits" || this.props.match.path === "/:project_id+"
    let is_committer = !!match.params.committer;
    let is_branch = !!match.params.name;
    if (is_branch || is_committer)
      var tag = match.params.name || match.params.committer;
    else tag = reference_branch;

    const build_icon = <img alt="build status" src={`http://gitlab-srv/${project_repo}/badges/${tag}/build.svg`}/>;
    const coverage_icon = <img alt="coverage report" src={`http://gitlab-srv/${project_repo}/badges/${tag}/coverage.svg`} />
	  const dashboard = <Link to={`/${project}/dashboard/${reference_branch}`} style={{color: 'inherit'}}>Evolution</Link>;


		return <>
      {!is_committer && <>
  		  {is_project_home ? <div><Menu.Item text={reference_branch} icon='git-branch' style={{marginRight: '5px'}} onClick={() => this.updateBranch(reference_branch)}/></div>
                         : <Menu.Item icon={is_branch ? "git-branch" : 'user'} text="Status"/>
  		  }
  		  <Menu.Item href={`http://gitlab-srv/${project_repo}/pipelines`} icon={build_icon}/>
  		  <Menu.Item href={`/s${ci_root}/${project}/branches/${reference_branch}/coverage/index.html`} icon={coverage_icon} style={{marginBottom: '10px'}}/>
  		  <Menu.Item icon="series-search" text={dashboard}/>
  		</>}
  		<Menu.Item icon="locate" text="Metrics"/>
  		<Menu.Item icon="info-sign" text="Settings"/>
    </>
  		// <Menu.Item href={`/s${ci_root}/${project}/branches/${reference_branch}/doxygen/index.html`} icon="manual" text="Docs"/>
	}
}


class ProjectSideResults extends React.Component {
  set = (attribute, value) => e => {
    this.props.dispatch(updateSelected(this.props.project, { [attribute]: value }))
    let query = qs.parse(window.location.search.substring(1));
    this.props.history.push({
      pathname: window.location.pathname,
      search: qs.stringify({
        ...query,
        [attribute]: value,
      })
    });
  } 

	render() {
    const { project_data } = this.props;

		const active = view => this.props.selected_views.includes(view);
    // we can only do tuning for projects whose database is outside the repo
    // otherwise we would need to checkout the repo and manage access...
    const disable_tuning = !!project_data.information &&
                           !!project_data.information.qatools_config &&
                           !!project_data.information.qatools_config.inputs &&
                           !!project_data.information.qatools_config.inputs.database &&
                           !!project_data.information.qatools_config.inputs.database.linux &&
                           !project_data.information.qatools_config.inputs.database.linux.startsWith('/');

    return <>
      <Menu.Item icon="dashboard" text="Summary" active={active('summary')} onClick={this.set('selected_tab_summary', 'summary')}/>
      <Menu.Item icon="locate" text="KPIs" active={active('table-kpi')} onClick={this.set('selected_tab_details', 'table-kpi')} />
      <Menu.Item icon="heat-grid" text="KPI diff" active={active('table-compare')} onClick={this.set('selected_tab_summary', 'table-compare')}/>

      <Divider vertical="true" style={{marginBottom: '10px', marginTop: '16px'}}/>
      <Menu.Item icon="media" text="Outputs" active={active('output-list')} onClick={this.set('selected_tab_details', 'output-list')} />
      <Menu.Item icon="saved" text="Files" active={active('bit-accuracy')} onClick={this.set('selected_tab_details', 'bit-accuracy')} />
      <Menu.Item icon="console" text="Logs" active={active('logs')} onClick={this.set('selected_tab_details', 'logs')} />

      <Divider vertical="true" style={{marginBottom: '10px', marginTop: '16px'}}/>
      <Menu.Item icon="settings" text="Configs" active={active('parameters')} onClick={this.set('selected_tab_summary', 'parameters')} />
      <Menu.Item icon="code" labelElement={<Icon icon="share" />} text="Code"/>

      <Divider vertical="true" style={{marginBottom: '10px', marginTop: '16px'}}/>
      <Menu.Item icon="layout-group-by" active={active('groups')} text="Tests" onClick={this.set('selected_tab_summary', 'groups')} />
      <Menu.Item disabled={disable_tuning} icon="add" text="Tuning" active={active('tuning')} onClick={this.set('selected_tab_summary', 'tuning')} >
        <Menu>
          <Menu.Item icon="new-text-box" text="New text box" />
          <Menu.Item icon="new-object" text="New object" />
          <Menu.Item active icon="new-link" text="New link" />
          <Menu.Divider />
          <Menu.Item text="Settings..." icon="cog">
            <Menu.Item icon="tick" text="Save on edit" />
            <Menu.Item icon="blank" text="Compile on edit" />
          </Menu.Item>
        </Menu>              
      </Menu.Item>
      <Menu.Item icon="predictive-analysis" text="Optimization" onClick={this.set('selected_tab_details', 'optimization')}/>
    </>
	}
}




class AppSider extends React.Component {
  render() {
    return <Sider className={`${Classes.DARK} ${Classes.NAVBAR}`} style={{padding: '0px!important'}}>
      <ul className={Classes.LARGE} style={{'listStyle': 'none', padding: '0px'}}>
      	<Navbar.Heading style={{paddingLeft: '15px'}}>
      		<Link style={{ color: "#fff" }}  to="/">
              <b>QA</b>
            </Link>
      	</Navbar.Heading>
        <Divider style={{marginBottom: '10px', marginTop: '16px'}}/>
        <ProjectSideAvatar project={this.props.project} project_data={this.props.project_data} dispatch={this.props.dispatch} />

        {!window.location.pathname.includes('/commit/') && !window.location.pathname.includes('/dashboard/') && <ProjectSideCommitList match={this.props.match} history={this.props.history} project={this.props.project} project_data={this.props.project_data} dispatch={this.props.dispatch}/>}
        {window.location.pathname.includes('/commit/')  && <ProjectSideResults selected_views={this.props.selected_views} history={this.props.history} project={this.props.project} project_data={this.props.project_data} dispatch={this.props.dispatch}/>}
      </ul>
    </Sider>
  }
}



const mapStateToProps = (state, ownProps) => {
  // console.log(state)
  // console.log(ownProps.location)
  const params = new URLSearchParams(ownProps.location.search);

  let is_home = ownProps.location.pathname === '/';
  if (is_home) return {is_home: true}

  // let project = params.get("project") || state.selected.project;
  let project = ((ownProps.match || {}).params || {}).project_id || params.get("project") || state.selected.project;
  let project_data = state.projects.data[project] || default_project;
  //console.log('AppSider.props.match', ownProps.match)

  let selected_views = [
    ((state.selected[project] && state.selected[project].selected_tab_summary) || "metrics"),
    ((state.selected[project] && state.selected[project].selected_tab_details) || (project_data.information.qatools_config.outputs || {}).default_tab_details || 'table-compare'),
  ];  


  if (!state.projects.data[project]) {
    return {
      project,
      project_data,
      is_home: false,
      branches: [],
      selected_views,
    };
  }
  // console.log(project_data)
  return {
    is_home,
    project,
    project_data,
    branches: state.projects.data[project].branches ||  [],
    is_loading: state.projects.data[project].branches_loading,
    selected_views,
  }
}

export default withRouter(connect(mapStateToProps)(AppSider) );
