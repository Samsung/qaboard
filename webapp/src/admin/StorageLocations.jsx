// Admin → Storage → Storage locations: where projects' uploaded runs go (backend/locations.py,
// website/docs/backend-admin/uploads.mdx#storage-locations). The folders must be inside the storage roots, which only
// the server's environment sets: an admin's session can't point the server at other folders.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Callout, Classes, Dialog, DialogBody, DialogFooter, FormGroup, HTMLTable, InputGroup, Intent, Switch, Tag, TagInput, Tooltip } from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { useSiteConfig } from "../hooks";
import { Loading } from "../settings/states";
import { AdminError } from "./states";
import { docsUrl } from "./settings/SettingRow";
import { storageLocationsQuery, saveStorageLocation, deleteStorageLocation } from "./api";


const DOCS = '/docs/backend-admin/uploads#storage-locations';
const mono = { className: Classes.MONOSPACE_TEXT, style: { overflowWrap: 'anywhere' } };

const Projects = ({ projects }) => projects.length
  ? <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{projects.map(p => <Tag key={p} minimal>{p === '*' ? 'every project' : p}</Tag>)}</span>
  : <span className={Classes.TEXT_MUTED}>None: no new runs go there</span>;

const Status = ({ location }) => <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
  {!location.reachable && <Tooltip content="The server doesn't see this folder: mount the storage there, in the backend, the proxy and the image server.">
    <Tag intent={Intent.DANGER} icon="error">Not mounted</Tag>
  </Tooltip>}
  {location.outside_storage_roots && <Tooltip content="Added before locations had to be inside the storage roots: add its folder to QABOARD_STORAGE_ROOTS.">
    <Tag intent={Intent.WARNING} icon="warning-sign">Outside the storage roots</Tag>
  </Tooltip>}
</span>;


export const StorageLocations = () => {
  const { data, isPending, error, refetch } = useQuery(storageLocationsQuery);
  const { docs_root = '/' } = useSiteConfig();
  const [editing, setEditing] = useState(null);  // {} to add one, a location to change it
  const [removing, setRemoving] = useState(null);
  return <section aria-labelledby="storage-locations-title" style={{ marginBottom: 28 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
      <h4 id="storage-locations-title" className={Classes.HEADING} style={{ margin: 0 }}>Storage locations</h4>
      <a href={docsUrl(docs_root, DOCS)} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 'auto', fontSize: 13 }}>Docs</a>
    </div>
    <p className={Classes.TEXT_MUTED} style={{ margin: '6px 0 12px', maxWidth: 760 }}>
      Where projects' uploaded runs go, e.g. a team's bucket mounted on the server. Changes apply within a minute.
      {data?.storage_roots?.length > 0 && <> Folders must be inside the storage roots, set in the server's environment: <span className={Classes.MONOSPACE_TEXT}>{data.storage_roots.join(':')}</span>.</>}
    </p>
    {isPending ? <Loading label="Loading the storage locations"/>
      : error ? <AdminError error={error} refetch={refetch} what="the storage locations"/>
      : <>
        <div style={{ overflowX: 'auto' }}>
          <HTMLTable compact striped style={{ width: '100%' }} aria-label="Storage locations">
            <thead><tr><th>Runs store</th><th>Folder on the server</th><th>New runs of</th><th>Runs</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {data.locations.map(location => <tr key={location.id}>
                <td {...mono}>{location.url}…</td>
                <td {...mono}>{location.path}</td>
                <td><Projects projects={location.projects}/></td>
                <td>{location.runs}</td>
                <td><Status location={location}/></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <Button small minimal icon="edit" aria-label={`Change ${location.url}`} onClick={() => setEditing(location)}/>
                  <Button small minimal icon="trash" intent={Intent.DANGER} aria-label={`Remove ${location.url}`} onClick={() => setRemoving(location)}/>
                </td>
              </tr>)}
              <tr>
                <td><span className={Classes.TEXT_MUTED}>Paths (default)</span></td>
                <td {...mono}>{data.default ? data.default.path : <span className={Classes.TEXT_MUTED}>None</span>}</td>
                <td><span className={Classes.TEXT_MUTED}>{data.locations.length ? 'The other projects' : 'Every project'}</span></td>
                <td><span className={Classes.TEXT_MUTED}>–</span></td>
                <td>{data.default && !data.default.reachable && <Tag intent={Intent.DANGER} icon="error">Not mounted</Tag>}</td>
                <td><span className={Classes.TEXT_MUTED}>Set in the environment</span></td>
              </tr>
            </tbody>
          </HTMLTable>
        </div>
        {!data.default && <Callout intent={Intent.WARNING} compact style={{ marginTop: 8, maxWidth: 760 }}>
          The projects that no location lists can't upload ({data.default_off_reason}). Set <code>QABOARD_UPLOAD_ROOT</code>, or add a location for every project (<code>*</code>).
        </Callout>}
        <Button icon="add" text="Add a location…" style={{ marginTop: 12 }} onClick={() => setEditing({})}/>
      </>}
    <LocationDialog location={editing} onClose={() => setEditing(null)}/>
    <RemoveAlert location={removing} onClose={() => setRemoving(null)}/>
  </section>;
};


const LocationDialog = ({ location, onClose }) => <Dialog
  isOpen={!!location}
  onClose={() => onClose()}
  title={location?.id != null ? `Change ${location.url}` : "Add a storage location"}
  icon="database"
>
  {/* a new form each time it opens */}
  {location && <LocationForm location={location} onClose={onClose}/>}
</Dialog>;


const LocationForm = ({ location, onClose }) => {
  const queryClient = useQueryClient();
  const create = location.id == null;
  const [url, setUrl] = useState(location.url ?? '');
  const [path, setPath] = useState(location.path ?? '');
  const [projects, setProjects] = useState(location.projects ?? []);
  const [check, setCheck] = useState(true);
  const [busy, setBusy] = useState(false);
  const [server_error, setServerError] = useState(null);
  const submit = event => {
    event.preventDefault();
    setBusy(true);
    setServerError(null);
    saveStorageLocation(queryClient, { id: location.id, ...(create ? { url } : {}), path, projects, check })
      .then(saved => {
        toaster.show({ message: create ? `Added ${saved?.url}` : `Saved ${saved?.url}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });
        onClose();
      })
      .catch(error => setServerError(errorMessage(error)))
      .finally(() => setBusy(false));
  };
  return <form onSubmit={submit} noValidate>
    <DialogBody>
      {server_error && <Callout intent={Intent.DANGER} style={{ marginBottom: 16 }} role="alert" title="The server refused it">{server_error}</Callout>}
      <FormGroup label="Runs store" labelFor="location-url" helperText={create
        ? "The start of what its runs store as their location, e.g. the bucket's URL. It can't change later."
        : "It can't change: runs store it. Add another location instead."}>
        <InputGroup id="location-url" value={url} onChange={e => setUrl(e.target.value)} disabled={!create} placeholder="s3://team-a-bucket/qaboard/" className={Classes.MONOSPACE_TEXT} autoFocus={create} spellCheck={false}/>
      </FormGroup>
      <FormGroup label="Folder on the server" labelFor="location-path" helperText="Where it is mounted in the backend, the proxy and the image server, inside a storage root. Changing it never moves files: mount them there first.">
        <InputGroup id="location-path" value={path} onChange={e => setPath(e.target.value)} placeholder="/mnt/qaboard/team-a" className={Classes.MONOSPACE_TEXT} autoFocus={!create} spellCheck={false}/>
      </FormGroup>
      <FormGroup label="New runs of" labelFor="location-projects" helperText={<>Projects, groups (<code>team-a/</code>: all its projects) or <code>*</code>. The most specific location wins. Older runs stay where they are.</>}>
        <TagInput
          inputProps={{ id: 'location-projects' }}
          values={projects}
          onChange={next => setProjects([...new Set(next.map(v => String(v).trim()).filter(Boolean))])}
          placeholder="team-a/, Enter after each"
          addOnBlur
          onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }}
        />
      </FormGroup>
      <Switch checked={check} onChange={e => setCheck(e.target.checked)} label="Check that the server sees the folder"/>
    </DialogBody>
    <DialogFooter actions={<>
      <Button text="Cancel" onClick={() => onClose()}/>
      <Button type="submit" intent={Intent.PRIMARY} text={create ? "Add" : "Save"} loading={busy} disabled={!url.trim() || !path.trim()}/>
    </>}/>
  </form>;
};


const RemoveAlert = ({ location, onClose }) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const runs = location?.runs ?? 0;
  const remove = () => {
    setBusy(true);
    deleteStorageLocation(queryClient, location?.id, { force: runs > 0 })
      .then(() => { toaster.show({ message: `Removed ${location?.url}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 }); onClose(); })
      .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 }))
      .finally(() => setBusy(false));
  };
  return <Alert
    isOpen={!!location}
    intent={Intent.DANGER}
    icon="trash"
    confirmButtonText={runs ? "Remove anyway" : "Remove"}
    cancelButtonText="Cancel"
    loading={busy}
    onConfirm={remove}
    onCancel={() => onClose()}
  >
    {runs
      ? <p>{runs} runs are in {location?.url}: the web app won't show their files until you add it back. To only stop new runs from going there, change it and remove its projects instead.</p>
      : <p>Remove {location?.url}? Its files stay where they are.</p>}
  </Alert>;
};

export default StorageLocations;
