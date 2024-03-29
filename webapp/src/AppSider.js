import React from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import { Link } from "react-router-dom";
import styled from "styled-components";

import {
  Classes,
  Divider,
  Intent,
  MenuItem,
  MenuDivider,
  Navbar,
  Icon,
  Tag,
  Tooltip,
} from "@blueprintjs/core";

import { Avatar } from "./components/avatars";
import { IntegrationsMenus } from "./components/integrations";
import { MilestonesMenu } from "./components/milestones"
import AuthButton from "./components/authentication/Auth"

import {
  selectedSelector,
  projectSelector,
  projectDataSelector,
  commitSelector,
  latestCommitSelector,
  batchSelector,
} from './selectors/projects'
import { updateSelected } from "./actions/selected";
import { fetchCommit } from "./actions/commit";
import { git_hostname, default_git_hostname, project_avatar_style } from "./utils"

export const sider_width = '166px';

const Sider = styled.div`
    flex: 0 0 ${sider_width};
    max-width: ${sider_width};
    min-width: ${sider_width};
    width: ${sider_width};
    padding-left: 0 !important;
    margin-top: 0;

    z-index: 15 !important;

    position: fixed !important;
    height: 100%!important;
    bottom: 0;

    transition: all .2s;

    transform: translate3d(0, 0, 0);

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
    const { project, project_data={} } = this.props;
    const git = project_data.data?.git || {};
    let project_name = project.split('/').slice(-1)[0];
    const is_subproject = git.path_with_namespace !== project;
    const has_custom_avatar = !!project_data.data?.qatools_config?.project?.avatar_url
    const should_tweak_image = is_subproject && !has_custom_avatar;
    const avatar_style = should_tweak_image ? project_avatar_style(project) : null;

    const project_git_hostname = git_hostname(project_data?.data?.qatools_config) ?? default_git_hostname
    git.web_url = git.web_url ?? `${project_git_hostname}/${git.path_with_namespace}`
    const gitlab_host = git.web_url.split('/').slice(0,3).join('/')
    let avatar_url = git.avatar_url
    if (!!avatar_url && avatar_url.startsWith(gitlab_host)) {
      avatar_url = encodeURI(`/api/v1/gitlab/proxy?url=${avatar_url}`)
    }
    return <span className={Classes.MENU_ITEM} style={{fontWeight: '200', minWidth: sider_width, marginBottom: '20px'}}>
    <Link onClick={this.toHome} className={Classes.FILL} to={`/${project}`} style={{color: 'inherit'}}>
      <>
        <Avatar
          src={avatar_url}
          alt={project_name}
          img_style={avatar_style}
        />
        {project_name}
      </>
    </Link></span>

  }
}

class ProjectSideCommitList extends React.Component {
  updateBranch = branch => {
    const { project, history, dispatch } = this.props;
    history.push(`/${project}/commits/${branch}`);
    dispatch(updateSelected(project, {branch, committer: null}))
  }

  selectMilestone = milestone => {
    const { project, dispatch } = this.props;
    dispatch(fetchCommit({project: milestone.project ?? project, id: milestone.commit}));
    dispatch(updateSelected(project, {
      new_project: milestone.project ?? project,
      new_commit_id: milestone.commit,
      selected_batch_new: milestone.batch,
      filter_batch_new: milestone.filter,
    }))
  };

  render() {
    const { project, project_data={}, commit={}, match } = this.props;
    let qatools_config = project_data.data?.qatools_config || {};
    let reference_branch = qatools_config.project?.reference_branch;
    const git = project_data.data?.git || {};

    // in qaboard.yaml users specify milestones as arrays, but here we handle them as a mapping...
    const qatools_milestones_array = qatools_config?.project?.milestones || []
    const qatools_milestones = Object.fromEntries(Object.entries(qatools_milestones_array).map( ([key, branch])=> [key, {branch}] ))
    const shared_milestones = project_data?.data?.milestones || {}
    const private_milestones = project_data.milestones || {}

    let is_project_home = this.props.match.path === "/:project_id+/commits" || this.props.match.path === "/:project_id+";
    let is_committer = !!match.params.committer;
    let is_branch = !!match.params.name;
    if (is_branch || is_committer) {
      var tag = match.params.name || match.params.committer;
    } else {
      tag = reference_branch;
    } 
    let project_repo = git.path_with_namespace || '';
    let subproject = project.slice(project_repo.length + 1);

    const project_git_hostname = git_hostname(project_data?.data?.qatools_config) ?? default_git_hostname
    git.web_url = git.web_url ?? `${project_git_hostname}/${git.path_with_namespace}`
    let code_url = subproject.length > 0 ? `${git.web_url}/tree/${is_branch ? match.params.name : reference_branch}/${subproject}` : git.web_url;
    return <>
      {is_project_home ? <div><MenuItem text={reference_branch} icon='git-branch' style={{marginRight: '5px'}} onClick={() => this.updateBranch(reference_branch)}/></div>
                        : <MenuItem icon={is_branch ? "git-branch" : 'user'} intent='primary' text={tag} title={tag}/>
      }
      {!is_committer && <>
        <MenuItem href={code_url} icon="git-repo" target="_blank" labelElement={<Icon icon="share" />} text="Code"/>
        <MenuItem href={`/${project}/history/${is_branch ? match.params.name : reference_branch}`} icon="history" text="History"/>
        <MenuDivider />
        <IntegrationsMenus single_menu project={project} project_data={project_data} branch={is_branch ? match.params.name : reference_branch} commit={commit} user={this.props.tuning_user} />
        <MenuItem
          text="Milestones"
          icon="star"
          defaultIsOpen
          popoverProps={{
            usePortal: true,
            portalClassName: "limit-overflow",
            hoverCloseDelay: 8000,
            transitionDuration: 800,
          }}
        >
          <MilestonesMenu project={project} milestones={qatools_milestones} onSelect={this.selectMilestone} icon="crown" title="Select a milestone from qaboard.yaml" type="qatools" />
          {qatools_milestones.length === 0 && <span>Define <code>project.milestones [array]</code> in your <em>qaboard.yaml</em> configuration.</span>}
          <MilestonesMenu project={project} milestones={shared_milestones} onSelect={this.selectMilestone} icon="crown" type="shared" title="Select a shared milestone" />
          <MilestonesMenu project={project} milestones={private_milestones} onSelect={this.selectMilestone} type="private" title="Select a private milestone" />
        </MenuItem>
        </>}
    </>
    }
}
        // {false && <MenuItem icon="locate" text="Metrics"/>}
        // {false && <MenuItem icon="info-sign" text="Settings"/>}


class ProjectSideResults extends React.Component {
  set = (attribute, value) => e => {
    this.props.dispatch(updateSelected(this.props.project, { [attribute]: value }))
  } 

  render() {
    const { project, project_data={}, commit, batch } = this.props;
    const git = project_data.data?.git || {};
    let project_repo = git.path_with_namespace || '';
    let subproject = project.slice(project_repo.length + 1);
    let commit_code_sufffix = !!commit ? (subproject.length > 0 ? `blob/${commit.id}/${subproject}` : `commit/${commit.id}`) : ''

    const project_git_hostname = git_hostname(project_data?.data?.qatools_config) ?? default_git_hostname
    git.web_url = git.web_url ?? `${project_git_hostname}/${git.path_with_namespace}`
    let code_url = `${git.web_url}/${commit_code_sufffix}`

    // we can only do tuning for projects whose database is outside the repo
    // otherwise we would need to checkout the repo and manage access...
    const commit_qatools_config = ((commit || {}).data || {}).qatools_config || {};
    const project_qatools_config = (project_data.data || {}).qatools_config || {};
    const qatools_config = commit_qatools_config || project_qatools_config || {};

    const has_optim = batch.data?.optimization === true;
    const active = view => this.props.selected_views.includes(view);
    return <>
      <IntegrationsMenus project={project} project_data={project_data} commit={commit} user={this.props.tuning_user} />
      <MenuDivider vertical="true" style={{marginBottom: '10px', marginTop: '1px'}}/>

      <MenuItem icon="dashboard" text="Summary" active={active('summary')} onClick={this.set('selected_views', 'summary')}/>
      <MenuItem icon="locate" text="KPIs" active={active('table-kpi')} onClick={this.set('selected_views', 'table-kpi')} />
      <MenuItem icon="heat-grid" text="KPI diff" active={active('table-compare')} onClick={this.set('selected_views', 'table-compare')}/>

      <Divider vertical="true" style={{marginBottom: '10px', marginTop: '16px'}}/>
      <MenuItem icon="media" text="Visualizations" active={active('output-list')} onClick={this.set('selected_views', 'output-list')} />
      <MenuItem icon="saved" text="Output Files" active={active('bit_accuracy')} onClick={this.set('selected_views', 'bit_accuracy')} />
      <MenuItem icon="console" intent={(!!batch && batch.failed_outputs > 0) ? Intent.DANGER : null} text="Logs" active={active('logs')} onClick={this.set('selected_views', 'logs')} />

      <Divider vertical="true" style={{marginBottom: '10px', marginTop: '16px'}}/>
      <MenuItem icon="settings" text="Artifacts & Configs" active={active('parameters')} onClick={this.set('selected_views', 'parameters')} />
      <MenuItem href={code_url} icon="git-commit" target="_blank" labelElement={<Icon icon="share" />} text="Code"/>

      <Divider vertical="true" style={{marginBottom: '10px', marginTop: '16px'}}/>
      <MenuItem icon="layout-group-by" active={active('groups')} text="Available Tests" onClick={this.set('selected_views', 'groups')} />
      <MenuItem intent={Intent.PRIMARY} icon="play" text="Run Tests / Tuning" active={active('tuning')} onClick={this.set('selected_views', 'tuning')} />

      <Divider vertical="true" style={{marginBottom: '10px', marginTop: '16px'}}/>
      <MenuItem icon="predictive-analysis" intent={has_optim ? "primary" : undefined} text="Analysis" onClick={this.set('selected_views', 'optimization')}/>
    </>
  }
}




class AppSider extends React.Component {
  render() {
    return <Sider className={`${Classes.DARK} ${Classes.NAVBAR}`} style={{padding: '0px!important', overflowX: 'hidden', overflowY: 'auto'}}>
      <ul className={Classes.LARGE} style={{'listStyle': 'none', padding: '0px'}}>
        <Navbar.Heading style={{paddingLeft: '15px', display: 'flex', 'justifyContent': 'space-around'}}>
          <Link style={{ color: "#fff" }}  to="/">
              <b>QA-Board</b>
          </Link>
          <Tooltip><a href={`${process.env.REACT_APP_QABOARD_DOCS_ROOT}docs`} rel="noopener noreferrer" target="_blank" style={{alignSelf: 'center', marginTop: '-1px'}} ><Icon title="Help / About" style={{color: 'white'}} icon="info-sign"/></a><span>Click to see the docs!</span></Tooltip>
        </Navbar.Heading>
        <Divider style={{marginBottom: '10px', marginTop: '16px'}}/>
        <AuthButton appSider={true}/>
        <Divider style={{marginBottom: '10px', marginTop: '10px'}}/>
        <ProjectSideAvatar project={this.props.project} project_data={this.props.project_data} dispatch={this.props.dispatch} />

        {!window.location.pathname.includes('/commit/') && !window.location.pathname.includes('/history/') && <ProjectSideCommitList commit={this.props.latest_commit} match={this.props.match} history={this.props.history} project={this.props.project} project_data={this.props.project_data} dispatch={this.props.dispatch} tuning_user={this.props.tuning_user}/>}
        {window.location.pathname.includes('/commit/')  && <ProjectSideResults batch={this.props.batch} commit={this.props.commit} selected_views={this.props.selected_views} history={this.props.history} project={this.props.project} project_data={this.props.project_data} dispatch={this.props.dispatch} tuning_user={this.props.tuning_user}/>}
      </ul>
    </Sider>
  }
}



const mapStateToProps = (state, ownProps) => {
  // console.log(state)
  // console.log(ownProps.location)

  let is_home = ownProps.location.pathname === '/';
  if (is_home) return {is_home: true}

  // let project = params.get("project") || state.selected.project;
  let project = projectSelector(state)
  let project_data = projectDataSelector(state)
  let selected = selectedSelector(state)
  let { new_commit: commit } = commitSelector(state)
  const latest_commit = latestCommitSelector(state);
  const qatools_config = (project_data.data || {}).qatools_config || {}
  let selected_views = selected.selected_views || [ ( qatools_config.outputs || {}).default_tab_details || 'summary']


  const { new_batch: batch } = batchSelector(state);
  if (!state.projects.data[project]) {
    return {
      project,
      project_data,
      is_home: false,
      branches: [],
      commit, // selected
      latest_commit, // on branch
      selected_views,
      batch,
    };
  }


  return {
    is_home,
    project,
    commit,
    latest_commit,
    project_data,
    branches: state.projects.data[project].branches ||  [],
    is_loading: state.projects.data[project].branches_loading,
    selected_views,
    batch,
    tuning_user: (!!state.tuning[project] && state.tuning[project].user) || (qatools_config.lsf || {}).user || "ispq",
  }
}



export default withRouter(connect(mapStateToProps)(AppSider) );
