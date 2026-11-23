// Saving inputs as a new collection, or adding them to a collection (as its next version).
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import styled from "styled-components";
import {
  Button, Callout, Classes, Dialog, DialogBody, DialogFooter, FormGroup, Icon, InputGroup, Intent, Menu, MenuItem,
  NonIdealState, TextArea,
} from "@blueprintjs/core";

import { history } from "../router";
import { errorMessage, http } from "../api/http";
import { toaster } from "../toaster";
import { match_query } from "../utils";
import {
  normalize_name, name_problem, pretty_name, collection_path, collection_ref, fetchMemberIds, next_members, is_conflict,
  collection_search_text, input_name, conflict_data,
} from "./api";
import { useCollections, useCollectionActions } from "./hooks";
import { Thumbnail } from "./InputGrid";


const Strip = styled.div`
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 16px;
  .qa-strip-thumb {
    width: 56px;
    height: 42px;
    flex: none;
    border-radius: 3px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(143, 153, 168, 0.15);
    font-size: 10px;
  }
  .qa-strip-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .qa-strip-thumb .qa-input-placeholder {
    font-size: 0;
  }
`;

// The first inputs, and how many
export const InputsStrip = ({ inputs, count }) => {
  const shown = inputs.slice(0, 6);
  return <Strip aria-label={`${count} input${count === 1 ? '' : 's'}`}>
    {shown.map(input => <span key={input.id} className="qa-strip-thumb" title={input.path}><Thumbnail input={input} alt={input_name(input)}/></span>)}
    <span className={Classes.TEXT_MUTED} style={{ marginLeft: 4 }}>
      <strong style={{ color: 'var(--qa-text, inherit)' }}>{count.toLocaleString()}</strong> input{count === 1 ? '' : 's'}
      {count > shown.length && shown.length > 0 && <>, {shown.length} shown</>}
    </span>
  </Strip>;
};

const Prefix = styled.span`
  display: inline-flex;
  align-items: center;
  /* the input's height: Blueprint positions the left element at the top */
  height: 30px;
  padding: 0 1px 0 10px;
  font-family: var(--qa-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 13px;
  white-space: nowrap;
`;


// `inputs`: [Input], those to save. `onSaved(collection)`
export const SaveCollectionDialog = ({ project, inputs, isOpen, onClose, onSaved }) => {
  const id = useId();
  const actions = useCollectionActions(project);
  const { list, refetch } = useCollections(project);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [existing, setExisting] = useState(null);
  const [error, setError] = useState(null);
  const problem = name_problem(name);
  const normalized = normalize_name(name);
  const count = inputs.length;

  const save = async event => {
    event.preventDefault();
    setTouched(true);
    if (problem || saving) return;
    setSaving(true);
    setError(null);
    setExisting(null);
    try {
      const saved = await actions.create({ name: normalized, description, inputs: inputs.map(i => i.id) });
      toaster.show({
        message: <>Saved <strong>{pretty_name(saved?.name ?? normalized)}</strong> with {count.toLocaleString()} input{count === 1 ? '' : 's'}</>,
        intent: Intent.SUCCESS, icon: 'folder-close', timeout: 6000,
        action: saved?.id ? { text: 'Open', onClick: () => history.push(collection_path(project, saved)) } : undefined,
      });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      if (is_conflict(err)) {
        // which one: the server says its id, the list may not know it yet
        const existing_id = conflict_data(err)?.id;
        const fresh = (await refetch().catch(() => null))?.data?.collections ?? list;
        const found = fresh.find(c => (existing_id !== undefined && c.id === existing_id) || (normalize_name(c.name) === normalized && !c.inherited));
        setExisting(found ?? (existing_id !== undefined ? { id: existing_id, name: normalized, latest_version: null } : { name: normalized }));
      } else {
        setError(err);
      }
    } finally {
      setSaving(false);
    }
  };

  const add_to_existing = async () => {
    setSaving(true);
    try {
      await addInputs({ actions, project, collection: existing, ids: inputs.map(i => i.id) });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return <Dialog isOpen={isOpen} onClose={onClose} title="Save as a collection" icon="folder-new" style={{ width: 560, maxWidth: 'calc(100vw - 32px)' }}>
    <form onSubmit={save}>
      <DialogBody>
        <InputsStrip inputs={inputs} count={count}/>
        <FormGroup
          label="Collection name"
          labelFor={`${id}-name`}
          intent={touched && problem ? Intent.DANGER : undefined}
          helperText={touched && problem ? problem : <>Belongs to <strong>{project}</strong> and its subprojects. Use “/” for groups, e.g. <code>night/hard-cases</code>.</>}
        >
          <InputGroup
            id={`${id}-name`}
            className={Classes.MONOSPACE_TEXT}
            leftElement={<Prefix className={Classes.TEXT_MUTED} title={`The project: elsewhere, it's ${project}:${normalized || 'name'}`}>{project}:</Prefix>}
            value={name}
            onChange={e => { setName(e.target.value); setExisting(null); }}
            onBlur={() => setTouched(!!name)}
            placeholder="night/hard-cases"
            intent={touched && problem ? Intent.DANGER : undefined}
            autoFocus
            maxLength={250}
          />
        </FormGroup>
        <FormGroup label="Description" labelFor={`${id}-description`} labelInfo="(optional)" helperText="What the inputs have in common, what the collection is for.">
          <TextArea id={`${id}-description`} fill rows={3} value={description} onChange={e => setDescription(e.target.value)} maxLength={20000}/>
        </FormGroup>
        {!!existing && <Callout intent={Intent.WARNING} icon="duplicate" title={`${pretty_name(existing.name)} already exists`}>
          <p>Pick another name, or use the existing collection.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {existing.id && <Button icon="folder-open" text="Open it" onClick={() => { onClose(); history.push(collection_path(project, existing)); }}/>}
            {existing.id && <Button icon="add" intent={Intent.PRIMARY} text={`Add the ${count.toLocaleString()} input${count === 1 ? '' : 's'} to it`} loading={saving} onClick={add_to_existing}/>}
          </div>
        </Callout>}
        {!!error && <Callout intent={Intent.DANGER} icon="error">{errorMessage(error)}</Callout>}
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Cancel" onClick={onClose} style={{ whiteSpace: 'nowrap' }}/>
        <Button type="submit" intent={Intent.PRIMARY} icon="floppy-disk" text="Save collection" loading={saving} disabled={count === 0} style={{ whiteSpace: 'nowrap' }}/>
      </>}>
        <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>Saved as version 1: changes make new versions, older ones never change.</span>
      </DialogFooter>
    </form>
  </Dialog>;
};


// Adds inputs to a collection: its next version has its latest inputs, then these. Answers the saved collection.
// A 409 (someone saved meanwhile) is retried once on top of the new latest version: adding doesn't depend on what's there.
export const addInputs = async ({ actions, project, collection, ids, notes }) => {
  const attempt = async base_version => {
    const members = await fetchMemberIds(collection.id, base_version, { project });
    const inputs = next_members(members, { added: ids });
    const added = inputs.length - members.length;
    if (added === 0) {
      toaster.show({ message: `All these inputs are already in ${pretty_name(collection.name)}`, intent: Intent.PRIMARY, icon: 'info-sign', timeout: 4000 });
      return collection;
    }
    const saved = await actions.save(collection, { inputs, base_version, notes: notes || `Added ${added} input${added === 1 ? '' : 's'}` });
    toaster.show({
      message: <>Added {added.toLocaleString()} input{added === 1 ? '' : 's'} to <strong>{pretty_name(collection.name)}</strong>: version {saved?.latest_version ?? base_version + 1}</>,
      intent: Intent.SUCCESS, icon: 'folder-close', timeout: 6000,
      action: { text: 'Open', onClick: () => history.push(collection_path(project, collection)) },
    });
    return saved;
  };
  let latest = collection.latest_version;
  if (!latest) latest = (await http.get(`/api/v1/collections/${collection.id}`, { params: { project } })).data.latest_version;
  try {
    return await attempt(latest);
  } catch (error) {
    if (!is_conflict(error)) throw error;
    return attempt(conflict_data(error).latest_version ?? (await http.get(`/api/v1/collections/${collection.id}`, { params: { project } })).data.latest_version);
  }
};


// Picks a collection, then adds the inputs to it
export const AddToCollectionDialog = ({ project, inputs, isOpen, onClose, initial }) => {
  const id = useId();
  const actions = useCollectionActions(project);
  const { list, isPending, error: list_error } = useCollections(project);
  const [search, setSearch] = useState('');
  const [picked_id, setPicked] = useState(initial ?? null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const count = inputs.length;
  const matcher = match_query(search);
  // collections of ancestor projects can be written only by their own developers: the server says
  const candidates = list.filter(c => !c.archived && matcher(collection_search_text(c)))
    .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name));
  const picked = list.find(c => c.id === picked_id);
  const members = useQuery({
    queryKey: ['collection-member-ids', picked?.id, picked?.latest_version],
    queryFn: () => fetchMemberIds(picked.id, picked.latest_version, { project }),
    enabled: !!picked,
    staleTime: 60 * 1000,
  });
  const already = members.data ? new Set(members.data) : null;
  const new_count = already ? inputs.filter(i => !already.has(i.id)).length : null;

  const add = async event => {
    event.preventDefault();
    if (!picked) return;
    setSaving(true);
    setError(null);
    try {
      await addInputs({ actions, project, collection: picked, ids: inputs.map(i => i.id), notes });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return <Dialog isOpen={isOpen} onClose={onClose} title="Add to a collection" icon="add-to-folder" style={{ width: 560, maxWidth: 'calc(100vw - 32px)' }}>
    <form onSubmit={add}>
      <DialogBody>
        <InputsStrip inputs={inputs} count={count}/>
        <FormGroup label="Collection" labelFor={`${id}-search`}>
          <InputGroup
            id={`${id}-search`}
            leftIcon="search"
            placeholder={`Search ${list.length} collection${list.length === 1 ? '' : 's'}`}
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
            aria-controls={`${id}-list`}
          />
        </FormGroup>
        <div style={{ maxHeight: 240, overflowY: 'auto', marginTop: -8, marginBottom: 16, border: '1px solid rgba(143, 153, 168, 0.3)', borderRadius: 3 }}>
          {isPending && <Menu><MenuItem disabled text={<span className={Classes.SKELETON}>Loading the collections</span>}/></Menu>}
          {list_error && <Callout intent={Intent.DANGER}>Could not load the collections: {errorMessage(list_error)}</Callout>}
          {!isPending && !list_error && candidates.length === 0 && <NonIdealState icon="folder-close" description={list.length === 0 ? 'No collections yet: save these inputs as a new one.' : <>No collection matches “{search}”</>} layout="horizontal"/>}
          {candidates.length > 0 && <Menu id={`${id}-list`} role="listbox" aria-label="Collections">
            {candidates.map(c => <MenuItem
              key={c.id}
              roleStructure="listoption"
              selected={c.id === picked_id}
              icon={c.favorite ? <Icon icon="heart" color="#cd4246"/> : 'folder-close'}
              text={<span className={Classes.MONOSPACE_TEXT}>{collection_ref(c)}</span>}
              label={`@${c.latest_version} · ${c.size ?? '?'} inputs`}
              onClick={() => setPicked(c.id)}
              shouldDismissPopover={false}
            />)}
          </Menu>}
        </div>
        {!!picked && <FormGroup label="Notes for the new version" labelFor={`${id}-notes`} labelInfo="(optional)">
          <TextArea id={`${id}-notes`} fill rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder={`Added ${count} input${count === 1 ? '' : 's'}`} maxLength={20000}/>
        </FormGroup>}
        {!!picked && <p className={Classes.TEXT_MUTED} aria-live="polite">
          Saves <strong>{pretty_name(picked.name)}@{picked.latest_version + 1}</strong>: its {picked.size ?? ''} inputs
          {new_count === null ? ', then these.' : new_count === count ? `, then these ${count}.` : `, then ${new_count} of these: ${count - new_count} are already in it.`}
          {' '}@{picked.latest_version} doesn't change.
        </p>}
        {!!error && <Callout intent={Intent.DANGER} icon="error">{errorMessage(error)}</Callout>}
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Cancel" onClick={onClose}/>
        <Button type="submit" intent={Intent.PRIMARY} icon="add" text={picked ? `Save version ${picked.latest_version + 1}` : 'Add'} disabled={!picked || new_count === 0} loading={saving}/>
      </>}/>
    </form>
  </Dialog>;
};
