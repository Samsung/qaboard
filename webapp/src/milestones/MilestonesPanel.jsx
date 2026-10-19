// The list of a project's milestones, to pick one: in the commit bars' Change menu and in the sidebar.
// Your favorites first, then your milestones, the project's shared milestones, and the references from qaboard.yaml.
// Milestones are listed by group ("tuning/denoiser" nests), and the search box matches everything they say.
import { useMemo, useState } from "react";
import styled from "styled-components";
import {
  Button,
  Callout,
  Classes,
  Colors,
  Icon,
  InputGroup,
  Intent,
  Menu,
  MenuItem,
  Tag,
  Tooltip,
} from "@blueprintjs/core";

import AuthButton from "../components/authentication/Auth";
import { useUser } from "../hooks";
import { usePrefsStore } from "../stores/prefs";
import { match_query, pretty_label } from "../utils";
import { copyWithToast } from "../utils/clipboard";
import {
  milestone_name, milestone_url, owner_name, relative_date, results_project, group_parts,
  milestone_search_text, runs_matches, dataset_label,
} from "./api";
import { useMilestones, useMilestoneActions, useLegacyMilestones, count_legacy } from "./hooks";
import { openMilestoneDialog } from "./MilestoneDialog";
import { openManageMilestones } from "./ManageMilestones";


const Panel = styled(Menu)`
  width: 420px;
  max-width: calc(100vw - 32px);
  max-height: min(560px, 75vh);
  overflow-y: auto;
  padding-top: 0;

  .qa-milestones-search {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 6px 0;
    background: inherit;
  }
  .qa-milestone-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-milestone-meta {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qa-milestone-meta > * + *::before {
    content: '·';
    margin: 0 5px;
    opacity: 0.6;
  }
  .qa-milestone-matched {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 3px;
  }
  .qa-milestone-actions {
    display: flex;
    align-items: center;
  }
  /* actions show on hover, favorites always show their heart */
  .qa-milestone-actions .bp6-button:not(.qa-is-favorite) {
    opacity: 0;
  }
  .bp6-menu-item:hover .qa-milestone-actions .bp6-button,
  .bp6-menu-item:focus-visible .qa-milestone-actions .bp6-button,
  .qa-milestone-actions .bp6-button:focus-visible {
    opacity: 1;
  }
  .bp6-menu-item.qa-milestones-group {
    min-height: 26px;
    padding-top: 2px;
    padding-bottom: 2px;
  }
`;

// Counts help with long lists, they're noise next to 1 or 2 items you can see
const worth_counting = count => count > 2;

const SectionTitle = ({ title, count, hint }) => <li className={Classes.MENU_HEADER}>
  <h6 className={Classes.HEADING} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    {title}
    {worth_counting(count) && <span className={Classes.TEXT_MUTED} style={{ fontWeight: 400 }}>{count}</span>}
    {hint && <Tooltip content={<span style={{ display: 'inline-block', maxWidth: 260 }}>{hint}</span>} placement="top">
      <Icon icon="help" size={12} className={Classes.TEXT_MUTED}/>
    </Tooltip>}
  </h6>
</li>;


const by_date = (a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '');

// {name, path, group, groups: [...], milestones: [...], latest} from milestones with groups like "tuning/denoiser".
// `path` says where the tree is shown (to remember collapsed groups), `group` is the group's full name.
// `prefix`: the group whose content the tree shows, e.g. a favorite group
const build_tree = (milestones, root_path, prefix = '') => {
  const skip = group_parts(prefix).length;
  const root = { name: '', path: root_path, group: prefix, groups: {}, milestones: [], count: 0, latest: '' };
  for (const m of milestones) {
    let node = root;
    node.count++;
    for (const part of group_parts(m.group).slice(skip)) {
      node = node.groups[part] ??= { name: part, path: `${node.path}/${part}`, group: node.group ? `${node.group}/${part}` : part, groups: {}, milestones: [], count: 0, latest: '' };
      node.count++;
    }
    node.milestones.push(m);
  }
  const finish = node => {
    node.milestones.sort(by_date);
    node.groups = Object.values(node.groups).map(finish);
    node.latest = [node.milestones[0]?.updated_at ?? '', ...node.groups.map(g => g.latest)].sort().at(-1);
    // the groups with recent milestones first
    node.groups.sort((a, b) => b.latest.localeCompare(a.latest) || a.name.localeCompare(b.name));
    return node;
  };
  return finish(root);
};


// `selected`: {project, commit, batch, filter}, to show which milestone is selected
// `onSelect`: called with a milestone, or {branch} for references from qaboard.yaml
// `before`: menu items to show first
export const MilestonesPanel = ({ project, project_data, selected, onSelect, docs_root = '/', before, initialSearch = '' }) => {
  const user = useUser();
  const { list, favorite_groups, isPending, error } = useMilestones(project);
  const [search, setSearch] = useState(initialSearch);
  const legacy = useLegacyMilestones();
  const legacy_count = count_legacy(legacy);

  const refs = useMemo(() => {
    const config_milestones = project_data?.data?.qatools_config?.project?.milestones;
    return (Array.isArray(config_milestones) ? config_milestones : Object.values(config_milestones ?? {})).map(String);
  }, [project_data]);

  const matcher = match_query(search);
  const is_searching = search.trim().length > 0;
  const matching = list.filter(m => matcher(milestone_search_text(m)));
  const favorites = matching.filter(m => m.is_favorite).sort(by_date);
  const mine = matching.filter(m => m.is_mine);
  const team = matching.filter(m => !m.is_mine && m.shared);
  const sections = { mine, shared: team };
  // favorite groups list their milestones, even those saved later
  const in_group = group => m => m.group === group || m.group?.startsWith(`${group}/`);
  const favorite_trees = favorite_groups
    .map(({ section, group }) => ({ section, group, milestones: (sections[section] ?? []).filter(in_group(group)) }))
    .filter(f => f.milestones.length > 0);
  const matching_refs = refs.filter(ref => matcher(`${ref} qaboard.yaml`));
  const nothing = list.length === 0 && refs.length === 0;
  const no_match = !nothing && favorites.length + mine.length + team.length + matching_refs.length === 0;
  const favorite_group = (section, group) => favorite_groups.some(f => f.section === section && f.group === group);

  const is_selected = m => !!selected && results_project(m) === selected.project && !!selected.commit
    && (selected.commit === m.commit || selected.commit.startsWith(m.commit)) && (m.batch || 'default') === (selected.batch || 'default') && (m.filter || '') === (selected.filter || '');
  const item_props = { onSelect, onEdit: milestone => openMilestoneDialog({ project, milestone }), is_selected, project, favorite_group, search };

  // Enter picks the first result
  const first = favorites[0] ?? mine[0] ?? team[0];
  const onKeyDown = event => {
    if (event.key !== 'Enter') return;
    if (first) onSelect(first);
    else if (matching_refs[0]) onSelect({ branch: matching_refs[0] });
  };

  return <Panel aria-label="Milestones">
    {before}
      {list.length + refs.length > 3 && <div className="qa-milestones-search">
        <InputGroup
          placeholder="Search by name, group, dataset, branch, owner…"
          leftIcon="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search milestones"
          autoFocus
          rightElement={search ? <Button variant="minimal" icon="cross" aria-label="Clear the search" onClick={() => setSearch('')}/> : undefined}
        />
      </div>}

      {legacy_count > 0 && !user.is_logged && <li style={{ padding: '6px 0' }}>
        <Callout intent={Intent.WARNING} icon="warning-sign" compact>
          {legacy_count} milestone{legacy_count > 1 ? 's are' : ' is'} saved only in this browser.
          Log in to move {legacy_count > 1 ? 'them' : 'it'} to your account: you'll find {legacy_count > 1 ? 'them' : 'it'} on every computer.
          <div style={{ marginTop: 6 }}><AuthButton/></div>
        </Callout>
      </li>}

      {!!error && <MenuItem disabled icon="error" text={`Could not load the milestones: ${error.message}`} multiline/>}
      {isPending && !error && <MenuItem disabled text={<span className={Classes.SKELETON}>Loading the milestones</span>}/>}

      {favorites.length + favorite_trees.length > 0 && <>
        <SectionTitle title="Favorites" count={favorites.length + favorite_trees.length}/>
        {favorite_trees.map(({ section, group, milestones }) => <FavoriteGroup
          key={`fg-${section}-${group}`}
          section={section}
          group={group}
          milestones={milestones}
          expand={is_searching}
          {...item_props}
        />)}
        {favorites.map(m => <MilestoneItem key={`f-${m.id}`} milestone={m} {...item_props} show_owner/>)}
      </>}

      {(mine.length > 0 || (!is_searching && !isPending)) && <SectionTitle
        title="My milestones"
        count={mine.length}
        hint="Listed only for you, unless you share them. They follow your account."
      />}
      {mine.length > 0
        ? <Tree node={build_tree(mine, 'mine')} section="mine" expand={is_searching} {...item_props}/>
        : !is_searching && !isPending && (user.is_logged
          ? <MenuItem disabled multiline icon="star-empty" text={<>None yet. To save the results you're looking at, click <Icon icon="star-empty" size={12}/> next to the commit's hash.</>}/>
          : <MenuItem disabled multiline icon="log-in" text="Log in to save your own milestones."/>
        )}

      {team.length > 0 && <>
        <SectionTitle title="Shared with the project" count={team.length} hint="Everyone on the project sees them. Only their owner can edit them."/>
        <Tree node={build_tree(team, 'team')} section="shared" expand={is_searching} show_owner {...item_props}/>
      </>}

      {matching_refs.length > 0 && <>
        <SectionTitle title="From qaboard.yaml" count={matching_refs.length} hint={<>Branches, tags or commits listed under <code>project.milestones</code>. Picking one selects its latest commit.</>}/>
        {matching_refs.map(ref => <MenuItem key={ref} icon="git-branch" text={ref} label="latest commit" onClick={() => onSelect({ branch: ref })}/>)}
      </>}

      {no_match && <MenuItem disabled icon="search" text={<>No milestone matches “{search}”</>}/>}
      {nothing && !isPending && <MenuItem disabled multiline icon="info-sign" text={<span className={Classes.TEXT_MUTED}>
        Milestones are results worth comparing with: a release, a benchmark, your best tuning.
        Save one with <Icon icon="star-empty" size={12}/> next to a commit's hash, or list branches under <code>project.milestones</code> in <em>qaboard.yaml</em>.
      </span>}/>}
      {list.length > 0 && <MenuItem icon="properties" text="Manage milestones…" title="Sort, edit, delete, move or share several milestones, compare two" onClick={() => openManageMilestones({ project })}/>}
      <MenuItem icon="manual" text="Learn about milestones" href={`${docs_root}docs/user-guide/comparing-results#milestones`} target="_blank" rel="noopener noreferrer"/>
    </Panel>;
};


// A group's subgroups, then its milestones. Collapsed groups are remembered.
const Tree = ({ node, depth = 0, expand, section, ...props }) => <>
  {node.groups.map(group => <GroupItem key={group.path} node={group} depth={depth} expand={expand} section={section} {...props}/>)}
  {node.milestones.map(m => <MilestoneItem key={m.id} milestone={m} depth={depth} {...props}/>)}
</>;

const stop = action => event => {
  event.preventDefault();
  event.stopPropagation();
  action();
};

const GroupItem = ({ node, depth, expand, section, title, ...props }) => {
  const user = useUser();
  const collapsed = usePrefsStore(state => state.milestoneGroupsCollapsed);
  const toggle = usePrefsStore(state => state.toggleMilestoneGroup);
  const { toggleGroupFavorite } = useMilestoneActions(props.project);
  const is_open = expand || !collapsed[node.path];
  const is_favorite = props.favorite_group?.(section, node.group);
  return <>
    <MenuItem
      className="qa-milestones-group"
      shouldDismissPopover={false}
      icon={<Icon icon={is_open ? 'folder-open' : 'folder-close'} className={Classes.TEXT_MUTED}/>}
      text={<span style={{ fontWeight: 500 }}>{title ?? node.name}</span>}
      labelElement={<span className="qa-milestone-actions">
        {user.is_logged && <Button
          variant="minimal"
          size="small"
          className={is_favorite ? 'qa-is-favorite' : undefined}
          icon={<Icon icon="heart" color={is_favorite ? Colors.RED4 : undefined}/>}
          aria-label={is_favorite ? `Remove the group ${node.group} from favorites` : `Add the group ${node.group} to favorites`}
          title={is_favorite ? 'Remove the group from favorites' : 'Add the group to favorites: its milestones, even future ones, are listed first'}
          aria-pressed={!!is_favorite}
          onClick={stop(() => toggleGroupFavorite(section, node.group).catch(() => {}))}
        />}
        {(!is_open || worth_counting(node.count)) && <span className={Classes.TEXT_MUTED} style={{ margin: '0 4px' }}>{node.count}</span>}
        <Icon icon={is_open ? 'chevron-down' : 'chevron-right'} size={12}/>
      </span>}
      onClick={() => toggle(node.path)}
      aria-expanded={is_open}
      style={{ paddingLeft: 7 + 16 * depth }}
    />
    {is_open && <Tree node={node} depth={depth + 1} expand={expand} section={section} {...props}/>}
  </>;
};

// A favorite group, with its milestones and subgroups
const FavoriteGroup = ({ section, group, milestones, expand, ...props }) => {
  const node = build_tree(milestones, `favorites/${section}/${group}`, group);
  return <GroupItem
    node={{ ...node, name: group }}
    title={<>{group_parts(group).join(' / ')}{section === 'shared' && <span className={Classes.TEXT_MUTED} style={{ fontWeight: 400 }}> · shared</span>}</>}
    depth={0}
    expand={expand}
    section={section}
    show_owner={section === 'shared'}
    {...props}
  />;
};


export const MilestoneItem = ({ milestone: m, onSelect, onEdit, is_selected, project, show_owner, search, depth = 0 }) => {
  const user = useUser();
  const { toggleFavorite } = useMilestoneActions(project);
  const selected = is_selected?.(m);
  const owner = owner_name(m);
  // listed because of a dataset or qa batch its runs used: say which
  const matched = runs_matches(m, search);
  return <MenuItem
    icon={<Icon icon={m.shared ? 'crown' : 'star'} color={Colors.GOLD4} title={m.shared ? 'Shared with the project' : 'Personal'}/>}
    style={{ paddingLeft: 7 + 16 * depth }}
    active={selected}
    aria-current={selected ? 'true' : undefined}
    text={<div style={{ minWidth: 0 }}>
      <div className="qa-milestone-name">
        {milestone_name(m)}
        {selected && <Tag minimal intent={Intent.PRIMARY} style={{ marginLeft: 6 }}>selected</Tag>}
      </div>
      <div className={`qa-milestone-meta ${Classes.TEXT_MUTED}`}>
        <span title="Batch">{pretty_label({ label: m.batch || 'default' })}</span>
        {!!m.filter && <span title="Filter"><Icon icon="filter" size={10}/> {m.filter}</span>}
        <span title={m.message ?? undefined}>{m.branch ? `${m.branch} @ ` : ''}<code>{m.commit.slice(0, 8)}</code></span>
        {results_project(m) !== project && <span title="Project">{results_project(m)}</span>}
        {show_owner && !m.is_mine && owner && <span title="Saved by">{owner}</span>}
        {!!m.updated_at && <span title={`Saved ${m.created_at}`}>{relative_date(m.updated_at)}</span>}
      </div>
      {matched.length > 0 && <div className="qa-milestone-matched">
        {matched.slice(0, 3).map(v => <Tag key={`${v.kind}-${v.name}`} minimal intent={Intent.PRIMARY} icon={v.kind === 'dataset' ? 'database' : v.kind === 'qa batch' ? 'layout-skew-grid' : 'desktop'} title={`Its runs used the ${v.kind} ${v.name}`}>
          {v.kind}: {v.kind === 'dataset' ? dataset_label(v.name) : v.name}
        </Tag>)}
      </div>}
    </div>}
    labelElement={<span className="qa-milestone-actions">
      {!!m.notes && <Tooltip content={<div style={{ maxWidth: 320, whiteSpace: 'pre-wrap' }}>{m.notes}</div>} placement="left">
        <Icon icon="comment" size={12} className={Classes.TEXT_MUTED} style={{ margin: '0 4px' }} aria-label={`Notes: ${m.notes}`}/>
      </Tooltip>}
      {user.is_logged && <Button
        variant="minimal"
        size="small"
        className={m.is_favorite ? 'qa-is-favorite' : undefined}
        icon={<Icon icon="heart" color={m.is_favorite ? Colors.RED4 : undefined}/>}
        aria-label={m.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
        title={m.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-pressed={!!m.is_favorite}
        onClick={stop(() => toggleFavorite(m).catch(() => {}))}
      />}
      <Button variant="minimal" size="small" icon="link" aria-label="Copy the link" title="Copy the link" onClick={stop(() => copyWithToast(milestone_url(m), { what: 'the link to the milestone' }))}/>
      {!!onEdit && <Button
        variant="minimal"
        size="small"
        icon={m.can_edit ? 'edit' : 'info-sign'}
        aria-label={m.can_edit ? 'Edit' : 'Details'}
        title={m.can_edit ? 'Edit' : 'Details'}
        onClick={stop(() => onEdit(m))}
      />}
    </span>}
    onClick={() => onSelect(m)}
  />;
};
