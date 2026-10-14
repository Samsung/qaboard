import { Link, useLinkClickHandler, useRouter } from "./router";
import { path_segment, stringify_query } from "./selection";
import styled from "styled-components";

import { colors, spacing, typography, borders, shadows, transitions, breakpoints, sidebar } from './design/tokens';

import {
  Classes,
  Intent,
  MenuItem,
  Navbar,
  Icon,
  Tooltip,
} from "@blueprintjs/core";

import { ProjectAvatar } from "./components/avatars";
import { IntegrationsMenus } from "./components/integrations";
import { MilestonesMenu } from "./components/milestones"
import AuthButton from "./components/authentication/Auth"
import { WhatsNewButton } from "./releaseNotes/ReleaseNotes"
import { LogsMenuItem, logs_hint_class } from "./AppSiderLogsItem"

import { useCommitsList, useComparison, useSiteConfig, useUser, updateSelected } from "./hooks"
import { useIntegrationStatuses } from "./useIntegrationStatuses"
import { quota_url } from "./utils"
import { repo_url, tree_url, commit_url, default_integrations } from "./git"

export const sider_width = sidebar.width.default;

// Enhanced styled components for better design
const SiderHeader = styled.div`
    padding: ${spacing.md};
    border-bottom: ${borders.width.thin} solid ${colors.border};
    background: ${colors.surface};
    
    .bp6-navbar-heading {
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

const SiderProjectAvatar = styled.div`
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
    .bp6-menu-item,
    .bp6-menu-item.bp6-menu-item {
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
        &.bp6-intent-primary,
        &[aria-selected="true"],
        &.bp6-active,
        &[active="true"] {
            background: ${colors.active} !important;
            color: ${colors.primary} !important;
            font-weight: ${typography.medium} !important;
        }
        &[aria-selected="true"],
        &.bp6-active,
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
        .bp6-icon {
            margin-right: ${spacing.md} !important;
            opacity: 0.8 !important;
            color: inherit !important;
            transition: all ${transitions.hover} !important;
        }
        
        &:hover .bp6-icon {
            opacity: 1 !important;
            transform: scale(1.1) !important;
        }
        
        /* Label styling */
        .bp6-menu-item-label {
            opacity: 0.7 !important;
            color: inherit !important;
        }

        /* Hints (e.g. failures on Logs) must stand out */
        .bp6-menu-item-label.${logs_hint_class} {
            opacity: 1 !important;
        }
    }
    
    /* Also target direct MenuItem children */
    > .bp6-menu-item,
    .bp6-menu-item-content {
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
    .bp6-menu-item {
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
        
        &.bp6-intent-primary,
        &.bp6-active {
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
        
        .bp6-icon {
            color: inherit !important;
            opacity: 0.8;
            transition: all ${transitions.hover};
            margin-right: ${spacing.md} !important;
        }
        
        &:hover .bp6-icon {
            opacity: 1;
            transform: scale(1.05);
        }
        
        .bp6-menu-item-label {
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


// The integrations of the branch pages: from qaboard.yaml, or the defaults for the project's git host
const branch_integrations = ({ project_data, commit }) =>
  project_data.data?.qatools_config?.integrations ?? commit?.data?.qatools_config?.integrations ?? default_integrations(project_data);

const ProjectSideAvatar = ({ project, project_data = {} }) => {
  let project_name = project.split('/').slice(-1)[0];
  return (
    <SiderProjectAvatar>
      <Link to={`/${project}`} style={{display: 'flex', alignItems: 'center', gap: '12px', width: '100%', color: 'inherit'}}>
        <ProjectAvatar
          className="avatar"
          project={project}
          data={project_data.data}
        />
        <span className="project-name">{project_name}</span>
      </Link>
    </SiderProjectAvatar>
  )
}

// A menu entry that navigates like <Link>: within the app, without reloading it, but ctrl/cmd+click still opens a new tab.
const MenuItemLink = ({ to, ...props }) => {
  const handleClick = useLinkClickHandler(to)
  return <MenuItem {...props} href={to} onClick={handleClick}/>
}

// Only shown if the site has a quota dashboard (QABOARD_QUOTA_URL_TEMPLATE)
const QuotaMenuItem = ({ user, project }) => {
  const { quota_url_template } = useSiteConfig()
  const href = quota_url(quota_url_template, user?.user_name, project)
  if (!user?.is_logged || !href)
    return null
  return <MenuItem
    href={href}
    rel="noopener noreferrer" target="_blank"
    icon="database"
    text="Quota"
  />
}

const ProjectSideCommitList = ({ project, project_data = {}, commit = {}, ref_commit = {}, user, docs_root, ...integrationProps }) => {
  const { history } = useRouter();
  const { selected } = useComparison();
  // Milestones from qaboard.yaml are branches (or tags), the others are commits
  const selectMilestone = milestone => {
    if (!milestone.commit)
      return updateSelected({ branch: milestone.branch });
    history.push({
      pathname: `/${path_segment(project)}/commit/${path_segment(milestone.commit)}`,
      search: stringify_query({
        new_project: milestone.project !== project ? milestone.project : undefined,
        batch: milestone.batch,
        filter: milestone.filter,
      }),
    });
  };

  let qatools_config = project_data.data?.qatools_config || {};
  let integrations = branch_integrations({ project_data, commit });
  let reference_branch = qatools_config.project?.reference_branch;
  const git = project_data.data?.git || {};

  // in qaboard.yaml users specify milestones as arrays, but here we handle them as a mapping...
  const qatools_milestones_array = qatools_config?.project?.milestones || []
  const qatools_milestones = Object.fromEntries(Object.entries(qatools_milestones_array).map( ([key, branch])=> [key, {branch}] ))
  const shared_milestones = project_data?.data?.milestones || {}
  const private_milestones = project_data.milestones || {}

  const is_committer = selected.route.is_committer;
  const is_history = selected.route.is_history;
  const is_branch = !!selected.branch;
  const is_project_home = selected.route.is_commits && !is_branch;
  const tag = selected.branch ?? selected.committer ?? reference_branch;
  const branch = selected.branch ?? reference_branch;
  let project_repo = git.path_with_namespace || '';
  let subproject = project.slice(project_repo.length + 1);
  let code_url = subproject.length > 0 ? tree_url(project_data, branch, subproject) : repo_url(project_data);
  const commits_url = branch ? `/${path_segment(project)}/commits/${path_segment(branch)}` : `/${path_segment(project)}/commits`;
  const history_url = branch ? `/${path_segment(project)}/history/${path_segment(branch)}` : `/${path_segment(project)}/history`;
  return <>
    {/* The branch's commits: highlighted on their page, a link elsewhere */}
    {(is_project_home || is_history)
      ? <div><MenuItemLink to={commits_url} text={branch} title={branch && `Commits on ${branch}`} icon='git-branch' style={{marginRight: '5px'}}/></div>
      : <MenuItem icon={is_branch ? "git-branch" : 'user'} intent='primary' text={tag} title={tag}/>
    }
    {!is_committer && <>
      <MenuItem href={code_url} icon="git-repo" target="_blank" rel="noopener noreferrer" labelElement={<Icon icon="share" />} text="Code"/>
      <MenuItemLink to={history_url} active={is_history} icon="history" text="History"/>
      <SectionDivider />
      <IntegrationsMenus
        single_menu
        integrations={integrations}
        project={project}
        project_data={project_data}
        branch={branch}
        commit={commit}
        ref_commit={ref_commit}
        user={user}
        docs_root={docs_root}
        {...integrationProps}
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
        <MilestonesMenu project={project} milestones={qatools_milestones} onSelect={selectMilestone} icon="crown" title="Select a milestone from qaboard.yaml" type="qatools" />
        {qatools_milestones_array.length === 0 && <span>Define <code>project.milestones [array]</code> in your <em>qaboard.yaml</em> configuration.</span>}
        <MilestonesMenu project={project} milestones={shared_milestones} onSelect={selectMilestone} icon="crown" type="shared" title="Select a shared milestone" />
        <MilestonesMenu project={project} milestones={private_milestones} onSelect={selectMilestone} type="private" title="Select a private milestone" />
      </MenuItem>
      <QuotaMenuItem user={user} project={project} />
    </>}
  </>
}


const results_integrations = ({ new_batch, commit, project_data }) =>
  new_batch?.data?.qatools_config?.integrations ?? commit?.data?.qatools_config?.integrations ?? project_data.data?.qatools_config?.integrations ?? [];

const ProjectSideResults = ({ project, project_data = {}, commit, ref_commit, new_batch, ref_batch, selected_views, default_views, filter, ref_filter, ref_project, user, docs_root, ...integrationProps }) => {
  const git = project_data.data?.git || {};
  let project_repo = git.path_with_namespace || '';
  let subproject = project.slice(project_repo.length + 1);
  let code_url = !commit?.id ? repo_url(project_data)
                 : subproject.length > 0 ? tree_url(project_data, commit.id, subproject) : commit_url(project_data, commit.id);

  const has_optim = new_batch?.data?.optimization === true;
  const active = view => selected_views.includes(view);
  const set = view => () => updateSelected({ selected_views: view }, { defaults: { selected_views: default_views } })
  return <>
    <IntegrationsMenus
      integrations={results_integrations({ new_batch, commit, project_data })}
      project={project}
      project_data={project_data}
      commit={commit}
      ref_commit={ref_commit}
      docs_root={docs_root}
      batch={new_batch}
      ref_batch={ref_batch?.label}
      filter={filter}
      ref_filter={ref_filter}
      ref_project={ref_project}
      user={user}
      {...integrationProps}
    />
    {/* Metrics Section */}
    <SectionHeader>
      <span>Metrics</span>
    </SectionHeader>
    <MenuItem icon="dashboard" text="Summary" active={active('summary')} onClick={set('summary')}/>
    <MenuItem icon="locate" text="Metrics Table" active={active('table-kpi')} onClick={set('table-kpi')} />
    <MenuItem icon="heat-grid" text="Metrics Diff" active={active('table-compare')} onClick={set('table-compare')}/>

    {/* Outputs Section */}
    <SectionHeader>
      <span>Outputs</span>
    </SectionHeader>
    <MenuItem icon="media" text="Visualizations" active={active('output-list')} onClick={set('output-list')} />
    <MenuItem icon="folder-open" text="Output Files" active={active('bit-accuracy')} onClick={set('bit-accuracy')} />
    <LogsMenuItem batch={new_batch} active={active('logs')} onClick={set('logs')} />

    {/* Source Section */}
    <SectionHeader>
      <span>Source</span>
    </SectionHeader>
    <MenuItem icon="settings" text="Artifacts & Configs" active={active('parameters')} onClick={set('parameters')} />
    <MenuItem href={code_url} icon="git-commit" target="_blank" rel="noopener noreferrer" labelElement={<Icon icon="share" />} text="Code"/>

    {/* Tuning Section */}
    <SectionHeader>
      <span>Tuning</span>
    </SectionHeader>
    <MenuItem icon="layout-group-by" active={active('groups')} text="Available Tests" onClick={set('groups')} />
    <MenuItem intent={Intent.PRIMARY} icon="play" text="Run Tests / Tuning" active={active('tuning')} onClick={set('tuning')} />

    <MenuItem icon="predictive-analysis" intent={has_optim ? "primary" : undefined} active={active('optimization')} text="Analysis" onClick={set('optimization')}/>
  </>
}


const AppSider = () => {
  const { docs_root } = useSiteConfig();
  const user = useUser();
  const { project, project_data, selected, selected_views, default_views, new_commit, ref_commit, new_batch, ref_batch } = useComparison();
  const route = selected.route;
  // searching commits doesn't change the latest commit
  const { latest_commit } = useCommitsList({ ignore_search: true });
  // the commit whose integrations we show
  const commit = route.is_commit ? new_commit : latest_commit;

  const integrations = [
    ...branch_integrations({ project_data, commit }),
    ...results_integrations({ new_batch, commit, project_data }),
  ];
  const template_context = {
    project, project_data, commit, ref_commit, integrations, user, docs_root,
    branch: selected.branch ?? project_data.data?.qatools_config?.project?.reference_branch,
    new_batch, ref_batch: ref_batch?.label,
    filter: selected.filter_batch_new, ref_filter: selected.filter_batch_ref, ref_project: selected.ref_project,
  };
  const integrationProps = useIntegrationStatuses(template_context);

  return (
    <Sider className={`${Classes.DARK}`}>
      {/* Header Section */}
      <SiderHeader>
        <Navbar.Heading className="bp6-navbar-heading">
          <Link to="/">
            <strong>QA-Board</strong>
          </Link>
          <span>
            <WhatsNewButton via="sidebar" className="help-icon"/>
            <Tooltip content="User guide">
              <a
                href={`${docs_root}docs/user-guide/overview`}
                rel="noopener noreferrer"
                target="_blank"
                className="help-icon"
                aria-label="User guide"
                style={{marginLeft: spacing.xs}}
              >
                <Icon icon="info-sign"/>
              </a>
            </Tooltip>
          </span>
        </Navbar.Heading>
      </SiderHeader>

      {/* Authentication Section */}
      <SiderSection>
        <AuthButton appSider={true}/>
      </SiderSection>

      {/* Project Section */}
      <SiderSection>
        <ProjectSideAvatar project={project} project_data={project_data} />
      </SiderSection>

      {/* Navigation Section: views of the results on commit pages, else (commit lists, history) the project's pages */}
      <SiderSection>
        {(route.is_list || route.is_history) && (
          <>
            <SectionHeader>Project Navigation</SectionHeader>
            <EnhancedMenuItem>
              <ProjectSideCommitList
                commit={latest_commit}
                ref_commit={ref_commit}
                project={project}
                project_data={project_data}
                user={user}
                docs_root={docs_root}
                {...integrationProps}
              />
            </EnhancedMenuItem>
          </>
        )}
        {route.is_commit && (
          <EnhancedMenuItem>
            <ProjectSideResults
              new_batch={new_batch}
              commit={new_commit}
              ref_commit={ref_commit}
              selected_views={selected_views}
              default_views={default_views}
              project={project}
              project_data={project_data}
              user={user}
              docs_root={docs_root}
              ref_batch={ref_batch}
              filter={selected.filter_batch_new}
              ref_filter={selected.filter_batch_ref}
              ref_project={selected.ref_project}
              {...integrationProps}
            />
          </EnhancedMenuItem>
        )}
      </SiderSection>
    </Sider>
  )
}

export default AppSider;
