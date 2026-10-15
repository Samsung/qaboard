import { Link, useLinkClickHandler, useRouter } from "./router";
import { path_segment, stringify_query } from "./selection";
import styled from "styled-components";

import { colors, spacing, typography, borders, transitions, sidebar } from './design/tokens';

import {
  Button,
  Classes,
  MenuItem,
  Icon,
  Tooltip,
} from "@blueprintjs/core";

import { ProjectAvatar } from "./components/avatars";
import { IntegrationsMenus } from "./components/integrations";
import { MilestonesMenu } from "./components/milestones"
import AuthButton from "./components/authentication/Auth"
import { WhatsNewButton } from "./releaseNotes/ReleaseNotes"
import { ThemeButton } from "./components/ThemeButton"
import { useHelpSheet } from "./components/HelpSheet"
import { LogsMenuItem, logs_hint_class } from "./AppSiderLogsItem"

import { useCommitsList, useComparison, useSiteConfig, useUser, updateSelected } from "./hooks"
import { useIntegrationStatuses } from "./useIntegrationStatuses"
import { quota_url } from "./utils"
import { repo_url, tree_url, commit_url, commits_url as git_commits_url, default_integrations } from "./git"

export const sider_width = sidebar.width.default;

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
    width: ${sidebar.width.default};
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
`

// Hovering a view says what it's for: QA-Board has many, and their names are short
const hint_delay = 600;
const SiderHint = ({ content, children }) => <Tooltip
  content={<span style={{display: 'inline-block', maxWidth: 260}}>{content}</span>}
  placement="right"
  hoverOpenDelay={hint_delay}
  targetTagName="div"
  fill
>
  {children}
</Tooltip>


// The integrations of the branch pages: from qaboard.yaml, or the defaults for the project's git host
const branch_integrations = ({ project_data, commit }) =>
  project_data.data?.qatools_config?.integrations ?? commit?.data?.qatools_config?.integrations ?? default_integrations(project_data);

const ProjectSideAvatar = ({ project, project_data = {} }) => {
  let project_name = project.split('/').slice(-1)[0];
  return (
    <SiderProjectAvatar>
      <Link to={`/${project}`} title={`${project}: all its commits`}>
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
    popoverProps={{ hoverCloseDelay: 300 }}
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

  // in qaboard.yaml users specify milestones as arrays, but here we handle them as a mapping...
  const qatools_milestones_array = qatools_config?.project?.milestones || []
  const qatools_milestones = Object.fromEntries(Object.entries(qatools_milestones_array).map( ([key, branch])=> [key, {branch}] ))
  const shared_milestones = project_data?.data?.milestones || {}
  const private_milestones = project_data.milestones || {}
  const has_milestones = [qatools_milestones, shared_milestones, private_milestones].some(m => Object.keys(m).length > 0)

  const is_history = selected.route.is_history;
  const is_branch = !!selected.branch;
  const is_project_home = selected.route.is_commits && !is_branch;
  const tag = selected.branch ?? selected.committer ?? reference_branch;
  const branch = selected.branch ?? reference_branch;
  const commits_url = branch ? `/${path_segment(project)}/commits/${path_segment(branch)}` : `/${path_segment(project)}/commits`;
  const history_url = branch ? `/${path_segment(project)}/history/${path_segment(branch)}` : `/${path_segment(project)}/history`;
  return <>
    {/* The branch's commits: highlighted on their page, a link elsewhere */}
    {(is_project_home || is_history)
      ? <MenuItemLink to={commits_url} text={(is_branch || project_data.is_loaded) ? branch ?? 'All commits' : <span className={Classes.SKELETON}>branch</span>} title={branch ? `Commits on ${branch}` : 'Commits on all branches'} icon='git-branch'/>
      : <MenuItem icon={is_branch ? "git-branch" : 'user'} active text={tag ?? 'All commits'} title={is_branch ? `Commits on ${tag}` : tag && `Commits by ${tag}`}/>
    }
    <CodeMenu project={project} project_data={project_data} branch={branch}/>
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
      title="Results saved to compare against later"
      popoverProps={{
        usePortal: true,
        portalClassName: "limit-overflow",
        hoverCloseDelay: 2000,
        transitionDuration: 800,
      }}
    >
      <MilestonesMenu project={project} milestones={qatools_milestones} onSelect={selectMilestone} icon="crown" title="Select a milestone from qaboard.yaml" type="qatools" />
      <MilestonesMenu project={project} milestones={shared_milestones} onSelect={selectMilestone} icon="crown" type="shared" title="Select a shared milestone" />
      <MilestonesMenu project={project} milestones={private_milestones} onSelect={selectMilestone} type="private" title="Select a private milestone" />
      {!has_milestones && <MenuItem
        disabled
        multiline
        icon="info-sign"
        text={<span style={{display: 'inline-block', maxWidth: 280}}>
          No milestones yet. Save one with the <Icon icon="star-empty" size={12}/> next to a commit on its page,
          or list branches under <code>project.milestones</code> in <em>qaboard.yaml</em>.
        </span>}
      />}
      <MenuItem
        icon="manual"
        text="Learn about milestones"
        href={`${docs_root}docs/references-and-milestones`}
        target="_blank"
        rel="noopener noreferrer"
      />
    </MenuItem>
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
    <SiderHint content="The batch's metrics, aggregated over all its runs, compared with the reference.">
      <MenuItem icon="dashboard" text="Summary" active={active('summary')} onClick={set('summary')}/>
    </SiderHint>
    <SiderHint content="The metrics of each run, colored by how they compare to their targets.">
      <MenuItem icon="locate" text="Metrics Table" active={active('table-kpi')} onClick={set('table-kpi')} />
    </SiderHint>
    <SiderHint content="For each run, how the metrics changed versus the reference: find regressions.">
      <MenuItem icon="heat-grid" text="Metrics Diff" active={active('table-compare')} onClick={set('table-compare')}/>
    </SiderHint>

    {/* Runs Section */}
    <SectionHeader>Runs</SectionHeader>
    <SiderHint content="Images, videos, plots, point clouds... of each run, side by side with the reference, as configured in qaboard.yaml.">
      <MenuItem icon="media" text="Visualizations" active={active('output-list')} onClick={set('output-list')} />
    </SiderHint>
    <SiderHint content="All the files each run created, and which differ from the reference (bit-accuracy).">
      <MenuItem icon="folder-open" text="Output Files" active={active('bit-accuracy')} onClick={set('bit-accuracy')} />
    </SiderHint>
    <SiderHint content="The logs of each run, and of the batch's submission: why runs failed.">
      <LogsMenuItem batch={new_batch} active={active('logs')} onClick={set('logs')} />
    </SiderHint>

    {/* Source Section */}
    <SectionHeader>Source</SectionHeader>
    <SiderHint content="The commit's build artifacts and qaboard.yaml configuration, diffed with the reference.">
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
    <SiderHint content="The batches of tests you can run: see and edit their definitions.">
      <MenuItem icon="layout-group-by" active={active('groups')} text="Available Tests" onClick={set('groups')} />
    </SiderHint>
    <SiderHint content="Run this commit on more tests, or with other parameters, from the web app.">
      <MenuItem icon="play" text="Run Tests / Tuning" active={active('tuning')} onClick={set('tuning')} />
    </SiderHint>
    <SiderHint content={has_optim ? "This batch is an auto-tuning: see how the parameters affect the metrics." : "How the tuned parameters affect the metrics. Useful after tuning or auto-tuning."}>
      <MenuItem icon="predictive-analysis" intent={has_optim ? "primary" : undefined} active={active('optimization')} text="Tuning Analysis" onClick={set('optimization')}/>
    </SiderHint>
  </>
}


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

  return (
    <Sider className={Classes.DARK}>
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
      </SiderFooter>
    </Sider>
  )
}

export default AppSider;
