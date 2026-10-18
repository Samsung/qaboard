// The list of a project's milestones, to pick one: in the commit bars' Change menu and in the sidebar.
// Your favorites first, then your milestones, the project's shared milestones, and the references from qaboard.yaml.
// Milestones are listed by group ("tuning/denoiser" nests), and the search box matches everything they say.
import { Fragment, useMemo, useState } from "react";
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
} from "./api";
import { useMilestones, useMilestoneActions, useLegacyMilestones, count_legacy } from "./hooks";
import { openMilestoneDialog } from "./MilestoneDialog";


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

const SectionTitle = ({ title, count, hint }) => <li className={Classes.MENU_HEADER}>
  <h6 className={Classes.HEADING} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    {title}
    {count > 0 && <span className={Classes.TEXT_MUTED} style={{ fontWeight: 400 }}>{count}</span>}
    {hint && <Tooltip content={<span style={{ display: 'inline-block', maxWidth: 260 }}>{hint}</span>} placement="top">
      <Icon icon="help" size={12} className={Classes.TEXT_MUTED}/>
    </Tooltip>}
  </h6>
</li>;


// What the search box matches
const search_text = m => [
  m.label, m.group, m.notes, m.branch, m.batch, pretty_label({ label: m.batch || 'default' }), m.filter, m.commit, m.message,
  m.committer_name, m.owner?.full_name, m.owner?.user_name, m.shared ? 'shared' : 'personal', m.commit_project,
].filter(Boolean).join(' ');

const by_date = (a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '');

// {name, path, groups: [...], milestones: [...], latest} from milestones with groups like "tuning/denoiser"
const build_tree = (milestones, root_path) => {
  const root = { name: '', path: root_path, groups: {}, milestones: [], count: 0, latest: '' };
  for (const m of milestones) {
    let node = root;
    node.count++;
    for (const part of group_parts(m.group)) {
      node = node.groups[part] ??= { name: part, path: `${node.path}/${part}`, groups: {}, milestones: [], count: 0, latest: '' };
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
export const MilestonesPanel = ({ project, project_data, selected, onSelect, docs_root = '/', before }) => {
  const user = useUser();
  const { list, isPending, error } = useMilestones(project);
  const [search, setSearch] = useState('');
  const legacy = useLegacyMilestones();
  const legacy_count = count_legacy(legacy);

  const refs = useMemo(() => {
    const config_milestones = project_data?.data?.qatools_config?.project?.milestones;
    return (Array.isArray(config_milestones) ? config_milestones : Object.values(config_milestones ?? {})).map(String);
  }, [project_data]);

  const matcher = match_query(search);
  const is_searching = search.trim().length > 0;
  const matching = list.filter(m => matcher(search_text(m)));
  const favorites = matching.filter(m => m.is_favorite).sort(by_date);
  const mine = matching.filter(m => m.is_mine);
  const team = matching.filter(m => !m.is_mine && (m.shared || !m.owner));
  const matching_refs = refs.filter(ref => matcher(`${ref} qaboard.yaml`));
  const nothing = list.length === 0 && refs.length === 0;
  const no_match = !nothing && favorites.length + mine.length + team.length + matching_refs.length === 0;

  const is_selected = m => !!selected && results_project(m) === selected.project && !!selected.commit
    && (selected.commit === m.commit || selected.commit.startsWith(m.commit)) && (m.batch || 'default') === (selected.batch || 'default') && (m.filter || '') === (selected.filter || '');
  const item_props = { onSelect, onEdit: milestone => openMilestoneDialog({ project, milestone }), is_selected, project };

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
          placeholder="Search by name, group, branch, batch, owner…"
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

      {favorites.length > 0 && <>
        <SectionTitle title="Favorites" count={favorites.length}/>
        {favorites.map(m => <MilestoneItem key={`f-${m.id}`} milestone={m} {...item_props} show_owner/>)}
      </>}

      {(mine.length > 0 || (!is_searching && !isPending)) && <SectionTitle
        title="My milestones"
        count={mine.length}
        hint="Listed only for you, unless you share them. They follow your account."
      />}
      {mine.length > 0
        ? <Tree node={build_tree(mine, 'mine')} expand={is_searching} {...item_props}/>
        : !is_searching && !isPending && (user.is_logged
          ? <MenuItem disabled multiline icon="star-empty" text={<>None yet. To save the results you're looking at, click <Icon icon="star-empty" size={12}/> next to the commit's hash.</>}/>
          : <MenuItem disabled multiline icon="log-in" text="Log in to save your own milestones."/>
        )}

      {team.length > 0 && <>
        <SectionTitle title="Shared with the project" count={team.length} hint="Everyone on the project sees them. Only their owner can edit them."/>
        <Tree node={build_tree(team, 'team')} expand={is_searching} show_owner {...item_props}/>
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
      <MenuItem icon="manual" text="Learn about milestones" href={`${docs_root}docs/user-guide/comparing-results#milestones`} target="_blank" rel="noopener noreferrer"/>
    </Panel>;
};


// A group's subgroups, then its milestones. Collapsed groups are remembered.
const Tree = ({ node, depth = 0, expand, ...props }) => {
  const collapsed = usePrefsStore(state => state.milestoneGroupsCollapsed);
  const toggle = usePrefsStore(state => state.toggleMilestoneGroup);
  return <>
    {node.groups.map(group => {
      const is_open = expand || !collapsed[group.path];
      return <Fragment key={group.path}>
        <MenuItem
          className="qa-milestones-group"
          shouldDismissPopover={false}
          icon={<Icon icon={is_open ? 'folder-open' : 'folder-close'} className={Classes.TEXT_MUTED}/>}
          text={<span style={{ fontWeight: 500 }}>{group.name}</span>}
          label={<>{group.count} <Icon icon={is_open ? 'chevron-down' : 'chevron-right'} size={12}/></>}
          onClick={() => toggle(group.path)}
          aria-expanded={is_open}
          style={{ paddingLeft: 7 + 16 * depth }}
        />
        {is_open && <Tree node={group} depth={depth + 1} expand={expand} {...props}/>}
      </Fragment>;
    })}
    {node.milestones.map(m => <MilestoneItem key={m.id} milestone={m} depth={depth} {...props}/>)}
  </>;
};


export const MilestoneItem = ({ milestone: m, onSelect, onEdit, is_selected, project, show_owner, depth = 0 }) => {
  const user = useUser();
  const { toggleFavorite } = useMilestoneActions(project);
  const selected = is_selected?.(m);
  const owner = owner_name(m);
  const stop = action => event => {
    event.preventDefault();
    event.stopPropagation();
    action();
  };
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
