import { createContext, useContext, useEffect, useState } from "react";
import { Link, useLinkClickHandler, useRouter } from "./router";
import { path_segment } from "./selection";
import styled from "styled-components";

import { colors, spacing, typography, borders, transitions, sidebar } from './design/tokens';

import {
  Button,
  Classes,
  Colors,
  MenuItem,
  Icon,
  Tooltip,
  PopoverNext,
} from "@blueprintjs/core";

import { ProjectAvatar } from "./components/avatars";
import { IntegrationsMenus } from "./components/integrations";
import { MilestonesPanel } from "./milestones/MilestonesPanel"
import { useMilestones } from "./milestones/hooks"
import { milestone_name, milestone_path, milestone_location, milestones_of } from "./milestones/api"
import AuthButton from "./components/authentication/Auth"
import { WhatsNewButton } from "./releaseNotes/ReleaseNotes"
import { ThemeButton } from "./components/ThemeButton"
import { useHelpSheet, is_typing } from "./components/HelpSheet"
import { LogsMenuItem, logs_hint_class } from "./AppSiderLogsItem"

import { useCommitsList, useComparison, useSiteConfig, useUser, updateSelected } from "./hooks"
import { usePrefsStore } from "./stores/prefs"
import { useIntegrationStatuses } from "./useIntegrationStatuses"
import { quota_url } from "./utils"
import { repo_url, tree_url, commit_url, commits_url as git_commits_url, default_integrations } from "./git"

// The sidebar's width, also what the page leaves free for it: a CSS variable (App.css), smaller when collapsed.
// index.html sets it before the first paint, SiderWidthSync after.
export const sider_width = 'var(--qa-sider-width)';
const expanded_width = sidebar.width.default;
const collapsed_width = '48px';
export const useSiderCollapsed = () => usePrefsStore(state => !!state.siderCollapsed);
const SiderCollapsedContext = createContext(false);

const SiderWidthSync = ({ collapsed }) => {
  useEffect(() => {
    document.documentElement.style.setProperty('--qa-sider-width', collapsed ? collapsed_width : expanded_width);
  }, [collapsed]);
  return null;
};

// Ctrl+\ (⌘\ on macOS) collapses or expands the sidebar, like in many apps
export const is_toggle_sider = event => event.key === '\\' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
const useToggleShortcut = toggle => {
  useEffect(() => {
    const onKeyDown = event => {
      if (!is_toggle_sider(event) || event.defaultPrevented || is_typing(event.target)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);
};

// Like Blueprint's dark navigation panels: flat, quiet, the selected view stands out.
// Blueprint's own menu styles have 2-3 classes of specificity, `&&` gets ours above them.
const SiderHeader = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 50px;
    padding: 0 ${spacing.sm} 0 ${spacing.lg};
    border-bottom: ${borders.width.thin} solid rgba(255, 255, 255, 0.08);
    flex: 0 0 auto;

    .qa-brand {
        font-size: ${typography.lg};
        font-weight: ${typography.semibold};
        letter-spacing: 0.2px;
        color: ${colors.textPrimary};
    }
    .qa-brand:hover {
        color: ${colors.textPrimary};
    }
    .qa-header-actions {
        display: flex;
        align-items: center;
    }
    .qa-header-actions .bp6-button {
        color: ${colors.textSecondary};
    }
    .qa-header-actions .bp6-button:hover {
        color: ${colors.textPrimary};
    }
`;

const SiderSection = styled.div`
    padding: ${spacing.sm} ${spacing.sm};

    & + & {
        border-top: ${borders.width.thin} solid rgba(255, 255, 255, 0.08);
    }
`;

const SiderFooter = styled(SiderSection)`
    margin-top: auto;
    border-top: ${borders.width.thin} solid rgba(255, 255, 255, 0.08);
`;

const SiderProjectAvatar = styled.div`
    font-weight: ${typography.semibold};
    font-size: ${typography.base};

    a {
        display: flex;
        align-items: center;
        gap: ${spacing.sm};
        padding: ${spacing.xs} ${spacing.sm};
        border-radius: ${borders.radius.sm};
        color: ${colors.textPrimary};
    }
    a:hover {
        background: rgba(255, 255, 255, 0.06);
        color: ${colors.textPrimary};
    }
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

const SiderMenu = styled.div`
    && .bp6-menu-item {
        display: flex;
        align-items: center;
        min-height: 30px;
        margin: 1px 0;
        padding: 5px ${spacing.sm};
        border-radius: ${borders.radius.sm};
        color: ${colors.textSecondary};
        background: transparent;
        position: relative;
        cursor: pointer;
        transition: background-color ${transitions.hover}, color ${transitions.hover};
    }
    && .bp6-menu-item:hover,
    && .bp6-menu-item.bp6-popover-open {
        background: rgba(255, 255, 255, 0.07);
        color: ${colors.textPrimary};
    }
    && .bp6-menu-item:focus-visible {
        outline: 2px solid ${colors.primary};
        outline-offset: -2px;
    }
    && .bp6-menu-item > .bp6-icon {
        color: inherit;
        opacity: 0.75;
        margin-right: 10px;
    }
    && .bp6-menu-item:hover > .bp6-icon {
        opacity: 1;
    }
    && .bp6-menu-item-label {
        color: inherit;
        opacity: 0.6;
    }
    /* Hints (e.g. failures on Logs) must stand out */
    && .bp6-menu-item-label.${logs_hint_class} {
        opacity: 1;
    }
    /* Actions stand out a little */
    && .bp6-menu-item.bp6-intent-primary {
        color: #8abbff;
    }
    && .bp6-menu-item.bp6-intent-danger {
        color: #fa999c;
    }
    /* The selected view: highlighted, with a bar on the left */
    && .bp6-menu-item.bp6-active,
    && .bp6-menu-item[aria-current="page"] {
        background: rgba(45, 114, 210, 0.28);
        color: ${colors.textPrimary};
        font-weight: ${typography.medium};
    }
    && .bp6-menu-item.bp6-active::before,
    && .bp6-menu-item[aria-current="page"]::before {
        content: '';
        position: absolute;
        left: 0;
        top: 4px;
        bottom: 4px;
        width: 3px;
        border-radius: 0 2px 2px 0;
        background: #4c90f0;
    }
    && .bp6-menu-item.bp6-active > .bp6-icon {
        opacity: 1;
        color: #8abbff;
    }
`;

const SectionDivider = styled.div`
    height: ${borders.width.thin};
    background: rgba(255, 255, 255, 0.08);
    margin: ${spacing.sm} ${spacing.xs};
`;

const SectionHeader = styled.div`
    font-size: ${typography.xs};
    font-weight: ${typography.semibold};
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: ${colors.textMuted};
    margin: ${spacing.lg} ${spacing.sm} ${spacing.xs};

    &:first-child {
        margin-top: ${spacing.xs};
    }
`;

const Sider = styled.div`
    width: ${sider_width};
    transition: width 150ms ease;
    @media (prefers-reduced-motion: reduce) {
        transition: none;
    }
    position: fixed;
    height: 100vh;
    top: 0;
    left: 0;
    z-index: ${sidebar.zIndex};
    display: flex;
    flex-direction: column;
    overflow-x: hidden;
    overflow-y: auto;

    background: var(--qa-sider-background);
    border-right: ${borders.width.thin} solid rgba(0, 0, 0, 0.3);
    color: ${colors.textPrimary};
    font-size: ${typography.base};

    a {
        color: inherit;
        text-decoration: none;
    }

    /* MenuItems are <li>s */
    ul, li {
        list-style: none;
        margin: 0;
        padding: 0;
    }

    scrollbar-width: thin;
    scrollbar-color: ${colors.border} transparent;

    /* Collapsed: a rail of icons. Names show on hover (SiderHint), submenus still open on hover */
    &&.collapsed {
        ${SiderHeader} {
            flex-direction: column;
            height: auto;
            padding: ${spacing.sm} 0;
            gap: 2px;
        }
        ${SiderHeader} .qa-brand {
            display: none;
        }
        ${SiderHeader} .qa-header-actions {
            flex-direction: column;
            gap: 2px;
        }
        ${SiderSection} {
            padding: ${spacing.sm} 6px;
        }
        ${SiderProjectAvatar} a {
            justify-content: center;
            padding: ${spacing.xs} 0;
        }
        ${SiderProjectAvatar} .project-name {
            display: none;
        }
        ${SectionHeader} {
            font-size: 0;
            height: ${borders.width.thin};
            margin: ${spacing.sm} ${spacing.xs};
            background: rgba(255, 255, 255, 0.08);
        }
        ${SectionHeader}:first-child {
            display: none;
        }
        .bp6-menu-item {
            position: relative;
            justify-content: center;
            /* the user menu sets its padding inline */
            padding-left: 0 !important;
            padding-right: 0 !important;
        }
        .bp6-menu-item > .bp6-fill:has(.user-display) {
            flex: 0 0 auto;
        }
        .bp6-menu-item > .bp6-icon {
            margin-right: 0;
        }
        .bp6-menu-item > .bp6-menu-item-label,
        .bp6-menu-item > .bp6-submenu-icon,
        .user-display,
        .chevron-icon {
            display: none;
        }
        /* the names of the items: hidden, but still their names for screen readers */
        ${SiderMenu} .bp6-menu-item > .bp6-fill,
        .bp6-menu-item > .bp6-fill:not(:has(.user-display)) {
            position: absolute;
            width: 1px;
            height: 1px;
            overflow: hidden;
            clip-path: inset(50%);
            white-space: nowrap;
        }
        /* a failure count on Logs becomes a dot */
        .bp6-menu-item > .bp6-menu-item-label.${logs_hint_class} {
            display: block;
            position: absolute;
            top: 3px;
            right: 4px;
            margin: 0;
        }
        .bp6-menu-item > .bp6-menu-item-label.${logs_hint_class} .bp6-tag {
            font-size: 0;
            min-width: 8px;
            min-height: 8px;
            height: 8px;
            padding: 0;
        }
    }
`

// Hovering a view says what it's for: QA-Board has many, and their names are short
const hint_delay = 600;
// Collapsed, the hint also names the view, and opens sooner: it's the only label
const SiderHint = ({ name, content, children }) => {
  const collapsed = useContext(SiderCollapsedContext);
  return <Tooltip
    content={<span style={{display: 'inline-block', maxWidth: 260}}>
      {collapsed && name && <><strong>{name}</strong>{content ? <br/> : null}</>}
      {content}
    </span>}
    placement="right"
    hoverOpenDelay={collapsed ? 150 : hint_delay}
    targetTagName="div"
    fill
    disabled={!content && !collapsed}
  >
    {children}
  </Tooltip>;
}


// The integrations of the branch pages: from qaboard.yaml, or the defaults for the project's git host
const branch_integrations = ({ project_data, commit }) =>
  project_data.data?.qatools_config?.integrations ?? commit?.data?.qatools_config?.integrations ?? default_integrations(project_data);

const ProjectSideAvatar = ({ project, project_data = {} }) => {
  const collapsed = useContext(SiderCollapsedContext);
  let project_name = project.split('/').slice(-1)[0];
  return (
    <SiderProjectAvatar>
      <Link to={`/${project}`} title={`${project}: all its commits`}>
        <ProjectAvatar
          className="avatar"
          project={project}
          data={project_data.data}
          size={collapsed ? "32px" : undefined}
        />
        <span className="project-name">{project_name}</span>
      </Link>
    </SiderProjectAvatar>
  )
}

// Links to the code on the git host. Clicking opens the most useful page (the commit, or the branch's files),
// hovering lists the others: the commit's changes and files, the subproject's folder, the branch, the repository.
const external = { target: "_blank", rel: "noopener noreferrer" };
const short_sha = sha => sha?.slice(0, 8);
export const CodeMenu = ({ project, project_data, commit, branch }) => {
  const project_repo = project_data.data?.git?.path_with_namespace || '';
  // monorepos: projects can be a folder of their repository
  const subproject = project_repo && project.startsWith(`${project_repo}/`) ? project.slice(project_repo.length + 1) : '';
  const repo = repo_url(project_data);
  const sha = commit?.id;
  const ref = sha ?? branch;
  const items = [
    sha && { icon: "git-commit", text: <>Changes in <code>{short_sha(sha)}</code></>, href: commit_url(project_data, sha) },
    sha && { icon: "folder-close", text: <>Files at <code>{short_sha(sha)}</code></>, href: tree_url(project_data, sha) },
    sha && subproject && { icon: "folder-open", text: <>{subproject} at <code>{short_sha(sha)}</code></>, href: tree_url(project_data, sha, subproject) },
    branch && { icon: "folder-close", text: <>Files on {branch}</>, href: tree_url(project_data, branch) },
    branch && subproject && { icon: "folder-open", text: <>{subproject} on {branch}</>, href: tree_url(project_data, branch, subproject) },
    branch && { icon: "git-branch", text: <>Commits on {branch}</>, href: git_commits_url(project_data, branch) },
    { icon: "git-repo", text: "Repository", href: repo },
  ].filter(Boolean);
  // the commit, else the project's folder on the branch
  const main = sha
    ? (subproject ? tree_url(project_data, sha, subproject) : commit_url(project_data, sha))
    : (ref && subproject ? tree_url(project_data, ref, subproject) : repo);
  return <MenuItem
    icon={sha ? "git-commit" : "git-repo"}
    text="Code"
    href={main}
    {...external}
    title={sha ? "The commit on your git host. Hover for its files, branch and repository" : "The code on your git host. Hover for more links"}
    // In a portal, like the sidebar's other submenus: the sidebar scrolls, so it would cut the submenu off, or flip it off-screen on the left
    popoverProps={{ usePortal: true, hoverCloseDelay: 300 }}
  >
    {items.map(({ icon, text, href }) => <MenuItem key={href} icon={icon} text={text} href={href} {...external} labelElement={<Icon icon="share" size={12}/>}/>)}
  </MenuItem>
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
    title="Your storage quota dashboard (opens in a new tab)"
  />
}

// Milestones: a menu to pick any of them, and the user's favorites one click away
const max_sider_favorites = 6;
const SiderMilestones = ({ project, project_data, docs_root }) => {
  const collapsed = useContext(SiderCollapsedContext);
  const { history } = useRouter();
  const { selected } = useComparison();
  const index = useMilestones(project);
  const { list, favorite_groups } = index;
  const [is_open, setOpen] = useState(false);
  // the panel can open on a favorite group: it searches for it
  const [initial_search, setInitialSearch] = useState('');
  const favorites = list.filter(m => m.is_favorite).sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  const groups = favorite_groups.filter(({ group }) => list.some(m => m.group === group || m.group?.startsWith(`${group}/`)));
  const shown = { project: selected.new_project ?? project, commit: selected.route.is_commit ? selected.new_commit_id : null, batch: selected.selected_batch_new, filter: selected.filter_batch_new };
  const current = milestones_of(index, shown);
  const select = milestone => {
    setOpen(false);
    // from qaboard.yaml: a branch, tag or commit
    if (!milestone.commit)
      return history.push(`/${path_segment(project)}/commits/${path_segment(milestone.branch)}`);
    history.push(milestone_location(milestone));
  };
  const openPanel = (search = '') => {
    setInitialSearch(search);
    setOpen(true);
  };
  const extra = { paddingLeft: 24, minHeight: 26, fontSize: 13 };
  const hidden = favorites.length + groups.length - max_sider_favorites;
  return <>
    <PopoverNext
      isOpen={is_open}
      onInteraction={open => open ? openPanel() : setOpen(false)}
      placement="right-start"
      content={<MilestonesPanel key={initial_search} initialSearch={initial_search} project={project} project_data={project_data} docs_root={docs_root} selected={shown} onSelect={select}/>}
    >
      <SiderHint name="Milestones" content="Results saved to compare with later: yours, the project's, your favorites.">
        <MenuItem
          icon="star"
          text="Milestones"
          label={list.length > 0 ? String(list.length) : undefined}
          title={collapsed ? undefined : "Search all the milestones"}
          aria-haspopup="menu"
          aria-expanded={is_open}
        />
      </SiderHint>
    </PopoverNext>
    {!collapsed && groups.slice(0, max_sider_favorites).map(({ section, group }) => <MenuItem
      key={`${section}/${group}`}
      icon={<Icon icon="folder-close" size={12} color={Colors.RED5}/>}
      text={group.split('/').join(' / ')}
      title={`Your favorite group of ${section === 'mine' ? 'your milestones' : 'shared milestones'}: ${group}`}
      style={extra}
      onClick={() => openPanel(group)}
    />)}
    {!collapsed && favorites.slice(0, Math.max(0, max_sider_favorites - groups.length)).map(m => <MenuItemLink
      key={m.id}
      to={milestone_path(m)}
      icon={<Icon icon="heart" size={12} color={Colors.RED5}/>}
      text={milestone_name(m)}
      title={`${milestone_name(m)}: your favorite milestone. ${m.notes ?? ''}`}
      active={current.some(c => c.id === m.id)}
      style={extra}
    />)}
    {!collapsed && hidden > 0 && <MenuItem
      text={`${hidden} more favorite${hidden > 1 ? 's' : ''}…`}
      style={{ ...extra, fontSize: 12 }}
      onClick={() => openPanel()}
    />}
  </>;
};

const ProjectSideCommitList = ({ project, project_data = {}, commit = {}, ref_commit = {}, user, docs_root, ...integrationProps }) => {
  const { selected } = useComparison();
  let qatools_config = project_data.data?.qatools_config || {};
  let integrations = branch_integrations({ project_data, commit });
  let reference_branch = qatools_config.project?.reference_branch;

  const is_history = selected.route.is_history;
  const is_branch = !!selected.branch;
  const is_project_home = selected.route.is_commits && !is_branch;
  const tag = selected.branch ?? selected.committer ?? reference_branch;
  const branch = selected.branch ?? reference_branch;
  const commits_url = branch ? `/${path_segment(project)}/commits/${path_segment(branch)}` : `/${path_segment(project)}/commits`;
  const history_url = branch ? `/${path_segment(project)}/history/${path_segment(branch)}` : `/${path_segment(project)}/history`;
  return <>
    {/* The branch's commits: highlighted on their page, a link elsewhere */}
    <SiderHint name={branch ? `Commits on ${branch}` : tag && !is_branch && !(is_project_home || is_history) ? `Commits by ${tag}` : 'All commits'}>
      {(is_project_home || is_history)
        ? <MenuItemLink to={commits_url} text={(is_branch || project_data.is_loaded) ? branch ?? 'All commits' : <span className={Classes.SKELETON}>branch</span>} title={branch ? `Commits on ${branch}` : 'Commits on all branches'} icon='git-branch'/>
        : <MenuItem icon={is_branch ? "git-branch" : 'user'} active text={tag ?? 'All commits'} title={is_branch ? `Commits on ${tag}` : tag && `Commits by ${tag}`}/>
      }
    </SiderHint>
    <CodeMenu project={project} project_data={project_data} branch={branch}/>
    <SiderHint name="History" content="The metrics of the branch over time.">
      <MenuItemLink to={history_url} active={is_history} icon="history" text="History"/>
    </SiderHint>
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
    <SiderMilestones project={project} project_data={project_data} docs_root={docs_root}/>
    <QuotaMenuItem user={user} project={project} />
  </>
}


const results_integrations = ({ new_batch, commit, project_data }) =>
  new_batch?.data?.qatools_config?.integrations ?? commit?.data?.qatools_config?.integrations ?? project_data.data?.qatools_config?.integrations ?? [];

const ProjectSideResults = ({ project, project_data = {}, commit, ref_commit, new_batch, ref_batch, selected_views, default_views, filter, ref_filter, ref_project, user, docs_root, ...integrationProps }) => {
  const has_optim = new_batch?.data?.optimization === true;
  const active = view => selected_views.includes(view);
  const set = view => () => updateSelected({ selected_views: view }, { defaults: { selected_views: default_views } })
  return <>
    {/* Metrics Section */}
    <SectionHeader>Metrics</SectionHeader>
    <SiderHint name="Summary" content="The batch's metrics, aggregated over all its runs, compared with the reference.">
      <MenuItem icon="dashboard" text="Summary" active={active('summary')} onClick={set('summary')}/>
    </SiderHint>
    <SiderHint name="Metrics Table" content="The metrics of each run, colored by how they compare to their targets.">
      <MenuItem icon="locate" text="Metrics Table" active={active('table-kpi')} onClick={set('table-kpi')} />
    </SiderHint>
    <SiderHint name="Metrics Diff" content="For each run, how the metrics changed versus the reference: find regressions.">
      <MenuItem icon="heat-grid" text="Metrics Diff" active={active('table-compare')} onClick={set('table-compare')}/>
    </SiderHint>

    {/* Runs Section */}
    <SectionHeader>Runs</SectionHeader>
    <SiderHint name="Visualizations" content="Images, videos, plots, point clouds... of each run, side by side with the reference, as configured in qaboard.yaml.">
      <MenuItem icon="media" text="Visualizations" active={active('output-list')} onClick={set('output-list')} />
    </SiderHint>
    <SiderHint name="Output Files" content="All the files each run created, and which differ from the reference (bit-accuracy).">
      <MenuItem icon="folder-open" text="Output Files" active={active('bit-accuracy')} onClick={set('bit-accuracy')} />
    </SiderHint>
    <SiderHint name="Logs" content="The logs of each run, and of the batch's submission: why runs failed.">
      <LogsMenuItem batch={new_batch} active={active('logs')} onClick={set('logs')} />
    </SiderHint>

    {/* Source Section */}
    <SectionHeader>Source</SectionHeader>
    <SiderHint name="Artifacts & Configs" content="The commit's build artifacts and qaboard.yaml configuration, diffed with the reference.">
      <MenuItem icon="settings" text="Artifacts & Configs" active={active('parameters')} onClick={set('parameters')} />
    </SiderHint>
    <CodeMenu project={project} project_data={project_data} commit={commit?.id ? commit : undefined} branch={commit?.branch}/>
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

    {/* Tuning Section */}
    <SectionHeader>Tuning</SectionHeader>
    <SiderHint name="Available Tests" content="The batches of tests you can run: see and edit their definitions.">
      <MenuItem icon="layout-group-by" active={active('groups')} text="Available Tests" onClick={set('groups')} />
    </SiderHint>
    <SiderHint name="Run Tests / Tuning" content="Run this commit on more tests, or with other parameters, from the web app.">
      <MenuItem icon="play" text="Run Tests / Tuning" active={active('tuning')} onClick={set('tuning')} />
    </SiderHint>
    <SiderHint name="Tuning Analysis" content={has_optim ? "This batch is an auto-tuning: see how the parameters affect the metrics." : "How the tuned parameters affect the metrics. Useful after tuning or auto-tuning."}>
      <MenuItem icon="predictive-analysis" intent={has_optim ? "primary" : undefined} active={active('optimization')} text="Tuning Analysis" onClick={set('optimization')}/>
    </SiderHint>

    <SectionHeader>Milestones</SectionHeader>
    <SiderMilestones project={project} project_data={project_data} docs_root={docs_root}/>
  </>
}


const is_mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
export const toggle_sider_keys = is_mac ? '⌘ \\' : 'Ctrl \\';
const CollapseItem = ({ collapsed, onClick }) => <Tooltip
  content={<span>{collapsed ? 'Expand the sidebar' : 'Collapse the sidebar to icons'} <kbd className={Classes.KEY}>{toggle_sider_keys}</kbd></span>}
  placement="right"
  hoverOpenDelay={collapsed ? 150 : hint_delay}
  targetTagName="div"
  fill
>
  <MenuItem
    icon={collapsed ? "double-chevron-right" : "double-chevron-left"}
    text="Collapse"
    onClick={onClick}
    aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
    aria-expanded={!collapsed}
    aria-keyshortcuts="Control+\\ Meta+\\"
  />
</Tooltip>;

const AppSider = () => {
  const { docs_root } = useSiteConfig();
  const { open: openHelp } = useHelpSheet();
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
  const collapsed = useSiderCollapsed();
  const setCollapsed = usePrefsStore(state => state.setSiderCollapsed);
  const toggle = () => setCollapsed(!usePrefsStore.getState().siderCollapsed);
  useToggleShortcut(toggle);

  return (
    <SiderCollapsedContext.Provider value={collapsed}>
    <SiderWidthSync collapsed={collapsed}/>
    <Sider className={`${Classes.DARK}${collapsed ? ' collapsed' : ''}`} aria-label="Navigation" as="nav">
      {/* Header Section */}
      <SiderHeader>
        <Link to="/" className="qa-brand" title="All the projects">QA-Board</Link>
        <span className="qa-header-actions">
          <WhatsNewButton via="sidebar"/>
          <ThemeButton/>
          <Tooltip content={<span>Cheat sheet: shortcuts, words, docs <kbd className={Classes.KEY}>?</kbd></span>}>
            <Button
              variant="minimal"
              size="small"
              icon="help"
              onClick={openHelp}
              aria-label="Cheat sheet"
              aria-keyshortcuts="?"
            />
          </Tooltip>
        </span>
      </SiderHeader>

      {/* Project Section */}
      <SiderSection>
        <ProjectSideAvatar project={project} project_data={project_data} />
      </SiderSection>

      {/* Navigation Section: views of the results on commit pages, else (commit lists, history) the project's pages */}
      <SiderSection>
        {(route.is_list || route.is_history) && (
          <>
            <SiderMenu>
              <ProjectSideCommitList
                commit={latest_commit}
                ref_commit={ref_commit}
                project={project}
                project_data={project_data}
                user={user}
                docs_root={docs_root}
                {...integrationProps}
              />
            </SiderMenu>
          </>
        )}
        {route.is_commit && (
          <SiderMenu>
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
          </SiderMenu>
        )}
      </SiderSection>

      {/* At the bottom, like in most apps */}
      <SiderFooter>
        <AuthButton appSider={true}/>
        <SiderMenu>
          <CollapseItem collapsed={collapsed} onClick={toggle}/>
        </SiderMenu>
      </SiderFooter>
    </Sider>
    </SiderCollapsedContext.Provider>
  )
}

export default AppSider;
