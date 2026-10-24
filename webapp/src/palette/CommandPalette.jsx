// The command palette: Ctrl+K (⌘K on macOS), or "/" when not typing, opens it from any page, to go to a project,
// a branch or commit of the current project, one of the user's recent batches, a page of the app, or do an action.
// Mounted once in App.jsx; buttons open it with useCommandPalette().open. Matching and ranking: logic.js.
import { createContext, useCallback, useContext, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { Button, Classes, Dialog, Icon, InputGroup, Spinner, Tooltip } from "@blueprintjs/core";
import { QueryList } from "@blueprintjs/select";
import styled from "styled-components";
import { DateTime } from "luxon";

import { http } from "../api/http";
import { matchRoutes } from "../router";
import { app_paths, route_paths } from "../route_paths";
import { useProjects, useSiteConfig, useUser } from "../hooks";
import { usePrefsStore } from "../stores/prefs";
import { useIsDark } from "../theme";
import { is_typing, useHelpSheet } from "../components/HelpSheet";
import { useReleaseNotes } from "../releaseNotes/ReleaseNotes";
import { useSignOut } from "../components/authentication/Auth";
import { requestLogin } from "../components/authentication/login";
import { ProjectAvatar } from "../components/avatars";
import { origins } from "../BatchList";
import { track } from "../analytics";
import {
  app_items, group_sections, highlight_parts, looks_like_sha, rank_app_items, rank_batches, rank_branches, rank_commits, rank_projects,
} from "./logic";


const PaletteContext = createContext({ open: () => {}, isOpen: false });
export const useCommandPalette = () => useContext(PaletteContext);

export const is_mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
export const shortcut_label = is_mac ? '⌘K' : 'Ctrl K';
const is_palette_shortcut = event => event.key?.toLowerCase() === 'k' && (is_mac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey;
const is_slash = event => event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey;

const is_printable = event => event.key?.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;

export const CommandPaletteProvider = ({ children }) => {
  const [isOpen, setOpen] = useState(false);
  const open_ref = useRef(false);
  useEffect(() => { open_ref.current = isOpen }, [isOpen]);
  // Users type right after Ctrl+K: what they type before the search box has the focus goes in it
  const typed = useRef('');
  const type_in = useRef(null);
  const typing = useMemo(() => ({
    take: () => { const text = typed.current; typed.current = ''; return text },
    register: callback => { type_in.current = callback },
  }), []);
  const open = useCallback(via => {
    typed.current = '';
    open_ref.current = true;
    setOpen(true);
    track("command_palette_open", { via: typeof via === 'string' ? via : 'button' });
  }, []);
  useEffect(() => {
    const onKeyDown = event => {
      // keyCode 229: Safari's first key of an IME composition
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const in_palette = event.target instanceof Element && !!event.target.closest('.qa-palette');
      if (open_ref.current && is_printable(event) && !(in_palette && is_typing(event.target))) {
        event.preventDefault();
        if (type_in.current) type_in.current(event.key);
        else typed.current += event.key;
        return;
      }
      const ctrl_k = is_palette_shortcut(event);
      if (!ctrl_k && !is_slash(event)) return;
      // a held key would open and close it in a loop
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      // text boxes and editors (Monaco types in a textarea) keep their keys, except the palette's own box: Ctrl+K closes it
      if (is_typing(event.target) && !(ctrl_k && in_palette)) return;
      event.preventDefault();
      if (ctrl_k && open_ref.current) {
        open_ref.current = false;
        setOpen(false);
      }
      else if (!open_ref.current) open(ctrl_k ? 'ctrl-k' : 'slash');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);
  const value = useMemo(() => ({ open, isOpen }), [open, isOpen]);
  return <PaletteContext.Provider value={value}>
    {children}
    <CommandPalette isOpen={isOpen} onClose={() => setOpen(false)} typing={typing}/>
  </PaletteContext.Provider>;
};


// ---------------------------------------------------------------- data
// Fetched only while the palette is open, and bounded: sites have hundreds of projects, thousands of branches and commits
const my_batches_limit = 8;
// under ['batches']: what refreshes batches (a redo, a deletion) refreshes these too
const myBatchesQuery = viewer => queryOptions({
  queryKey: ['batches', 'palette', viewer],
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/batches', { params: { scope: 'mine', limit: my_batches_limit }, signal, background: true });
    return Array.isArray(data) ? data : [];
  },
  staleTime: 30 * 1000,
});

const branches_limit = 8;
const branchesQuery = (project, q) => queryOptions({
  queryKey: ['branches', project, q, 'palette'],
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/project/branches', { params: { project, q, limit: branches_limit }, signal, background: true });
    return Array.isArray(data) ? [...new Set(data.map(branch => branch.replace(/^origin\//, '')))] : [];
  },
  staleTime: 60 * 1000,
  // while users type, the previous answer (logic.js keeps the branches that still match), never another project's
  placeholderData: (previous, previous_query) => previous_query?.queryKey[1] === project ? previous : undefined,
});

// We offer to go to a commit only once we know it exists
const commitsQuery = (project, prefix) => queryOptions({
  queryKey: ['commits', 'palette', project, prefix],
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/commits', { params: { project, q: `id:${prefix}`, limit: 5 }, signal, background: true });
    return Array.isArray(data) ? data : [];
  },
  staleTime: 60 * 1000,
});

const useDebounced = (value, delay) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
};

// The project whose page we're on, if any (the app's own pages are matched first, like in App.jsx)
const project_routes = Object.values(route_paths).map(path => ({ path }));
const app_routes = Object.values(app_paths).map(path => ({ path, exact: true }));
export const current_project = pathname => {
  if (pathname === '/' || matchRoutes(app_routes, pathname)) return null;
  const id = matchRoutes(project_routes, pathname)?.match.params.project_id;
  if (!id) return null;
  try { return decodeURIComponent(id) } catch { return id }
};


// ---------------------------------------------------------------- the palette
const debounce_ms = 200;

const CommandPalette = ({ isOpen, onClose, typing }) => {
  const title_id = useId();
  return <PaletteDialog
    isOpen={isOpen}
    onClose={onClose}
    className="qa-palette"
    aria-labelledby={title_id}
    transitionDuration={120}
  >
    <h2 id={title_id} style={visually_hidden}>Search QA-Board</h2>
    {/* nothing is fetched until it opens */}
    {isOpen && <PaletteContent onClose={onClose} typing={typing}/>}
  </PaletteDialog>;
};

const PaletteContent = ({ onClose, typing }) => {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const project = current_project(pathname);
  const user = useUser();
  const { docs_root } = useSiteConfig();
  const is_dark = useIsDark();
  const setTheme = usePrefsStore(state => state.setTheme);
  const favorites = usePrefsStore(state => state.favorites);
  const { open: openReleaseNotes } = useReleaseNotes();
  const { open: openHelp } = useHelpSheet();
  const signOut = useSignOut();

  const [query, setQuery] = useState(typing.take);
  const [active_key, setActiveKey] = useState(null);
  const input = useRef(null);
  // keys typed while the focus was elsewhere
  useEffect(() => {
    input.current?.focus();
    typing.register(text => {
      setQuery(value => value + text);
      setActiveKey(null);
      input.current?.focus();
    });
    return () => typing.register(null);
  }, [typing]);
  // matching hundreds of projects for each key stroke must not delay typing
  const deferred = useDeferredValue(query);
  const trimmed = deferred.trim();
  const debounced = useDebounced(trimmed, debounce_ms);
  const [now] = useState(() => Date.now());

  const projects = useProjects();
  const batches = useQuery({ ...myBatchesQuery(user.user_id), enabled: !!user.is_logged });
  // the server finds branches containing a text: we send the longest word, logic.js ranks them with all of them
  const branch_word = debounced.split(/\s+/).reduce((longest, word) => word.length > longest.length ? word : longest, '');
  const branches = useQuery({ ...branchesQuery(project, branch_word), enabled: !!project && !!branch_word });
  const sha = project && looks_like_sha(debounced) ? debounced.toLowerCase() : null;
  const commits = useQuery({ ...commitsQuery(project, sha), enabled: !!sha });

  const pages = useMemo(() => app_items({ user, docs_root, is_dark }), [user, docs_root, is_dark]);
  const sections = useMemo(() => group_sections([
    ...rank_commits(project, commits.data, trimmed),
    ...rank_projects(projects.data, trimmed, { favorites, now }),
    ...rank_branches(project, branches.data, trimmed),
    ...rank_batches(user.is_logged ? batches.data : [], trimmed),
    ...rank_app_items(pages, trimmed),
  ], trimmed), [project, commits.data, projects.data, branches.data, batches.data, pages, favorites, now, trimmed, user.is_logged]);
  const items = useMemo(() => sections.flatMap(section => section.items), [sections]);

  // The first item is active until users pick another; it follows the best match while results arrive
  const active = items.find(item => item.key === active_key) ?? items[0] ?? null;
  const loading = (projects.isPending && !projects.data)
    || (!!project && trimmed !== '' && (trimmed !== debounced || branches.isFetching))
    || (!!sha && commits.isFetching);

  const select = (item, event) => {
    if (!item) return;
    const new_tab = event?.metaKey || event?.ctrlKey;
    track("command_palette_select", { section: item.section, has_query: !!trimmed });
    if (item.url && new_tab) return void window.open(item.url, '_blank', 'noopener');
    if (item.href) {
      onClose();
      return void window.open(item.href, '_blank', 'noopener');
    }
    onClose();
    if (item.url) return navigate(item.url);
    if (item.action === 'whats-new') openReleaseNotes('command-palette');
    if (item.action === 'theme') setTheme(is_dark ? 'light' : 'dark');
    if (item.action === 'cheat-sheet') openHelp();
    if (item.action === 'sign-out') signOut();
    if (item.action === 'sign-in') requestLogin();
  };

  const placeholder = project ? 'Search projects, branches, commits, pages…' : 'Search projects, batches, pages…';
  return <QueryList
    items={items}
    itemListPredicate={keep_all}
    itemsEqual="key"
    query={query}
    onQueryChange={value => { setQuery(value); setActiveKey(null) }}
    resetOnQuery={false}
    activeItem={active}
    onActiveItemChange={item => setActiveKey(item?.key ?? null)}
    onItemSelect={select}
    itemRenderer={(item, props) => <Row key={item.key} item={item} {...props}/>}
    renderer={({ handleKeyDown, handleKeyUp, handleQueryChange, itemList, listId, activeItemId }) => <div>
      <SearchBox>
        <InputGroup
          inputRef={input}
          size="large"
          leftIcon="search"
          placeholder={placeholder}
          value={query}
          onChange={handleQueryChange}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          role="combobox"
          aria-label={placeholder}
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-activedescendant={active ? activeItemId : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          rightElement={<span className="qa-palette-input-right">
            {/* its room is kept: the hint doesn't move while results load */}
            <span className="qa-palette-spinner">{loading && <Spinner size={14} aria-label="Loading"/>}</span>
            <kbd className={Classes.KEY}>Esc</kbd>
          </span>}
        />
      </SearchBox>
      {itemList}
      <Footer aria-hidden="true" className={project ? undefined : 'qa-no-scope'}>
        <span><kbd className={Classes.KEY}>↑</kbd><kbd className={Classes.KEY}>↓</kbd> to navigate</span>
        <span><kbd className={Classes.KEY}>↵</kbd> to open</span>
        <span><kbd className={Classes.KEY}>{is_mac ? '⌘' : 'Ctrl'}</kbd><kbd className={Classes.KEY}>↵</kbd> in a new tab</span>
        <span className="qa-palette-scope">{project ? <>In <strong>{project}</strong></> : null}</span>
      </Footer>
    </div>}
    itemListRenderer={({ filteredItems, renderItem, itemsParentRef, menuProps }) => {
      // listboxes only hold options: what we say about the results is next to it, and read by screen readers
      const status = <span aria-live="polite" style={visually_hidden}>
        {loading ? 'Searching…' : `${filteredItems.length} result${filteredItems.length === 1 ? '' : 's'}`}
      </span>;
      if (filteredItems.length === 0)
        return <>
          <List ref={itemsParentRef} id={menuProps.id} role="listbox" aria-label="Results"/>
          {projects.isPending && !trimmed ? <SkeletonRows/> : <Empty query={trimmed} project={project} loading={loading}/>}
          {status}
        </>;
      let index = 0;
      return <><List ref={itemsParentRef} id={menuProps.id} role="listbox" aria-label="Results">
        {sections.map(section => <div role="group" key={section.id} aria-labelledby={`${menuProps.id}-${section.id}`}>
          <SectionTitle id={`${menuProps.id}-${section.id}`} role="presentation">
            {section.title}
            {section.id === 'branches' && <span> in {project}</span>}
          </SectionTitle>
          {section.items.map(item => renderItem(item, index++))}
        </div>)}
      </List>{status}</>;
    }}
  />;
};

const keep_all = (query, items) => items;


// ---------------------------------------------------------------- rows
const Highlighted = ({ text, positions }) => highlight_parts(text, positions)
  .map((part, i) => part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>);

const relative = date => date ? DateTime.fromISO(date, { zone: 'utc' }).toRelative({ style: 'short' }) : null;

// What a batch's runs are doing: running, failed, or done
const BatchState = ({ batch }) => {
  const total = (batch.valid_outputs ?? 0) + (batch.failed_outputs ?? 0) + (batch.pending_outputs ?? 0);
  if (batch.pending_outputs > 0)
    return <span className="qa-palette-state" title={`${batch.running_outputs ?? 0} running`}><Icon icon="refresh" size={12}/>{total - batch.pending_outputs}/{total}</span>;
  if (batch.failed_outputs > 0)
    return <span className="qa-palette-state qa-danger"><Icon icon="error" size={12}/>{batch.failed_outputs} failed</span>;
  if (batch.valid_outputs > 0)
    return <span className="qa-palette-state qa-success"><Icon icon="tick-circle" size={12}/>{batch.valid_outputs}</span>;
  return null;
};

const RowContent = ({ item }) => {
  const title = <span className="qa-palette-title"><Highlighted text={item.title} positions={item.positions}/></span>;
  switch (item.section) {
    case 'projects': {
      const slash = item.title.lastIndexOf('/');
      return <>
        <ProjectAvatar project={item.project} data={item.details?.data} size="20px"/>
        <span className="qa-palette-text">
          <span className="qa-palette-title">
            {/* subprojects: their name, after their parent's path */}
            <span className="qa-palette-parent"><Highlighted text={item.title.slice(0, slash + 1)} positions={item.positions}/></span>
            <Highlighted text={item.title.slice(slash + 1)} positions={item.positions.map(p => p - slash - 1)}/>
          </span>
          {item.pinned && <Icon icon="star" size={11} className="qa-palette-star" title="Pinned"/>}
        </span>
      </>;
    }
    case 'batches': {
      const { batch } = item;
      const origin = origins[batch.origin] ?? origins.ci;
      return <>
        <Icon icon={origin.icon} title={origin.title} className="qa-palette-icon"/>
        <span className="qa-palette-text">
          {title}
          <span className="qa-palette-subtitle">{batch.project}{batch.commit?.branch && <> · {batch.commit.branch}</>}</span>
        </span>
        <span className="qa-palette-meta"><BatchState batch={batch}/><span>{relative(batch.latest_output_datetime)}</span></span>
      </>;
    }
    case 'branches':
      return <><Icon icon="git-branch" className="qa-palette-icon"/><span className="qa-palette-text">{title}</span></>;
    case 'commits': {
      const { commit } = item;
      return <>
        <Icon icon="git-commit" className="qa-palette-icon"/>
        <span className="qa-palette-text">
          <span className="qa-palette-title">Go to commit <code><Highlighted text={item.title} positions={item.positions}/></code></span>
          <span className="qa-palette-subtitle">{(commit.message ?? '').split('\n')[0]}</span>
        </span>
        {commit.branch && <span className="qa-palette-meta"><Icon icon="git-branch" size={12}/>{commit.branch.replace(/^origin\//, '')}</span>}
      </>;
    }
    default:
      return <>
        <Icon icon={item.icon} className="qa-palette-icon"/>
        <span className="qa-palette-text">
          {title}
          {item.subtitle && <span className="qa-palette-subtitle">{item.subtitle}</span>}
        </span>
        {(item.href || item.shortcut) && <span className="qa-palette-meta">
          {item.href && <Icon icon="share" size={12} title="Opens in a new tab"/>}
          {item.shortcut && <kbd className={Classes.KEY}>{item.shortcut}</kbd>}
        </span>}
      </>;
  }
};

const Row = ({ item, handleClick, handleFocus, modifiers, id, ref }) => {
  // links: middle-click and Ctrl/⌘+click open new tabs as usual
  const Tag = item.url || item.href ? 'a' : 'div';
  return <RowElement
    as={Tag}
    ref={ref}
    id={id}
    role="option"
    aria-selected={modifiers.active}
    className={modifiers.active ? 'qa-active' : undefined}
    href={item.url ?? item.href}
    tabIndex={-1}
    // the focus stays in the search box
    onMouseDown={event => event.preventDefault()}
    onClick={event => {
      if (event.button !== 0 || ((event.metaKey || event.ctrlKey) && Tag === 'a')) return;
      event.preventDefault();
      handleClick(event);
    }}
    // not on hover: when the list scrolls under a still mouse with the arrow keys, the active item stays
    onMouseMove={modifiers.active ? undefined : handleFocus}
  >
    <RowContent item={item}/>
    {modifiers.active && <span className="qa-palette-enter" aria-hidden="true">↵</span>}
  </RowElement>;
};

const SkeletonRows = () => <div aria-busy="true" aria-label="Loading projects">
  <SectionTitle><span className={Classes.SKELETON}>Projects</span></SectionTitle>
  {[60, 45, 70].map(width => <RowElement as="div" key={width}>
    <span className={Classes.SKELETON} style={{ width: 20, height: 20, borderRadius: '50%' }}/>
    <span className={Classes.SKELETON} style={{ width: `${width}%`, height: 14 }}/>
  </RowElement>)}
</div>;

const Empty = ({ query, project, loading }) => <EmptyState aria-hidden="true">
  {loading
    ? <span>Searching…</span>
    : <>
      <Icon icon="search" size={20}/>
      <strong>No results for “{query}”</strong>
      <span>{project
        ? 'Search projects by their path, the branches of this project by name, its commits by the start of their hash, and pages like Settings.'
        : 'Search projects by their path, your recent batches, and pages like Settings. On a project page, also its branches and commits.'}</span>
    </>}
</EmptyState>;


// ---------------------------------------------------------------- the trigger
// For the navbars: a small "Search… Ctrl K" button, only the icon on narrow screens
// `fill`: as wide as its container, like in the sidebar
export const PaletteButton = ({ dark = false, compact = false, fill = false, className }) => {
  const { open } = useCommandPalette();
  return <Tooltip content={<span>Search projects, branches, commits and pages <kbd className={Classes.KEY}>{shortcut_label}</kbd></span>} hoverOpenDelay={500}>
    <TriggerButton
      variant={dark ? 'minimal' : undefined}
      size="small"
      icon="search"
      onClick={() => open('button')}
      aria-label="Search"
      fill={fill && !compact}
      alignText={fill ? 'left' : undefined}
      aria-keyshortcuts={is_mac ? 'Meta+K /' : 'Control+K /'}
      className={`${className ?? ''}${compact ? ' qa-compact' : ''}${dark ? ' qa-dark' : ''}`}
      endIcon={<kbd className={Classes.KEY}>{shortcut_label}</kbd>}
    >
      <span className="qa-trigger-text">Search…</span>
    </TriggerButton>
  </Tooltip>;
};


// ---------------------------------------------------------------- styles
const visually_hidden = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', margin: -1, padding: 0, border: 0 };

const PaletteDialog = styled(Dialog)`
  && {
    width: 640px;
    max-width: calc(100vw - 24px);
    /* at the top: the box stays in place while results change below it */
    align-self: flex-start;
    margin: min(12vh, 120px) 0 24px;
    padding: 0;
    overflow: hidden;
    background: var(--qa-surface);
    color: var(--qa-text);
    border-radius: 10px;
    box-shadow: 0 0 0 1px var(--qa-border), 0 16px 48px -8px rgba(0, 0, 0, 0.35);
  }
  /* a quick fade instead of Blueprint's dialogs' zoom */
  .${Classes.DIALOG_CONTAINER}.${Classes.OVERLAY}-enter > &&, .${Classes.DIALOG_CONTAINER}.${Classes.OVERLAY}-appear > && {
    opacity: 0;
    transform: translateY(-4px) scale(0.99);
  }
  .${Classes.DIALOG_CONTAINER}.${Classes.OVERLAY}-enter-active > &&, .${Classes.DIALOG_CONTAINER}.${Classes.OVERLAY}-appear-active > && {
    opacity: 1;
    transform: none;
    transition: opacity 120ms ease-out, transform 120ms ease-out;
  }
  .${Classes.DIALOG_CONTAINER}.${Classes.OVERLAY}-exit-active > && {
    opacity: 0;
    transition: opacity 80ms ease-in;
  }
  @media (max-width: 640px) {
    && { margin-top: 8px; }
  }
`;

const SearchBox = styled.div`
  border-bottom: 1px solid var(--qa-border);
  .${Classes.INPUT_GROUP} .${Classes.INPUT} {
    height: 52px;
    padding-left: 44px !important;
    font-size: 16px;
    background: transparent;
    box-shadow: none;
    border-radius: 0;
    color: var(--qa-text);
  }
  .${Classes.INPUT_GROUP} > .${Classes.ICON} {
    margin: 18px 0 0 16px;
    color: var(--qa-text-muted);
  }
  .qa-palette-input-right {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 52px;
    padding-right: 14px;
    color: var(--qa-text-muted);
  }
  .qa-palette-spinner { display: inline-flex; width: 14px; }
`;

const List = styled.div`
  max-height: min(440px, calc(100vh - min(12vh, 120px) - 140px));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 6px 6px;
  scrollbar-width: thin;
`;

const SectionTitle = styled.div`
  padding: 10px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--qa-text-muted);
  user-select: none;
  span {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
`;

const RowElement = styled.a`
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  line-height: 20px;
  /* rows are links: not colored like them (Blueprint's dark theme colors links with more specificity) */
  &&, &&:hover { color: var(--qa-text); text-decoration: none; }
  &.qa-active {
    background: color-mix(in srgb, var(--qa-intent-primary) 12%, transparent);
  }
  .qa-palette-icon { color: var(--qa-text-muted); flex: 0 0 auto; }
  &.qa-active .qa-palette-icon { color: var(--qa-intent-primary); }
  .qa-palette-text {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
    overflow: hidden;
    white-space: nowrap;
  }
  .qa-palette-title {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qa-palette-parent { color: var(--qa-text-muted); }
  .qa-palette-subtitle {
    flex: 0 10 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    color: var(--qa-text-muted);
  }
  .qa-palette-star { color: #d1980b; align-self: center; flex: 0 0 auto; }
  mark {
    background: none;
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--qa-intent-primary) 70%, transparent);
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
  }
  code { font-size: 13px; }
  .qa-palette-meta {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--qa-text-muted);
    font-variant-numeric: tabular-nums;
  }
  .qa-palette-state { display: inline-flex; align-items: center; gap: 4px; }
  .qa-success { color: #238551; }
  .qa-danger { color: #cd4246; }
  .${Classes.DARK} & .qa-success { color: #72ca9b; }
  .${Classes.DARK} & .qa-danger { color: #fa999c; }
  .qa-palette-enter {
    flex: 0 0 auto;
    width: 14px;
    text-align: center;
    color: var(--qa-text-muted);
    font-size: 13px;
  }
  @media (max-width: 480px) {
    .qa-palette-subtitle { display: none; }
  }
`;

const EmptyState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 24px 30px;
  text-align: center;
  color: var(--qa-text-muted);
  strong { color: var(--qa-text); font-weight: 600; }
  > span { max-width: 420px; font-size: 13px; }
`;

const Footer = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 14px;
  border-top: 1px solid var(--qa-border);
  background: var(--qa-surface-alt);
  font-size: 12px;
  color: var(--qa-text-muted);
  white-space: nowrap;
  .${Classes.KEY} { margin-right: 4px; min-width: 20px; height: 18px; line-height: 18px; padding: 0 4px; font-size: 11px; }
  .qa-palette-scope {
    margin-left: auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* no keyboard hints on phones: only the project we search in */
  @media (max-width: 640px) {
    span:not(.qa-palette-scope) { display: none; }
    &.qa-no-scope { display: none; }
  }
`;

const TriggerButton = styled(Button)`
  && {
    gap: 6px;
    min-width: 0;
    padding: 0 6px 0 8px;
    color: var(--qa-text-muted);
  }
  &&.qa-dark {
    color: rgba(255, 255, 255, 0.72);
    background: rgba(255, 255, 255, 0.06);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
  }
  &&.qa-dark:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.1);
  }
  .qa-trigger-text { margin-right: 10px; }
  &&.${Classes.FILL} { justify-content: flex-start; }
  &&.${Classes.FILL} .${Classes.BUTTON_TEXT} { flex: 1 1 auto; }
  .${Classes.KEY} {
    min-width: 0;
    height: 18px;
    line-height: 18px;
    padding: 0 5px;
    font-size: 11px;
    background: transparent;
    box-shadow: inset 0 0 0 1px currentColor;
    opacity: 0.7;
    color: inherit;
  }
  /* only the icon on phones, or where there's no room */
  &&.qa-compact .qa-trigger-text, &&.qa-compact .${Classes.KEY} { display: none; }
  &&&.qa-compact { padding: 0 7px; }
  @media (max-width: 640px) {
    &&& { padding: 0 7px; }
    .qa-trigger-text, .${Classes.KEY} { display: none; }
  }
`;
