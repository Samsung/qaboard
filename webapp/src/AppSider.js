import React from "react";
import { connect } from 'react-redux'
import { withRouter } from "react-router";
import { Link } from "react-router-dom";
import styled from "styled-components";
import axios from "axios";

import { colors, spacing, typography, borders, shadows, transitions, breakpoints, sidebar } from './design/tokens';

import {
  Classes,
  Intent,
  MenuItem,
  MenuDivider,
  Navbar,
  Icon,
  Tag,
  Tooltip,
} from "@blueprintjs/core";

import { Avatar } from "./components/avatars";
import { IntegrationsMenus, default_gitlab_integrations } from "./components/integrations";
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
import { make_eval_templates_recursively } from "./utils"
import { toaster } from "./toaster"

export const sider_width = sidebar.width.default;

// Enhanced styled components for better design
const SiderHeader = styled.div`
    padding: ${spacing.md};
    border-bottom: ${borders.width.thin} solid ${colors.border};
    background: ${colors.surface};
    
    .bp5-navbar-heading {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin: 0;
        font-size: ${typography.lg};
        font-weight: ${typography.semibold};
        color: ${colors.textPrimary};
    }
    
    .help-icon {
        opacity: 0.7;
        transition: opacity ${transitions.hover};
        
        &:hover {
            opacity: 1;
            color: ${colors.primary};
        }
    }
`;

const SiderSection = styled.div`
    padding: ${spacing.contentPadding} ${spacing.xs} ${spacing.contentPadding} ${spacing.md};
    
    &:not(:last-child) {
        border-bottom: ${borders.width.thin} solid ${colors.borderLight};
        margin-bottom: ${spacing.sm};
        padding-bottom: ${spacing.md};
    }
    
    /* Section spacing */
    & + & {
        margin-top: 0;
    }
    
    /* First section (auth) gets less padding */
    &:nth-child(2) {
        padding-top: ${spacing.sm};
        padding-bottom: ${spacing.sm};
    }
`;

const ProjectAvatar = styled.div`
    display: flex;
    align-items: center;
    gap: ${spacing.xs};
    padding: ${spacing.xs} 0;
    margin-bottom: 0px;
    font-weight: ${typography.medium};
    font-size: ${typography.base};
    color: ${colors.textPrimary};
    
    .avatar {
        flex-shrink: 0;
    }
    
    .project-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
`;

const EnhancedMenuItem = styled.div`
    /* Higher specificity to override Blueprint styles */
    .bp5-menu-item,
    .bp5-menu-item.bp5-menu-item {
        border-radius: ${borders.radius.md} !important;
        margin-bottom: ${spacing.xs} !important;
        padding: ${spacing.xs} ${spacing.md} !important;
        transition: all ${transitions.hover} !important;
        position: relative !important;
        border: none !important;
        
        /* Default state */
        background: transparent !important;
        color: ${colors.textSecondary} !important;
        
        /* Hover state */
        &:hover {
            background: ${colors.hover} !important;
            color: ${colors.textPrimary} !important;
            transform: translateX(2px) !important;
        }
        
        /* Active state - more specific selectors */
        &.bp5-intent-primary,
        &[aria-selected="true"],
        &.bp5-active,
        &[active="true"] {
            background: ${colors.active} !important;
            color: ${colors.primary} !important;
            font-weight: ${typography.medium} !important;
        }
        &[aria-selected="true"],
        &.bp5-active,
        &[active="true"] {
            &::before {
                content: '' !important;
                position: absolute !important;
                left: -${spacing.contentPadding} !important;
                top: -2px !important;
                bottom: 0 !important;
                width: 3px !important;
                height: 100% !important;
                background: ${colors.primary} !important;
                border-radius: 0 ${borders.radius.sm} ${borders.radius.sm} 0 !important;
            }
        }
        
        /* Icon styling */
        .bp5-icon {
            margin-right: ${spacing.md} !important;
            opacity: 0.8 !important;
            color: inherit !important;
            transition: all ${transitions.hover} !important;
        }
        
        &:hover .bp5-icon {
            opacity: 1 !important;
            transform: scale(1.1) !important;
        }
        
        /* Label styling */
        .bp5-menu-item-label {
            opacity: 0.7 !important;
            color: inherit !important;
        }
    }
    
    /* Also target direct MenuItem children */
    > .bp5-menu-item,
    .bp5-menu-item-content {
        color: inherit !important;
    }
`;

const SectionDivider = styled.div`
    height: ${borders.width.thin};
    background: ${colors.border};
    margin: ${spacing.lg} 0;
    opacity: 0.5;
`;

const SectionHeader = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: ${typography.xs};
    font-weight: ${typography.semibold};
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: ${colors.textMuted};
    margin-bottom: ${spacing.sm};
    margin-top: ${spacing.md};
    padding: 0;
    
    &:first-child {
        margin-top: 0;
    }
`;

const StatusBadge = styled.span`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 ${spacing.xs};
    font-size: ${typography.xs};
    font-weight: ${typography.medium};
    border-radius: ${borders.radius.lg};
    background: ${props => {
        switch(props.variant) {
            case 'error': return colors.danger;
            case 'warning': return colors.warning;
            case 'success': return colors.success;
            case 'info': return colors.info;
            default: return colors.primary;
        }
    }};
    color: white;
    margin-left: auto;
    
    &.pulse {
        animation: pulse 2s infinite;
    }
    
    @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.8; }
    }
`;

const LoadingSkeleton = styled.div`
    height: 36px;
    background: linear-gradient(90deg, ${colors.surface} 25%, ${colors.surfaceHover} 50%, ${colors.surface} 75%);
    background-size: 200% 100%;
    border-radius: ${borders.radius.md};
    margin-bottom: ${spacing.xs};
    animation: shimmer 1.5s infinite;
    
    @keyframes shimmer {
        0% { background-position: -200% 0; }
        100% { background-position: 200% 0; }
    }
`;

const Sider = styled.div`
    /* Layout */
    flex: 0 0 ${sidebar.width.default};
    max-width: ${sidebar.width.default};
    min-width: ${sidebar.width.compact};
    width: ${sidebar.width.default};
    
    /* Positioning */
    position: fixed;
    height: 100vh;
    top: 0;
    left: 0;
    z-index: ${sidebar.zIndex};
    
    /* Styling */
    background: linear-gradient(180deg, ${colors.background} 0%, ${colors.surface} 100%);
    border-right: ${borders.width.thin} solid ${colors.border};
    box-shadow: ${shadows.sidebar};
    
    /* Typography */
    color: ${colors.textPrimary};
    font-size: ${typography.base};
    
    /* Animation */
    transition: all ${transitions.normal};
    transform: translate3d(0, 0, 0);
    
    /* Layout behavior */
    display: flex;
    flex-direction: column;
    overflow-x: hidden;
    overflow-y: auto;
    
    /* Responsive design */
    // cannot be enabled until we make sure we still export the correct sidebar_width
    // ${breakpoints.up('laptop')} {
    //     width: ${sidebar.width.default};
    //     min-width: ${sidebar.width.default};
    // }
    
    // ${breakpoints.up('wide')} {
    //     width: ${sidebar.width.wide};
    //     max-width: ${sidebar.width.wide};
    // }
    
    /* Link styling */
    a {
        color: inherit;
        text-decoration: none;
        transition: color ${transitions.hover};
        
        &:hover {
            text-decoration: none;
            color: ${colors.primary};
        }
    }
    
    /* Remove bullet points and fix layout */
    ul, li {
        list-style: none !important;
        margin: 0 !important;
        padding: 0 !important;
    }
    
    /* Global overrides for Blueprint menu items */
    .bp5-menu-item {
        color: ${colors.textSecondary} !important;
        background: transparent !important;
        border-radius: ${borders.radius.md} !important;
        margin-bottom: ${spacing.itemGap} !important;
        padding: ${spacing.md} !important;
        position: relative !important;
        cursor: pointer !important;
        list-style: none !important;
        
        /* Remove any bullets and list styles */
        &::before,
        &::after {
            display: none !important;
        }
        
        &::marker {
            display: none !important;
        }
        
        /* Focus states for accessibility */
        &:focus {
            outline: 2px solid ${colors.primary} !important;
            outline-offset: 2px !important;
        }
        
        &:hover {
            background-color: ${colors.hover} !important;
            color: ${colors.textPrimary} !important;
            transform: translateX(2px);
        }
        
        &.bp5-intent-primary,
        &.bp5-active {
            background-color: ${colors.active} !important;
            color: ${colors.primary} !important;
            font-weight: ${typography.medium} !important;
            
            /* Override the bullet hide for active indicator */
            &::before {
                content: '' !important;
                display: block !important;
                position: absolute !important;
                left: 0 !important;
                top: -2px !important;
                bottom: 0 !important;
                width: 3px !important;
                height: 100% !important;
                background: ${colors.primary} !important;
                border-radius: 0 ${borders.radius.sm} ${borders.radius.sm} 0 !important;
                z-index: 1 !important;
            }
        }
        
        .bp5-icon {
            color: inherit !important;
            opacity: 0.8;
            transition: all ${transitions.hover};
            margin-right: ${spacing.md} !important;
        }
        
        &:hover .bp5-icon {
            opacity: 1;
            transform: scale(1.05);
        }
        
        .bp5-menu-item-label {
            color: inherit !important;
            opacity: 0.7;
        }
    }
    
    /* Scrollbar styling */
    &::-webkit-scrollbar {
        width: 6px;
    }
    
    &::-webkit-scrollbar-track {
        background: transparent;
    }
    
    &::-webkit-scrollbar-thumb {
        background: ${colors.border};
        border-radius: ${borders.radius.sm};
        
        &:hover {
            background: ${colors.borderLight};
        }
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
    let avatar_url = git.avatar_url
    if (!!avatar_url) {
      avatar_url = encodeURI(`/api/v1/gitlab/proxy?url=${avatar_url}`)
    }
    return (
      <ProjectAvatar>
        <Link onClick={this.toHome} to={`/${project}`} style={{display: 'flex', alignItems: 'center', gap: '12px', width: '100%', color: 'inherit'}}>
          <Avatar
            className="avatar"
            src={avatar_url}
            alt={project_name}
            img_style={avatar_style}
          />
          <span className="project-name">{project_name}</span>
        </Link>
      </ProjectAvatar>
    )

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
    const { project, project_data={}, commit={}, ref_commit={}, match, user } = this.props;
    let qatools_config = project_data.data?.qatools_config || {};
    let integrations = qatools_config.integrations ?? commit.data?.qatools_config.integrations ??[];

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
        <SectionDivider />
        <IntegrationsMenus
          single_menu
          integrations={integrations}
          project={project}
          project_data={project_data}
          branch={is_branch ? match.params.name : reference_branch}
          commit={commit}
          ref_commit={ref_commit}
          user={user}
          docs_root={this.props.docs_root}
          integrationStatuses={this.props.integrationStatuses}
          triggerIntegration={this.props.triggerIntegration}
          startUpdateIntegrationStatuses={this.props.startUpdateIntegrationStatuses}
          stopUpdateIntegrationStatuses={this.props.stopUpdateIntegrationStatuses}
        />
        <MenuItem
          text="Milestones"
          icon="star"
          popoverProps={{
            usePortal: true,
            portalClassName: "limit-overflow",
            hoverCloseDelay: 2000,
            transitionDuration: 800,
          }}
        >
          <MilestonesMenu project={project} milestones={qatools_milestones} onSelect={this.selectMilestone} icon="crown" title="Select a milestone from qaboard.yaml" type="qatools" />
          {qatools_milestones.length === 0 && <span>Define <code>project.milestones [array]</code> in your <em>qaboard.yaml</em> configuration.</span>}
          <MilestonesMenu project={project} milestones={shared_milestones} onSelect={this.selectMilestone} icon="crown" type="shared" title="Select a shared milestone" />
          <MilestonesMenu project={project} milestones={private_milestones} onSelect={this.selectMilestone} type="private" title="Select a private milestone" />
        </MenuItem>
        {user?.is_logged && <MenuItem
          href={`/metabase/dashboard/38?username=${user.user_name}&project=${project}`}
          rel="noopener noreferrer" target="_blank"
          icon="database"
          text="Quota"
          label={<Tag intent="primary">new</Tag>}
        />}
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
    const { project, project_data={}, commit, ref_commit, new_batch, ref_batch, user } = this.props;
    const git = project_data.data?.git || {};
    let project_repo = git.path_with_namespace || '';
    let subproject = project.slice(project_repo.length + 1);
    let commit_code_sufffix = !!commit ? (subproject.length > 0 ? `blob/${commit.id}/${subproject}` : `commit/${commit.id}`) : ''

    const project_git_hostname = git_hostname(project_data?.data?.qatools_config) ?? default_git_hostname
    git.web_url = git.web_url ?? `${project_git_hostname}/${git.path_with_namespace}`
    let code_url = `${git.web_url}/${commit_code_sufffix}`

    const batch_qatools_config = new_batch?.data?.qatools_config ?? {};
    const commit_qatools_config = commit?.data?.qatools_config ?? {};
    const project_qatools_config = project_data.data?.qatools_config ?? {};
    let integrations = batch_qatools_config.integrations ?? commit_qatools_config.integrations ?? project_qatools_config.integrations ?? [];
    // integrations = integrations.slice(20)
    // integrations = [
    //   {
    //     id: "XXXXX",
    //     text: "TEST ${user.user_name} ${batch} | ${batch} | ${ref_batch} | ${ref_commit.id} | | ${filter} | ${ref_filter} | ${ref_project}",
    //     webhook: {method: "GET", url: "https://qa/s/xxxx"}
    //   },
    //   {
    //     text: "level 1",
    //     sub: [{text: "level 2"}]
    //   },
    //   // {
    //   //   icon: "circle",
    //   //   text: "TEST outside",
    //   //   href: "https://qa/s/xxxx",
    //   //   in_menu: false,
    //   // },
    // ]

    const has_optim = new_batch?.data?.optimization === true;
    const active = view => this.props.selected_views.includes(view);
    return <>
      <IntegrationsMenus
        integrations={integrations}
        project={project}
        project_data={project_data}
        commit={commit}
        ref_commit={ref_commit}
        docs_root={this.props.docs_root}
        batch={new_batch}
        ref_batch={ref_batch?.label}
        filter={this.props.filter}
        ref_filter={this.props.ref_filter}
        ref_project={this.props.ref_project}
        user={user}
        integrationStatuses={this.props.integrationStatuses}
        triggerIntegration={this.props.triggerIntegration}
        startUpdateIntegrationStatuses={this.props.startUpdateIntegrationStatuses}
        stopUpdateIntegrationStatuses={this.props.stopUpdateIntegrationStatuses}
      />
      {/* Metrics Section */}
      <SectionHeader>
        <span>Metrics</span>
      </SectionHeader>
      <MenuItem icon="dashboard" text="Summary" active={active('summary')} onClick={this.set('selected_views', 'summary')}/>
      <MenuItem icon="locate" text="Metrics Table" active={active('table-kpi')} onClick={this.set('selected_views', 'table-kpi')} />
      <MenuItem icon="heat-grid" text="Metrics Diff" active={active('table-compare')} onClick={this.set('selected_views', 'table-compare')}/>

      {/* Outputs Section */}
      <SectionHeader>
        <span>Outputs</span>
        {new_batch?.failed_outputs > 0 && (
          <StatusBadge variant="error" className="pulse">
            {new_batch.failed_outputs}
          </StatusBadge>
        )}
      </SectionHeader>
      <MenuItem icon="media" text="Visualizations" active={active('output-list')} onClick={this.set('selected_views', 'output-list')} />
      <MenuItem icon="folder-open" text="Output Files" active={active('bit_accuracy')} onClick={this.set('selected_views', 'bit_accuracy')} />
      <MenuItem icon="console" intent={(!!new_batch && new_batch.failed_outputs > 0) ? Intent.DANGER : null} text="Logs" active={active('logs')} onClick={this.set('selected_views', 'logs')} />

      {/* Source Section */}
      <SectionHeader>
        <span>Source</span>
      </SectionHeader>
      <MenuItem icon="settings" text="Artifacts & Configs" active={active('parameters')} onClick={this.set('selected_views', 'parameters')} />
      <MenuItem href={code_url} icon="git-commit" target="_blank" labelElement={<Icon icon="share" />} text="Code"/>

      {/* Tuning Section */}
      <SectionHeader>
        <span>Tuning</span>
      </SectionHeader>
      <MenuItem icon="layout-group-by" active={active('groups')} text="Available Tests" onClick={this.set('selected_views', 'groups')} />
      <MenuItem intent={Intent.PRIMARY} icon="play" text="Run Tests / Tuning" active={active('tuning')} onClick={this.set('selected_views', 'tuning')} />

      <MenuItem icon="predictive-analysis" intent={has_optim ? "primary" : undefined} text="Analysis" onClick={this.set('selected_views', 'optimization')}/>
    </>
  }
}




class AppSider extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      integrationStatuses: {}
    }
  }

  componentDidMount() {
    // Not necessary to rush fetching the statuses (?)
    // this.startUpdateIntegrationStatuses(60 * 1000)
  }

  componentWillUnmount() {
    this.stopUpdateIntegrationStatuses()
  }

  // Integration status management methods
  key = integration => (integration.id || integration.text || integration.name || integration.alt)

  stopUpdateIntegrationStatuses = () => {
    clearInterval(this.state.intervalId);
  }

  startUpdateIntegrationStatuses = interval => {
    this.stopUpdateIntegrationStatuses();
    this.updateIntegrationStatuses();
    this.setState({
      intervalId: setInterval(this.updateIntegrationStatuses, interval || 10 * 1000),
    })
  }

  triggerIntegration = integration => e => {
    const { project, project_data={}, commit={} } = this.props;
    const { webhook, gitlabCI, jenkins } = integration;
    if (!webhook && !gitlabCI && !jenkins) {
      return
    }
    this.setState({
      integrationStatuses: {
        ...this.state.integrationStatuses,
        [this.key(integration)]: {
          loading: true,
          triggered: true,
          data: undefined,
        },
      }
    });
    if (webhook) {
      var url = '/api/v1/webhook/proxy/';
      var params = webhook;
    } else if (jenkins) {
      url = '/api/v1/jenkins/build/trigger/';
      params = jenkins
    } else if (gitlabCI) {
      url = '/api/v1/gitlab/job/play/';
      const git = project_data.data?.git || {};
      const project_git_hostname = git_hostname(project_data.data?.qatools_config) ?? default_git_hostname
      git.web_url = git.web_url ?? `${project_git_hostname}/${git.path_with_namespace}`
      if (!git.web_url) {
        this.setState({
          integrationStatuses: {
            ...this.state.integrationStatuses,
            [this.key(integration)]: {
              is_loaded: true, loading: false,
              error: "Can't find gitlab host",
              statusText: 'ERROR',
            },
          }
        });
        return;
      }
      params = {
        gitlab_host: git.web_url.split('/').slice(0,3).join('/'),
        project_id: project,
        commit_id: commit.id,
        ...gitlabCI,
      }
    }
    axios.post(url, params)
    .then(response => {
        console.log(response)
        toaster.show({
          message: `Webhook sent! [${response.status} ${response.statusText}]`,
          intent: Intent.SUCCESS,
        });
        this.setState({
          integrationStatuses: {
            ...this.state.integrationStatuses,
            [this.key(integration)]: {
              is_loaded: true,
              loading: false,
              error: null,
              statusText: response.statusText,
              data: response.data,
            },
          }
        });
        if (!!response.data?.url && response.data?.open) {
          window.open(response.data.url, '_blank').focus();
        }
    })
    .catch(error => {
      console.log(error.response ?? error)
      toaster.show({
        message: `Something went wrong: ${JSON.stringify(error.response ?? error)}`,
        intent: Intent.DANGER,
      });
      this.setState({
        integrationStatuses: {
          ...this.state.integrationStatuses,
          [this.key(integration)]: {
            is_loaded: true, loading: false, error,
            statusText: error.response?.statusText,
            data: error.response?.data,
          },
        }
      });
    });
  }

  updateIntegrationStatuses = () => {
    const { project, project_data={}, commit={} } = this.props;
    // Get all integrations from both contexts
    const commitList_integrations = project_data.data?.qatools_config?.integrations ?? commit.data?.qatools_config?.integrations ?? [];
    const results_integrations = (() => {
      const batch_qatools_config = this.props.new_batch?.data?.qatools_config ?? {};
      const commit_qatools_config = commit?.data?.qatools_config ?? {};
      const project_qatools_config = project_data.data?.qatools_config ?? {};
      return batch_qatools_config.integrations ?? commit_qatools_config.integrations ?? project_qatools_config.integrations ?? [];
    })();
    
    const all_integrations = [...commitList_integrations, ...results_integrations];
    const eval_templates_recusively = make_eval_templates_recursively(this.props)
    
    all_integrations.filter(i => 
      (i.href !== undefined && i.href !== "" && i.src === undefined)
      || i.gitlabCI
      || i.jenkins
    ).forEach(integration => {
      try {
        integration = eval_templates_recusively(integration)
      } catch {
        return;
      }
      if (!integration) {
        return;
      }
      const status = this.state.integrationStatuses[this.key(integration)] || {};
      if (status.loading)
        return
      if (integration.jenkins && status.data?.web_url === undefined && status.data?.url === undefined)
        return
      this.setState({
        integrationStatuses: {
          ...this.state.integrationStatuses,
          [this.key(integration)]: {
            ...this.state.integrationStatuses[this.key(integration)],
            loading: true,
          },
        }
      });
      const { label, icon, text, href, alt, style, ignore_failure, gitlabCI, jenkins, ...request } = integration;
      if (gitlabCI) {
       if (status?.triggered !== true)
         return
       var req_url = '/api/v1/gitlab/job/';
       const git = project_data.data?.git || {};
       if (!git.web_url) {
         this.setState({
           integrationStatuses: {
             ...this.state.integrationStatuses,
             [this.key(integration)]: {
               is_loaded: true,
               loading: false,
               error: "Can't find gitlab host",
               statusText: 'ERROR',
             },
           }
         });
         return;
       }
       var params = {
         gitlab_host: git.web_url.split('/').slice(0,3).join('/'),
         project_id: project,
         commit_id: commit.id,
         job_id: status.data?.id,
         ...gitlabCI,
       }
     } else if (jenkins) {
       if (status?.triggered !== true)
         return
       req_url = '/api/v1/jenkins/build/';
       params = {
         ...status?.data, //.web_url, .url
       }
     } else { // webhook
       req_url = '/api/v1/webhook/proxy/';
       params = {
         method: 'HEAD',
         url: integration.href.startsWith('/') ? `${window.location.origin}${integration.href}`: integration.href,
         ...request
       };
     }
     axios.post(req_url, params)
       .then(response => {
           this.setState({
             integrationStatuses: {
               ...this.state.integrationStatuses,
               [this.key(integration)]: {
                 ...this.state.integrationStatuses[this.key(integration)],
                 is_loaded: true,
                 loading: false,
                 error: null,
                 statusText: null,
                 data: response.data,
               },
             }
           });
         })
         .catch(error => {
           const statusText = !!error.response ? error.response.statusText : "Network Error"
           console.log("[update] Error:", error.response)
           this.setState({
             integrationStatuses: {
               ...this.state.integrationStatuses,
               [this.key(integration)]: {
                 ...this.state.integrationStatuses[this.key(integration)],
                 is_loaded: true,
                 loading: false,
                 error: (!!ignore_failure || statusText.includes("METHOD NOT ALLOWED")) ? null : error,
                 statusText,
                 data: error.response?.data,
               },
             }
           });
         });
   })
  }

  render() {
    const integrationProps = {
      integrationStatuses: this.state.integrationStatuses,
      triggerIntegration: this.triggerIntegration,
      startUpdateIntegrationStatuses: this.startUpdateIntegrationStatuses,
      stopUpdateIntegrationStatuses: this.stopUpdateIntegrationStatuses,
    };

    return (
      <Sider className={`${Classes.DARK}`}>
        {/* Header Section */}
        <SiderHeader>
          <Navbar.Heading className="bp5-navbar-heading">
            <Link to="/">
              <strong>QA-Board</strong>
            </Link>
            <Tooltip content="Click to see the docs!">
              <a 
                href={`${this.props.docs_root}docs`}
                rel="noopener noreferrer" 
                target="_blank"
                className="help-icon"
              >
                <Icon icon="info-sign"/>
              </a>
            </Tooltip>
          </Navbar.Heading>
        </SiderHeader>

        {/* Authentication Section */}
        <SiderSection>
          <AuthButton appSider={true}/>
        </SiderSection>

        {/* Project Section */}
        <SiderSection>
          <ProjectSideAvatar 
            project={this.props.project} 
            project_data={this.props.project_data} 
            dispatch={this.props.dispatch} 
          />
        </SiderSection>

        {/* Navigation Section */}
        <SiderSection>
          {!window.location.pathname.includes('/commit/') && !window.location.pathname.includes('/history/') && (
            <>
              <SectionHeader>Project Navigation</SectionHeader>
              <EnhancedMenuItem>
                <ProjectSideCommitList
                  commit={this.props.latest_commit}
                  ref_commit={this.props.ref_commit}
                  match={this.props.match}
                  history={this.props.history}
                  project={this.props.project}
                  project_data={this.props.project_data}
                  dispatch={this.props.dispatch}
                  user={this.props.user}
                  {...integrationProps}
                />
              </EnhancedMenuItem>
            </>
          )}
          
          {window.location.pathname.includes('/commit/') && (
            <>
              <EnhancedMenuItem>
                <ProjectSideResults
                  new_batch={this.props.new_batch}
                  commit={this.props.commit}
                  ref_commit={this.props.ref_commit}
                  selected_views={this.props.selected_views}
                  history={this.props.history}
                  project={this.props.project}
                  project_data={this.props.project_data}
                  dispatch={this.props.dispatch}
                  user={this.props.user}
                  ref_batch={this.props.ref_batch}
                  filter={this.props.filter}
                  ref_filter={this.props.ref_filter}
                  ref_project={this.props.ref_project}
                  {...integrationProps}
                />
              </EnhancedMenuItem>
            </>
          )}
        </SiderSection>
      </Sider>
    )
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
  const { filter_batch_new: filter, filter_batch_ref: ref_filter, ref_project } = selected
  let { new_commit: commit, ref_commit } = commitSelector(state)
  const latest_commit = latestCommitSelector(state);
  const qatools_config = (project_data.data || {}).qatools_config || {}
  let selected_views = selected.selected_views || [ ( qatools_config.outputs || {}).default_tab_details || 'summary']

  const { new_batch, ref_batch } = batchSelector(state);
  if (!state.projects.data[project]) {
    return {
      project,
      project_data,
      is_home: false,
      branches: [],
      commit, // selected
      latest_commit, // on branch
      selected_views,
      user: state.user,
      docs_root: state.siteConfig.docs_root,
    };
  }


  return {
    is_home,
    project,
    commit, ref_commit,
    latest_commit,
    project_data,
    branches: state.projects.data[project].branches ||  [],
    is_loading: state.projects.data[project].branches_loading,
    selected_views,
    new_batch, ref_batch,
    filter, ref_filter, ref_project,
    user: state.user,
    docs_root: state.siteConfig.docs_root,
  }
}



export default withRouter(connect(mapStateToProps)(AppSider) );
