import React from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import { Link } from "react-router-dom";
import styled from "styled-components";
import axios from "axios";

import {
  Classes,
  Divider,
  Intent,
  Menu,
  MenuItem,
  MenuDivider,
  Navbar,
  Icon,
  Tooltip,
  Toaster,
} from "@blueprintjs/core";

import { Avatar } from "./components/avatars";

import {
  selectedSelector,
  projectSelector,
  projectDataSelector,
  commitSelector,
  batchSelector,
} from './selectors/projects'
import { updateSelected } from "./actions/selected";
import { project_avatar_style } from "./utils"

export const toaster = Toaster.create();

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
    let git = (project_data.data || {}).git || {};
    let name = project.split('/').slice(-1)[0];

    const is_subproject = git.path_with_namespace !== project;
    const has_custom_avatar = !!(((project_data.data || {}).qatools_config || {}).project || {}).avatar_url
    const should_tweak_image = is_subproject && !has_custom_avatar;
    const avatar_style = should_tweak_image ? project_avatar_style(project) : null;
    const avatar_url = !!git.avatar_url ? (git.avatar_url.startsWith('http') ? git.avatar_url : `http://gitlab-srv${git.avatar_url}`) : null
    // console.log("is_subproject", is_subproject)
    // console.log("has_custom_avatar", has_custom_avatar)
    // console.log("should_tweak_image", should_tweak_image)
    // console.log("avatar_style", avatar_style)
    

    return <span className={Classes.MENU_ITEM} style={{fontWeight: '200', minWidth: sider_width, marginBottom: '25px'}}>
    <Link onClick={this.toHome} className={Classes.FILL} to={`/${project}`} style={{color: 'inherit'}}>
      <>
        <Avatar
          src={avatar_url}
	        alt={name}
          img_style={avatar_style}
	      />
        {name}
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

	render() {
    const { project, project_data, match } = this.props;

    let qatools_config = (project_data.data || {}).qatools_config || {}
    let reference_branch = (qatools_config.project || {}).reference_branch;
    let ci_root = ((qatools_config.ci_root || {}).linux || '').replace("/home/arthurf/ci", "")
    let project_repo = (project_data && project_data.data && project_data.data.git && project_data.data.git.path_with_namespace) || '';

    let is_project_home = this.props.match.path === "/:project_id+/commits" || this.props.match.path === "/:project_id+"
    let is_committer = !!match.params.committer;
    let is_branch = !!match.params.name;
    if (is_branch || is_committer)
      var tag = match.params.name || match.params.committer;
    else tag = reference_branch;


    const build_icon = <img alt="build status" src={`http://gitlab-srv/${project_repo}/badges/${tag}/build.svg`}/>;
    const coverage_icon = <img alt="coverage report" src={`http://gitlab-srv/${project_repo}/badges/${tag}/coverage.svg`} />
    // https://github.com/palantir/blueprint/blob/0c09726bdbbd4be4892c97e67363dc0e8caefb71/packages/core/src/components/menu/menuItem.tsx
    // const dashboard = <Link to={`/${project}/time-travel/${reference_branch}`} style={{color: 'inherit'}}>Evolution</Link>;
    // <MenuItem icon="series-search" text={dashboard}/>
 

    let subproject = project.slice(project_repo.length + 1);
    let code_url = subproject.length > 0 ? `http://gitlab-srv/${project_repo}/tree/${reference_branch}/${subproject}` : `http://gitlab-srv/${project_repo}`
		return <>
      {!is_committer && <>
  		  {is_project_home ? <div><MenuItem text={reference_branch} icon='git-branch' style={{marginRight: '5px'}} onClick={() => this.updateBranch(reference_branch)}/></div>
                         : <MenuItem icon={is_branch ? "git-branch" : 'user'} text="Status"/>
  		  }
  		  <MenuItem href={`http://gitlab-srv/${project_repo}/pipelines`} icon={build_icon}/>
  		  <MenuItem href={`/s${ci_root}/${project}/branches/${reference_branch}/coverage/index.html`} icon={coverage_icon} style={{marginBottom: '10px'}}/>
        <MenuItem href={`/${project}/time-travel/${reference_branch}`} icon="series-search" text="Time Travel"/>


        <MenuItem href={code_url} icon="code" target="_blank" labelElement={<Icon icon="share" />} text="Code"/>
  		</>}
  		{false && <MenuItem icon="locate" text="Metrics"/>}
  		{false && <MenuItem icon="info-sign" text="Settings"/>}
    </>
  		// <MenuItem href={`/s${ci_root}/${project}/branches/${reference_branch}/doxygen/index.html`} icon="manual" text="Docs"/>
	}
}


const recursively_apply = function(object, func) {
  if (typeof object === 'object') {
    Object.keys(object).forEach(k => {object[k] = recursively_apply(object[k], func)})
    return object
  } else {
    object = func(object)
    return object
  }
}

const fill_template = function(template_string, parameters) {
  if (typeof template_string !== 'string') return template_string;
   // eslint-disable-next-line
  var func = new Function(...Object.keys(parameters),  "return `" + template_string + "`;")
  return func(...Object.values(parameters));
}


class ProjectSideResults extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      integrations: {}
    }
  }


  set = (attribute, value) => e => {
    this.props.dispatch(updateSelected(this.props.project, { [attribute]: value }))
  } 

  trigger = integration => e => {
    if (!!integration.webhook) {
      this.setState({
        integrations: {
          ...this.state.integrations,
          [integration.text]: {loading: true},
        }
      });
      axios.post('/api/v1/webhook/proxy/', integration.webhook)
        .then(response => {
            console.log(response)
            toaster.show({
              message: `Trigger sent! [${response.status} ${response.statusText}]`,
              intent: Intent.SUCCESS,
            });
            this.setState({
              integrations: {
                ...this.state.integrations,
                [integration.text]: {is_loaded: true, loading: false, error: null, statusText: response.statusText},
              }
            });
          })
          .catch(error => {
            console.log(error.response)
            toaster.show({
              message: `Something wrong happened: ${JSON.stringify(error.response)}`,
              intent: Intent.DANGER,
            });
            this.setState({
              integrations: {
                ...this.state.integrations,
                [integration.text]: {is_loaded: true, loading: false, error, statusText: error.response.statusText},
              }
            });
          }); 
    }
  }


  updateIntegrationStatuses = () => {
    const { project_data, commit } = this.props;
    const commit_qatools_config = ((commit || {}).data || {}).qatools_config || {};
    const project_qatools_config = ((project_data || {}).data || {}).qatools_config || {};
    const integrations = commit_qatools_config.integrations || project_qatools_config.integrations || [];
    integrations.filter(i => i.href !== undefined).forEach(integration => {
       this.setState({
         integrations: {
           ...this.state.integrations,
           [integration.text]: {loading: true},
         }
       });
       let url = integration.href.startsWith('/') ? `https://qa${integration.href}`: integration.href
       const { label, icon, text, href, style, ignore_failure, ...request } = integration;
       axios.post('/api/v1/webhook/proxy/', {method: 'HEAD', url, ...request})
        .then(response => {
            // console.log(response)
            this.setState({
              integrations: {
                ...this.state.integrations,
                [integration.text]: {is_loaded: true, loading: false, error: null},
              }
            });
          })
          .catch(error => {
            // console.log(error.response)
            this.setState({
              integrations: {
                ...this.state.integrations,
                [integration.text]: {
                  is_loaded: true,
                  loading: false,
                  error: !!ignore_failure ? null : error,
                  statusText: error.response.statusText
                },
              }
            });
          });
    })
  }

	render() {
    const { project, project_data, commit } = this.props;
    let project_repo = (project_data && project_data.data && project_data.data.git && project_data.data.git.path_with_namespace) || '';
    let subproject = project.slice(project_repo.length + 1);
    let commit_code_sufffix = !!commit ? (subproject.length > 0 ? `blob/${commit.id}/${subproject}` : `commit/${commit.id}`) : ''
    let code_url = `http://gitlab-srv/${project_repo}/${commit_code_sufffix}`


    let context = {
      git: project_data && project_data.data && project_data.data.git,
      project,
      subproject,
      commit,
      user: this.props.tuning_user,
    }

    // we can only do tuning for projects whose database is outside the repo
    // otherwise we would need to checkout the repo and manage access...
    const commit_qatools_config = ((commit || {}).data || {}).qatools_config || {};
    const project_qatools_config = ((project_data || {}).data || {}).qatools_config || {};
    // const qatools_integrations = default_integrations;
    const qatools_integrations = commit_qatools_config.integrations || project_qatools_config.integrations || [];
    // console.log(qatools_integrations)

    const qatools_config = commit_qatools_config || project_qatools_config || {};
    const disable_tuning = !!qatools_config.inputs && !!qatools_config.inputs.database && !!qatools_config.inputs.database.linux &&
                           !qatools_config.inputs.database.linux.startsWith('/');
    const active = view => this.props.selected_views.includes(view);
    return <>
      <MenuItem icon="dashboard" text="Summary" active={active('summary')} onClick={this.set('selected_views', 'summary')}/>
      <MenuItem icon="locate" text="KPIs" active={active('table-kpi')} onClick={this.set('selected_views', 'table-kpi')} />
      <MenuItem icon="heat-grid" text="KPI diff" active={active('table-compare')} onClick={this.set('selected_views', 'table-compare')}/>

      <Divider vertical="true" style={{marginBottom: '10px', marginTop: '16px'}}/>
      <MenuItem icon="media" text="Visualizations" active={active('output-list')} onClick={this.set('selected_views', 'output-list')} />
      <MenuItem icon="saved" text="Output Files" active={active('bit_accuracy')} onClick={this.set('selected_views', 'bit_accuracy')} />
      <MenuItem icon="console" intent={(!!this.props.batch && this.props.batch.failed_outputs > 0) ? Intent.DANGER : null} text="Logs" active={active('logs')} onClick={this.set('selected_views', 'logs')} />

      <Divider vertical="true" style={{marginBottom: '10px', marginTop: '16px'}}/>
      <MenuItem icon="settings" text="Artifacts & Configs" active={active('parameters')} onClick={this.set('selected_views', 'parameters')} />
      <MenuItem href={code_url} icon="code" target="_blank" labelElement={<Icon icon="share" />} text="Code"/>

      <Divider vertical="true" style={{marginBottom: '10px', marginTop: '16px'}}/>
      <MenuItem icon="layout-group-by" active={active('groups')} text="Available Tests" onClick={this.set('selected_views', 'groups')} />
      <MenuItem intent={Intent.PRIMARY} disabled={disable_tuning} icon="play" text="Run Tests / Tuning" active={active('tuning')} onClick={this.set('selected_views', 'tuning')} />

      <Divider vertical="true" style={{marginBottom: '10px', marginTop: '16px'}}/>
      <MenuItem icon="predictive-analysis" text="Tuning Analysis" onClick={this.set('selected_views', 'optimization')}/>
      <MenuItem icon="take-action" text="Integrations" popoverProps={{usePortal: true, hoverCloseDelay: 1000, transitionDuration: 1000, onOpening: this.updateIntegrationStatuses}}>
        {(qatools_integrations.length > 0)
        ? 
          qatools_integrations.map( (integration, idx) => {
            try {
            integration = recursively_apply(integration, s => fill_template(s, context))
            // console.log(integration)
            } catch {
              // problem can happen when the project/commit data is not loaded yet... 
              // we should wait for everything to be loaded
            }
            if (integration.divider)
              return <MenuDivider key={idx} {...integration}/>
            let status = this.state.integrations[integration.text]
            let disabled = integration.disabled || (!!status && (status.loading || !!status.error));
            let show_status = !!status && !status.loading && !!status.statusText
            let right_label = show_status ? `${!!integration.label ? integration.label : ''} [${status.statusText}]`
                                          : integration.label;
            if (!!integration.href)
              return <MenuItem key={idx} disabled={disabled} {...integration} target="_blank" label={right_label}/>
            return <MenuItem key={idx} {...integration} disabled={disabled} label={right_label} onClick={this.trigger(integration)}/>
          })
        : <MenuItem icon="info-sign" target="_blank"  href="http://qa-docs/docs/triggering-third-party-tools" text="More info..."/>
        }
      </MenuItem>
    </>
	}
}




class AppSider extends React.Component {
  render() {
    return <Sider className={`${Classes.DARK} ${Classes.NAVBAR}`} style={{padding: '0px!important', overflowX: 'hidden', overflowY: 'auto'}}>
      <ul className={Classes.LARGE} style={{'listStyle': 'none', padding: '0px'}}>
      	<Navbar.Heading style={{paddingLeft: '15px', display: 'flex', 'justifyContent': 'space-around'}}>
      		<Link style={{ color: "#fff" }}  to="/">
              <b>QA-board</b>
          </Link>
          <Tooltip><a href="http://qa-docs/" rel="noopener noreferrer" target="_blank" style={{alignSelf: 'center', marginTop: '-1px'}} ><Icon title="Help / About" style={{color: 'white'}} icon="info-sign"/></a><span>Go to the docs!</span></Tooltip>
      	</Navbar.Heading>
        <Divider style={{marginBottom: '10px', marginTop: '16px'}}/>
        <ProjectSideAvatar project={this.props.project} project_data={this.props.project_data} dispatch={this.props.dispatch} />

        {!window.location.pathname.includes('/commit/') && !window.location.pathname.includes('/time-travel/') && <ProjectSideCommitList match={this.props.match} history={this.props.history} project={this.props.project} project_data={this.props.project_data} dispatch={this.props.dispatch}/>}
        {window.location.pathname.includes('/commit/')  && <ProjectSideResults batch={this.props.new_batch_filtered} commit={this.props.commit} selected_views={this.props.selected_views} history={this.props.history} project={this.props.project} project_data={this.props.project_data} dispatch={this.props.dispatch} tuning_user={this.props.tuning_user}/>}
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
  const qatools_config = (project_data.data || {}).qatools_config || {}
  let selected_views = selected.selected_views || [ ( qatools_config.outputs || {}).default_tab_details || 'summary']

  const { new_batch_filtered } = batchSelector(state);

  if (!state.projects.data[project]) {
    return {
      project,
      project_data,
      is_home: false,
      branches: [],
      commit,
      selected_views,
      new_batch_filtered,
    };
  }


  return {
    is_home,
    project,
    commit,
    project_data,
    branches: state.projects.data[project].branches ||  [],
    is_loading: state.projects.data[project].branches_loading,
    selected_views,
    new_batch_filtered,
    tuning_user: (!!state.tuning[project] && state.tuning[project].user) || (qatools_config.lsf || {}).user || "arthurf",
  }
}

export default withRouter(connect(mapStateToProps)(AppSider) );


/*
    const default_integrations = [
      {
        divider: true,
        title: 'Build',
      },
      {
        text: 'Windows',
        icon: 'build',
        // when triggered, gives a way to check the status
        //status: {
        //  // ? maybe sh
        //}
        webhook: {
          url: 'http://jensirc:8080/job/CDE_Project_DLL/buildWithParameters',
          method: 'post',
          auth: {
            username: 'arthurf',
            password: '11089462c1273c2e5dc3f2746f03578bc5',
          },
          headers: {
            'Jenkins-Crumb': 'c762b20d61bd34c5fd8e49ad6637a8a1',
          },
          params: {
            token: 'qatools',
            project_name: 'CIS',
            branch: '${commit.branch}',
            cause: 'Triggered via the QA app'
          }
          // success: {**webhook_others, matches: /200: OK/ }
        }
      },
      {
        text: 'Linux Debug/ASAN',
        icon: 'build',
        disabled: true,
      },
      {
        divider: true,
        title: 'Artifacts',
      },
      {
        text: 'Executable',
        icon: 'download',
        label: 'Linux',
        href: '${commit.repo_commit_dir_url}/build/bin',
      },
      {
        text: 'DLL',
        icon: 'download',
        label: 'Windows',
        href: '${commit.repo_commit_dir_url}/build/bin',
      },
      {
        text: 'EXE',
        icon: 'download',
        label: 'Windows',
        href: '${commit.repo_commit_dir_url}/build/bin',
      },
      {
        divider: true,
        title: 'Docs',
      },
      {
        text: 'Generate',
        icon: 'build',
      },
      {
        text: 'View',
        icon: 'book',
        label: 'link',
        href: 'http://example.com/docs',
      },
      {
        divider: true,
      },
      {
        text: 'Publish',
        intent: 'warning',
        icon: 'upload',
      },
    ]

*/
