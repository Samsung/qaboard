// Run Tests / Tuning: which tests to run. Lists the batches people can run on the commit, next to the tests the
// chosen ones give, and edits QA-Board's batch files (Available Tests) without leaving the form.
import { lazy, Suspense, useMemo, useState } from "react";
import styled from "styled-components";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { stringify } from "yaml";
import { Button, Checkbox, Classes, Drawer, Icon, InputGroup, Intent, NonIdealState, Spinner, Tag, Tooltip } from "@blueprintjs/core";

import { http, errorMessage } from "../../api/http";
import { toaster } from "../../toaster";
import { BatchDefinitions, BatchWarnings } from "./BatchReport";
import { openInAvailableTests } from "./availableTests";

// Monaco and the YAML checks: only when people edit batches
const BatchesEditor = lazy(() => import("./BatchesEditor").then(module => ({ default: module.BatchesEditor })));


/** "ci, night-*" => ["ci", "night-*"]: the batches to run are remembered as text, like people would type them */
export const parse_selection = text => String(text ?? '').split(',').map(name => name.trim()).filter(Boolean);
export const format_selection = names => names.join(', ');

const MAX_TESTS_SHOWN = 300;

const Layout = styled.div`
  display: grid;
  grid-template-columns: minmax(260px, 2fr) minmax(0, 3fr);
  border: 1px solid var(--qa-border);
  border-radius: 6px;
  margin-bottom: 10px;
  @media (max-width: 900px) { grid-template-columns: minmax(0, 1fr); }
  .qa-batches-pane { min-width: 0; display: flex; flex-direction: column; }
  .qa-batches-pane + .qa-batches-pane { border-left: 1px solid var(--qa-border); }
  @media (max-width: 900px) { .qa-batches-pane + .qa-batches-pane { border-left: none; border-top: 1px solid var(--qa-border); } }
  .qa-batches-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--qa-border); min-height: 47px; }
  .qa-batches-list { height: 264px; overflow-y: auto; padding: 4px 0; }
  .qa-batches-group { padding: 8px 12px 2px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .qa-batches-row { display: flex; align-items: center; gap: 8px; padding: 3px 12px; min-height: 28px; }
  .qa-batches-row:hover { background: var(--qa-hover); }
  .qa-batches-row[data-selected="true"] { background: color-mix(in srgb, var(--qa-intent-primary) 10%, transparent); }
  .qa-batches-row .bp6-control { margin: 0; flex: 1; min-width: 0; }
  .qa-batches-name { font-family: var(--bp-font-family-monospace, monospace); font-size: 13px; overflow-wrap: anywhere; }
  .qa-batches-meta { flex: none; font-size: 12px; white-space: nowrap; }
  .qa-batches-row .qa-batches-actions { flex: none; visibility: hidden; }
  .qa-batches-row:hover .qa-batches-actions, .qa-batches-row:focus-within .qa-batches-actions { visibility: visible; }
  .qa-batches-test { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: baseline; padding: 3px 12px; font-size: 13px; }
  .qa-batches-test:nth-child(even) { background: color-mix(in srgb, var(--qa-hover) 50%, transparent); }
  .qa-batches-input { overflow-wrap: anywhere; margin-right: 4px; }
  .qa-batches-empty { padding: 20px 16px; }
`;

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

// The batches people can run on the commit: {batches, files, warnings}
export const useBatches = ({ project, commit_id, files, enabled }) => useQuery({
  queryKey: ['tests-batches', project, commit_id ?? null, files],
  queryFn: async ({ signal }) => (await http.post('/api/v1/tests/batches', { groups: files }, { params: { project, commit: commit_id }, signal, background: true })).data,
  enabled,
  placeholderData: keepPreviousData,
  staleTime: 60 * 1000,
});

// "This commit", "Shared", "Yours", "Groups": where a batch comes from says who can change it
const sections = [
  { id: 'user', title: 'Yours', help: 'Your own batches: only you see them.' },
  { id: 'shared', title: 'Shared', help: "The project's shared batches: everyone can edit them here." },
  { id: 'commit', title: "From the code", help: "Defined in the repository, in the files listed by qaboard.yaml's inputs.batches." },
  { id: 'alias', title: 'Groups of batches', help: 'Names that stand for several batches (aliases).' },
  { id: 'other', title: 'Others', help: 'Patterns like night-*, or names QA-Board does not find in the batch files.' },
];
const section_of = (batch, { shared, user }) => {
  if (batch.kind === 'alias') return 'alias';
  const file = batch.files?.at(-1);
  if (batch.sources?.at(-1) === 'commit') return 'commit';
  if (user && file === `${user}.yml`) return 'user';
  if (shared && file === `${shared}.yml`) return 'shared';
  return 'shared';
};
const describe = batch => batch.kind === 'alias'
  ? plural(batch.batches?.length ?? 0, 'batch', 'batches')
  : [
      batch.inputs !== undefined && plural(batch.inputs, 'input'),
      batch.configurations > 1 && `${batch.configurations} configs`,
    ].filter(Boolean).join(' · ');

const format_configuration = c => typeof c === 'string' ? c : JSON.stringify(c);


/**
 * Chooses the batches to run, and shows their tests.
 * `value`: the chosen names, as text ("ci, night-*"). `tests`: what the server lists for them, {group_info, loading, error}.
 */
// `changed`: the names of the batches changed for this run (sent with the request, see BatchesForThisRun.jsx), and
// `onChangeForThisRun` opens their editor.
export const BatchPicker = ({ project, commit, value, onChange, tests, available_tests_files, repo_file_url, is_logged, editor_props, missing = false, changed = [], onChangeForThisRun }) => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [tests_filter, setTestsFilter] = useState('');
  // the selection when the editor opened: "Run this batch" in the editor chooses a batch, and comes back here
  const [editing, setEditing] = useState(null);
  const [copying, setCopying] = useState(null);
  const shared = available_tests_files?.gr;
  const user = available_tests_files?.usr;
  const files = useMemo(() => Object.values(available_tests_files ?? {}).filter(Boolean), [available_tests_files]);
  const { data, isFetching, error: list_error } = useBatches({ project, commit_id: commit?.id, files, enabled: is_logged });
  const batches = useMemo(() => Array.isArray(data?.batches) ? data.batches : [], [data]);
  const selected = useMemo(() => parse_selection(value), [value]);
  const { group_info, loading, error } = tests;
  const listed = group_info.tests ?? [];

  if (editing !== null && editing !== value) setEditing(null);
  const is_editing = editing !== null;
  // the editor may have changed the batches
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['tests-batches', project] });
    queryClient.invalidateQueries({ queryKey: ['tests-group', project] });
  };

  const toggle = name => onChange(format_selection(selected.includes(name) ? selected.filter(n => n !== name) : [...selected, name]));
  const edit = request => {
    if (request) openInAvailableTests({ ...request, navigate: false });
    setEditing(value);
  };

  // A copy of a batch in the user's own file, to change what runs without touching the original
  const copy = async batch => {
    setCopying(batch.name);
    try {
      const { hasUnsavedDraft } = await import("./BatchesEditor");
      if (hasUnsavedDraft(project, user)) {
        toaster.show({ message: 'Your batches have unsaved changes: save or discard them first.', intent: Intent.WARNING, icon: 'warning-sign' });
        edit({ file: user });
        return;
      }
      const { data: described } = await http.post('/api/v1/tests/batches', { groups: files }, { params: { project, commit: commit?.id, definition: batch.name } });
      if (!described?.definition) throw new Error(`QA-Board could not read the definition of ${batch.name}`);
      const names = new Set((described.batches ?? []).map(b => b.name));
      let name = `${batch.name}-copy`;
      for (let i = 2; names.has(name); i++) name = `${batch.name}-copy-${i}`;
      const text = String((await http.get('/api/v1/tests/groups', { params: { project, name: user }, responseType: 'text' })).data ?? '');
      const separator = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
      const content = `${text}${separator}# A copy of ${batch.name}\n${stringify({ [name]: described.definition }, { lineWidth: 0 })}`;
      await http.post('/api/v1/tests/groups', { project, groups: content }, { params: { project, name: user } });
      await queryClient.invalidateQueries({ queryKey: ['tests-batches', project] });
      const next = format_selection(selected.includes(batch.name) ? selected.map(n => n === batch.name ? name : n) : [...selected, name]);
      onChange(next);
      openInAvailableTests({ file: user, batch: name, navigate: false });
      setEditing(next);
      toaster.show({ message: `Copied ${batch.name} to your batches as ${name}: edit it, save, and close to come back.`, intent: Intent.SUCCESS, icon: 'duplicate' });
    } catch (e) {
      toaster.show({ message: `Could not copy ${batch.name}: ${errorMessage(e)}`, intent: Intent.DANGER });
    } finally {
      setCopying(null);
    }
  };

  const query = search.trim().toLowerCase();
  const known = new Set([...batches.map(b => b.name), ...changed]);
  // patterns, and names the files don't define
  const others = selected.filter(name => !batches.some(b => b.name === name)).map(name => ({ name, kind: changed.includes(name) ? 'changed' : 'other' }));
  const visible = [...batches, ...others].filter(b => !query || b.name.toLowerCase().includes(query));
  const grouped = sections
    .map(section => ({ ...section, batches: visible.filter(b => (b.kind === 'other' || b.kind === 'changed' ? 'other' : section_of(b, { shared, user })) === section.id) }))
    .filter(section => section.batches.length > 0);
  const typed = search.trim();
  const can_add_typed = typed && !typed.includes(',') && !known.has(typed) && !selected.includes(typed);
  const onSearchKey = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const exact = visible.find(b => b.name === typed) ?? (visible.length === 1 ? visible[0] : null);
    if (exact) toggle(exact.name);
    else if (can_add_typed) toggle(typed);
    else return;
    setSearch('');
  };

  const filter = tests_filter.trim().toLowerCase();
  const filtered = filter
    ? listed.filter(t => String(t.input_path).toLowerCase().includes(filter) || (t.configurations ?? []).some(c => format_configuration(c).toLowerCase().includes(filter)))
    : listed;
  const files_context = { shared, user, repoFileUrl: repo_file_url, onOpen: edit };

  return <div data-testid="batch-picker">
    <Layout>
      <div className="qa-batches-pane">
        <div className="qa-batches-head">
          <InputGroup
            fill
            leftIcon="search"
            aria-label="Find a batch, or type a name"
            placeholder={batches.length > 0 ? `Find among ${plural(batches.length, 'batch', 'batches')}, or type a pattern` : 'Type a batch name, or a pattern like night-*'}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={onSearchKey}
            intent={missing ? Intent.DANGER : undefined}
            rightElement={isFetching ? <Spinner size={14} style={{ margin: 8 }} aria-label="Listing the batches"/> : undefined}
          />
        </div>
        <div className="qa-batches-list" role="group" aria-label="Batches to run">
          {grouped.map(section => <div key={section.id}>
            <Tooltip content={section.help} placement="top-start" hoverOpenDelay={400} compact>
              <div className={`qa-batches-group ${Classes.TEXT_MUTED}`}>{section.title}</div>
            </Tooltip>
            {section.batches.map(batch => {
              const checked = selected.includes(batch.name);
              const editable = batch.kind === 'batch' && batch.sources?.at(-1) === 'qaboard';
              return <div className="qa-batches-row" key={`${batch.kind}:${batch.name}`} data-selected={checked} data-testid={`batch-${batch.name}`}>
                <Checkbox
                  checked={checked}
                  onChange={() => toggle(batch.name)}
                  labelElement={<span className="qa-batches-name">{batch.name}</span>}
                />
                {batch.kind === 'alias'
                  ? <Tooltip content={<div style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>{(batch.batches ?? []).join(', ')}</div>} hoverOpenDelay={200} compact>
                      <span className={`qa-batches-meta ${Classes.TEXT_MUTED}`} style={{ borderBottom: '1px dotted currentColor', cursor: 'help' }}>{describe(batch)}</span>
                    </Tooltip>
                  : <span
                      className={`qa-batches-meta ${Classes.TEXT_MUTED}`}
                      title={batch.kind === 'batch' && batch.inputs !== undefined ? 'As listed in the batch file: a folder or a glob counts once, and may hold many inputs. Tick the batch to see its tests.' : undefined}
                    >{batch.kind === 'other' ? (/[*?[]/.test(batch.name) ? 'pattern' : data ? 'not in the batch files' : '') : describe(batch)}</span>}
                {changed.includes(batch.name) && <Tag minimal round intent={Intent.WARNING} icon="edit">for this run</Tag>}
                {batch.kind === 'batch' && user && <span className="qa-batches-actions">
                  {editable
                    ? <Tooltip content="Edit this batch" compact hoverOpenDelay={300}>
                        <Button variant="minimal" size="small" icon="edit" aria-label={`Edit ${batch.name}`} onClick={() => edit({ file: batch.files.at(-1).replace(/\.yml$/, ''), batch: batch.name })}/>
                      </Tooltip>
                    : <Tooltip content="It's defined in the code. Copy it to your batches to change its inputs or configurations" compact hoverOpenDelay={300}>
                        <Button variant="minimal" size="small" icon="duplicate" aria-label={`Copy ${batch.name} to your batches`} loading={copying === batch.name} onClick={() => copy(batch)}/>
                      </Tooltip>}
                </span>}
              </div>;
            })}
          </div>)}
          {can_add_typed && <div className="qa-batches-row" data-testid="batch-use-typed">
            <Button variant="minimal" size="small" icon="plus" intent={Intent.PRIMARY} onClick={() => { toggle(typed); setSearch(''); }}>
              Use <span className="qa-batches-name">{typed}</span>
            </Button>
            <span className={`qa-batches-meta ${Classes.TEXT_MUTED}`}>{/[*?[]/.test(typed) ? 'every batch it matches' : 'a name the list doesn’t have'}</span>
          </div>}
          {grouped.length === 0 && !can_add_typed && <div className={`qa-batches-empty ${Classes.TEXT_MUTED}`}>
            {!is_logged ? 'Sign in to list the batches.'
              : list_error ? `Could not list the batches: ${errorMessage(list_error)}. You can still type a name.`
              : isFetching ? 'Listing the batches…'
              : 'No batch is defined yet. Create one: a batch is a list of inputs, and the configurations to run them with.'}
          </div>}
        </div>
        <div className="qa-batches-head" style={{ borderBottom: 'none', borderTop: '1px solid var(--qa-border)', minHeight: 0, flexWrap: 'wrap', gap: '2px 4px' }}>
          <Button variant="minimal" size="small" icon="edit" text="Edit batches" disabled={!is_logged} onClick={() => edit()} data-testid="batch-edit" style={{ whiteSpace: "nowrap" }}/>
          {onChangeForThisRun && selected.length > 0 && <Tooltip content="Change the inputs or configurations of the chosen batches for this run only: the batch files stay as they are" hoverOpenDelay={300}>
            <Button variant="minimal" size="small" icon="annotation" text="Change for this run" disabled={!is_logged} onClick={onChangeForThisRun} data-testid="batch-change-for-this-run" style={{ whiteSpace: "nowrap" }}/>
          </Tooltip>}
          <span className={Classes.TEXT_MUTED} style={{ fontSize: 12, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            {selected.length > 0 && <>{plural(selected.length, 'batch', 'batches')} chosen <Button variant="minimal" size="small" text="Clear" onClick={() => onChange('')}/></>}
          </span>
        </div>
      </div>

      <div className="qa-batches-pane" data-testid="batch-tests">
        <div className="qa-batches-head">
          <strong style={{ whiteSpace: 'nowrap' }}>
            {selected.length === 0 ? 'Tests' : loading && listed.length === 0 ? 'Listing the tests…' : plural(listed.length, 'test')}
          </strong>
          {loading && <Spinner size={14} aria-label="Listing the tests"/>}
          {selected.length > 0 && <span className={Classes.TEXT_MUTED} style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={selected.join(', ')}>
            in {selected.map((name, index) => <span key={name}>{index > 0 && ', '}<span className="qa-batches-name" style={{ fontSize: 12 }}>{name}</span></span>)}
          </span>}
          {listed.length > 8 && <div style={{ width: 160, marginLeft: 'auto', flex: 'none' }}>
            <InputGroup small fill leftIcon="filter" aria-label="Filter the tests" placeholder="Filter" value={tests_filter} onChange={e => setTestsFilter(e.target.value)}/>
          </div>}
        </div>
        <div className="qa-batches-list" style={{ height: 302 }}>
          {selected.length === 0
            ? <NonIdealState icon="list-detail-view" title={missing ? 'Choose a batch' : 'Choose what to run'} description="Tick batches on the left: their tests show here before you start." layout="vertical" iconSize={32}/>
            : error ? <div className="qa-batches-empty"><Tag icon="warning-sign" intent={Intent.DANGER} multiline>{error}</Tag></div>
            : listed.length === 0 && !loading ? <div className={`qa-batches-empty ${Classes.TEXT_MUTED}`}>{group_info.unlisted
              ? "QA-Board can't list these tests here: they are found by the project's code when the batch runs. See below."
              : 'No tests: see why below.'}</div>
            : <>
              {filtered.slice(0, MAX_TESTS_SHOWN).map((test, index) => <div className="qa-batches-test" key={index}>
                <span className="qa-batches-input">{test.input_path}</span>
                {(test.configurations ?? []).map((c, c_index) => <Tag key={c_index} minimal round intent={Intent.PRIMARY}>{format_configuration(c)}</Tag>)}
              </div>)}
              {filter && filtered.length === 0 && <div className={`qa-batches-empty ${Classes.TEXT_MUTED}`}>No test matches “{tests_filter.trim()}”.</div>}
              {filtered.length > MAX_TESTS_SHOWN && <div className={`qa-batches-empty ${Classes.TEXT_MUTED}`}>
                <Icon icon="more" size={12}/> and {filtered.length - MAX_TESTS_SHOWN} more: filter to find them.
              </div>}
            </>}
        </div>
      </div>
    </Layout>

    {selected.length > 0 && !loading && <>
      <BatchDefinitions definitions={group_info.definitions} context={files_context} style={{ margin: '0 0 10px' }}/>
      <BatchWarnings warnings={group_info.warnings} title={listed.length === 0 && !group_info.unlisted ? 'Why the batch has no tests' : 'Check the batch files'} style={{ marginBottom: 10 }}/>
    </>}
    {(data?.warnings?.length > 0 && selected.length === 0) && <BatchWarnings warnings={data.warnings} title="Check the batch files" style={{ marginBottom: 10 }}/>}

    <Drawer
      isOpen={is_editing}
      onClose={() => setEditing(null)}
      onClosed={refresh}
      size="min(1500px, 94vw)"
      icon="edit"
      title="Edit batches"
    >
      <div className={Classes.DRAWER_BODY} style={{ padding: 16 }}>
        <p className={Classes.TEXT_MUTED} style={{ marginTop: 0 }}>
          Save your changes, then close this panel to come back to the form: the list of batches and their tests update.
        </p>
        {is_editing && <Suspense fallback={<Spinner size={20} aria-label="Loading the editor"/>}>
          <BatchesEditor project={project} commit={commit} available_tests_files={available_tests_files} {...editor_props}/>
        </Suspense>}
      </div>
    </Drawer>
  </div>;
};

export default BatchPicker;
