// The list of a project's milestones, to pick one: in the commit bars' Change menu and in the sidebar.
// Your favorites first, then your milestones, the project's shared milestones, and the references from qaboard.yaml.
// Milestones are listed by group ("tuning/denoiser" nests), and the search box matches everything they say.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import styled from "styled-components";
import { DateTime } from "luxon";
import { Icons } from "@blueprintjs/icons";
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
import { useUser, useComparison } from "../hooks";
import { usePrefsStore } from "../stores/prefs";
import { match_query, pretty_label } from "../utils";
import { copyWithToast } from "../utils/clipboard";
import {
  milestone_name, milestone_url, owner_name, relative_date, results_project, group_parts,
  milestone_search_text, runs_matches, dataset_label, is_milestone_side, prefetch_milestone, comparison_sides,
} from "./api";
import { useMilestones, useMilestoneActions, useLegacyMilestones, count_legacy } from "./hooks";
import { openMilestoneDialog } from "./MilestoneDialog";
import { openManageMilestones } from "./ManageMilestones";
import { SideTags, side_tag_style } from "./SideTags";


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
  .qa-milestone-name-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .qa-milestone-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .qa-milestone-name-row > .bp6-tag {
    flex: none;
  }
  ${side_tag_style}
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
  /* until then, the date they were updated shows where the actions will */
  .qa-milestone-hover-slot {
    display: inline-grid;
    align-items: center;
    justify-items: end;
  }
  .qa-milestone-hover-slot > * {
    grid-area: 1 / 1;
  }
  .qa-milestone-hover-slot > .qa-milestone-hover-actions {
    display: flex;
  }
  .qa-milestone-date {
    font-size: 12px;
    white-space: nowrap;
    padding: 0 4px;
  }
  .bp6-menu-item:hover .qa-milestone-date,
  .bp6-menu-item:focus-visible .qa-milestone-date,
  .qa-milestone-hover-slot:focus-within .qa-milestone-date {
    visibility: hidden;
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


// Menus draw their rows all at once, ~1 ms each: with hundreds of milestones, opening and closing them would freeze
// the page. Each section shows its latest milestones (in their groups), and "Show all" the others.
const shown_per_section = 40;

// The tree with only the milestones in `keep`, and the groups that have some. Groups keep their counts.
const prune = (node, keep) => ({
  ...node,
  milestones: node.milestones.filter(m => keep.has(m)),
  groups: node.groups.map(g => prune(g, keep)).filter(g => g.milestones.length + g.groups.length > 0),
});

// `milestones` as a tree, maybe only the latest. Returns {tree, hidden}: the number of milestones left out
const limited_tree = (milestones, root_path, show_all) => {
  const tree = build_tree(milestones, root_path);
  if (show_all || milestones.length <= shown_per_section) return { tree, hidden: 0 };
  const keep = new Set([...milestones].sort(by_date).slice(0, shown_per_section));
  return { tree: prune(tree, keep), hidden: milestones.length - keep.size };
};

const ShowAll = ({ hidden, onClick }) => <MenuItem
  icon="more"
  shouldDismissPopover={false}
  text={<span className={Classes.TEXT_MUTED}>Show {hidden} older milestone{hidden > 1 ? 's' : ''}</span>}
  onClick={onClick}
/>;

// The icons of the menu, loaded once the page is idle: else the first time it opens, each row loads its own
const menu_icons = ['star', 'crown', 'heart', 'link', 'edit', 'info-sign', 'layers', 'comment', 'filter', 'folder-open', 'folder-close', 'chevron-down', 'chevron-right', 'search', 'properties', 'manual', 'more', 'git-branch', 'database', 'layout-skew-grid', 'help'];
const preload_icons = () => Icons.load(menu_icons, 16).catch(() => {});
if (typeof window !== 'undefined') (window.requestIdleCallback ?? (f => setTimeout(f, 2000)))(preload_icons);

// Hovering a milestone for a moment starts loading its results: picking it then shows them right away
const useHoverPrefetch = () => {
  const queryClient = useQueryClient();
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    start: m => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => prefetch_milestone(queryClient, m, { hover: true }), 150);
    },
    cancel: () => clearTimeout(timer.current),
  };
};

// `selected`: {project, commit, batch, filter}, to show which milestone is selected
// `onSelect`: called with a milestone, or {branch} for references from qaboard.yaml
// `onStack`: to add a milestone to the references, instead of replacing the one shown
// `before`: menu items to show first
export const MilestonesPanel = ({ project, project_data, selected, onSelect, onStack, docs_root = '/', before, initialSearch = '' }) => {
  const user = useUser();
  const { list, favorite_groups, isPending, error } = useMilestones(project);
  // once for all the rows
  const { toggleFavorite, toggleGroupFavorite } = useMilestoneActions(project);
  const hover = useHoverPrefetch();
  const [search, setSearch] = useState(initialSearch);
  // the sections whose older milestones users asked to see
  const [show_all, setShowAll] = useState({});
  const showAll = section => setShowAll(state => ({ ...state, [section]: true }));
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
  // where milestones are on the commit page: the new results, a reference
  const sides = comparison_sides(useComparison());
  const sides_of = m => sides.filter(side => is_milestone_side(m, side));
  // ...listed first, in the order of the page: new, then the references
  const position = m => sides.findIndex(side => is_milestone_side(m, side));
  const on_page = is_searching || sides.length === 0 ? [] : list.filter(m => position(m) >= 0).sort((a, b) => position(a) - position(b));
  const item_props = {
    onSelect, onStack, onEdit: milestone => openMilestoneDialog({ project, milestone }), is_selected, sides_of, project, favorite_group, search,
    is_logged: user.is_logged, toggleFavorite, toggleGroupFavorite, hover,
  };
  const favorites_shown = show_all.favorites ? favorites : favorites.slice(0, shown_per_section);
  const mine_tree = limited_tree(mine, 'mine', show_all.mine);
  const team_tree = limited_tree(team, 'team', show_all.shared);

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
      {/* first: with many milestones, it would be out of sight at the end */}
      {list.length > 0 && <MenuItem icon="properties" text="Manage milestones…" title="Sort, edit, delete, move or share several milestones, compare two" onClick={() => openManageMilestones({ project })}/>}

      {legacy_count > 0 && !user.is_logged && <li style={{ padding: '6px 0' }}>
        <Callout intent={Intent.WARNING} icon="warning-sign" compact>
          {legacy_count} milestone{legacy_count > 1 ? 's are' : ' is'} saved only in this browser.
          Sign in to move {legacy_count > 1 ? 'them' : 'it'} to your account: you'll find {legacy_count > 1 ? 'them' : 'it'} on every computer.
          <div style={{ marginTop: 6 }}><AuthButton/></div>
        </Callout>
      </li>}

      {!!error && <MenuItem disabled icon="error" text={`Could not load the milestones: ${error.message}`} multiline/>}
      {isPending && !error && <MenuItem disabled text={<span className={Classes.SKELETON}>Loading the milestones</span>}/>}

      {on_page.length > 0 && <>
        <SectionTitle title="On this page" hint="The milestones the page compares: the new results, and the references, in the order of their tabs."/>
        {on_page.map(m => <MilestoneItem key={`p-${m.id}`} milestone={m} {...item_props} show_owner/>)}
      </>}

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
        {favorites_shown.map(m => <MilestoneItem key={`f-${m.id}`} milestone={m} {...item_props} show_owner/>)}
        {favorites.length > favorites_shown.length && <ShowAll hidden={favorites.length - favorites_shown.length} onClick={() => showAll('favorites')}/>}
      </>}

      {(mine.length > 0 || (!is_searching && !isPending)) && <SectionTitle
        title="My milestones"
        count={mine.length}
        hint="Listed only for you, unless you share them. They follow your account."
      />}
      {mine.length > 0
        ? <>
            <Tree node={mine_tree.tree} section="mine" expand={is_searching} {...item_props}/>
            {mine_tree.hidden > 0 && <ShowAll hidden={mine_tree.hidden} onClick={() => showAll('mine')}/>}
          </>
        : !is_searching && !isPending && (user.is_logged
          ? <MenuItem disabled multiline icon="star-empty" text={<>None yet. To save the results you're looking at, click <Icon icon="star-empty" size={12}/> next to the commit's hash.</>}/>
          : <MenuItem disabled multiline icon="log-in" text="Sign in to save your own milestones."/>
        )}

      {team.length > 0 && <>
        <SectionTitle title="Shared with the project" count={team.length} hint="Everyone on the project sees them. Only their owner can edit them."/>
        <Tree node={team_tree.tree} section="shared" expand={is_searching} show_owner {...item_props}/>
        {team_tree.hidden > 0 && <ShowAll hidden={team_tree.hidden} onClick={() => showAll('shared')}/>}
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
      <MenuItem icon="manual" text="Learn about milestones" href={`${docs_root}docs/user-guide/milestones`} target="_blank" rel="noopener noreferrer"/>
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
  const { is_logged, toggleGroupFavorite } = props;
  const collapsed = usePrefsStore(state => state.milestoneGroupsCollapsed);
  const toggle = usePrefsStore(state => state.toggleMilestoneGroup);
  const is_open = expand || !collapsed[node.path];
  const is_favorite = props.favorite_group?.(section, node.group);
  return <>
    <MenuItem
      className="qa-milestones-group"
      shouldDismissPopover={false}
      icon={<Icon icon={is_open ? 'folder-open' : 'folder-close'} className={Classes.TEXT_MUTED}/>}
      text={<span style={{ fontWeight: 500 }}>{title ?? node.name}</span>}
      labelElement={<span className="qa-milestone-actions">
        {is_logged && <Button
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


const full_date = date => DateTime.fromISO(date).toLocaleString(DateTime.DATETIME_MED);
// "3 days ago" for each row, each time the menu opens, adds up: we remember them for a minute
const relative_dates = new Map();
const short_relative_date = date => {
  const minute = Math.floor(Date.now() / 60000);
  const cached = relative_dates.get(date);
  if (cached?.minute === minute) return cached.text;
  if (relative_dates.size > 2000) relative_dates.clear();
  const text = relative_date(date, { style: 'short' });
  relative_dates.set(date, { minute, text });
  return text;
};
// the full dates, only once hovered
const showDatesTitle = m => event => {
  if (!event.currentTarget.title) event.currentTarget.title = dates_title(m);
};
const dates_title = m => [`Updated ${full_date(m.updated_at)}`, m.created_at && m.created_at !== m.updated_at && `saved ${full_date(m.created_at)}`].filter(Boolean).join(', ');

// "120 runs, 3 failed", as saved with the milestone (backend/milestones.py, summarize_runs): nothing to load
export const runs_count_text = runs => !runs ? null
  : !runs.count ? 'no runs'
  : `${runs.count} run${runs.count > 1 ? 's' : ''}${runs.failed ? `, ${runs.failed} failed` : ''}`;

export const MilestoneItem = ({ milestone: m, onSelect, onStack, onEdit, is_selected, sides_of, project, show_owner, search, is_logged, toggleFavorite, hover, depth = 0 }) => {
  const selected = is_selected?.(m);
  // the new results, or references, on the commit page
  const sides = sides_of?.(m) ?? [];
  const is_reference = sides.some(side => side.is_reference);
  const runs = runs_count_text(m.runs);
  const owner = owner_name(m);
  // listed because of a dataset or qa batch its runs used: say which
  const matched = runs_matches(m, search);
  return <MenuItem
    icon={<Icon icon={m.shared ? 'crown' : 'star'} color={Colors.GOLD4} title={m.shared ? 'Shared with the project' : 'Personal'}/>}
    style={{ paddingLeft: 7 + 16 * depth }}
    active={selected}
    aria-current={selected ? 'true' : undefined}
    text={<div style={{ minWidth: 0 }}>
      <div className="qa-milestone-name-row">
        <span className="qa-milestone-name">{milestone_name(m)}</span>
        {sides.length > 0 ? <SideTags sides={sides}/> : selected && <Tag minimal intent={Intent.PRIMARY}>selected</Tag>}
      </div>
      <div className={`qa-milestone-meta ${Classes.TEXT_MUTED}`}>
        <span title="Batch">{pretty_label({ label: m.batch || 'default' })}</span>
        {!!runs && <span title="Its runs, when it was saved" style={m.runs.count ? undefined : { color: Colors.ORANGE3 }}>{runs}</span>}
        {!!m.filter && <span title="Filter"><Icon icon="filter" size={10}/> {m.filter}</span>}
        <span title={m.message ?? undefined}>{m.branch ? `${m.branch} @ ` : ''}<code>{m.commit.slice(0, 8)}</code></span>
        {results_project(m) !== project && <span title="Project">{results_project(m)}</span>}
        {show_owner && !m.is_mine && owner && <span title="Saved by">{owner}</span>}
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
      {is_logged && <Button
        variant="minimal"
        size="small"
        className={m.is_favorite ? 'qa-is-favorite' : undefined}
        icon={<Icon icon="heart" color={m.is_favorite ? Colors.RED4 : undefined}/>}
        aria-label={m.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
        title={m.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-pressed={!!m.is_favorite}
        onClick={stop(() => toggleFavorite(m).catch(() => {}))}
      />}
      <span className="qa-milestone-hover-slot">
        {!!m.updated_at && <span className={`qa-milestone-date ${Classes.TEXT_MUTED}`} onMouseEnter={showDatesTitle(m)}>{short_relative_date(m.updated_at)}</span>}
        <span className="qa-milestone-hover-actions">
          {!!onStack && !selected && !is_reference && <Button
            variant="minimal"
            size="small"
            icon="layers"
            aria-label="Stack as a reference"
            title="Stack as a reference: compare with it too, keep the reference shown"
            onClick={stop(() => onStack(m))}
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
        </span>
      </span>
    </span>}
    onClick={() => onSelect(m)}
    onMouseEnter={() => hover?.start(m)}
    onFocus={() => hover?.start(m)}
    onMouseLeave={() => hover?.cancel()}
  />;
};
