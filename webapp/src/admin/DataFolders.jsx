// Admin → Storage → Data folders: folders QA-Board reads but never changes, e.g. datasets (backend/data_folders.py,
// website/docs/backend-admin/storage.mdx#data-folders). Thumbnails, the input file endpoint and the file browser read
// there; writes, deletes, cleanups and storage usage never consider them.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Callout, Classes, HTMLTable, InputGroup, Intent, Switch, Tag, Tooltip } from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { useSiteConfig } from "../hooks";
import { Loading } from "../settings/states";
import { AdminError } from "./states";
import { docsUrl } from "./settings/SettingRow";
import { dataFoldersQuery, addDataFolder, removeDataFolder } from "./api";


const DOCS = '/docs/backend-admin/storage#data-folders';
const mono = { className: Classes.MONOSPACE_TEXT, style: { overflowWrap: 'anywhere' } };

const Status = ({ folder }) => <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
  {!folder.reachable && <Tooltip content="The server doesn't see this folder: mount it there, in the backend, the proxy and the image server.">
    <Tag intent={Intent.DANGER} icon="error">Not mounted</Tag>
  </Tooltip>}
  {folder.in_storage && <Tooltip content="QA-Board already reads it: it's in the storage it manages.">
    <Tag minimal icon="info-sign">In the storage</Tag>
  </Tooltip>}
</span>;


export const DataFolders = () => {
  const { data, isPending, error, refetch } = useQuery(dataFoldersQuery);
  const { docs_root = '/' } = useSiteConfig();
  const [removing, setRemoving] = useState(null);
  return <section aria-labelledby="data-folders-title" style={{ marginBottom: 28 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
      <h4 id="data-folders-title" className={Classes.HEADING} style={{ margin: 0 }}>Data folders</h4>
      <a href={docsUrl(docs_root, DOCS)} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 'auto', fontSize: 13 }}>Docs</a>
    </div>
    <p className={Classes.TEXT_MUTED} style={{ margin: '6px 0 12px', maxWidth: 760 }}>
      Folders QA-Board reads but never changes: your datasets. Thumbnails and the file viewer can show files there.
    </p>
    {isPending ? <Loading label="Loading the data folders"/>
      : error ? <AdminError error={error} refetch={refetch} what="the data folders"/>
      : <>
        {data.data_folders.length > 0
          ? <div style={{ overflowX: 'auto' }}>
            <HTMLTable compact striped style={{ width: '100%' }} aria-label="Data folders">
              <thead><tr><th>Folder on the server</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {data.data_folders.map(folder => <tr key={folder.path}>
                  <td {...mono}>{folder.path}</td>
                  <td><Status folder={folder}/></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Button small minimal icon="trash" intent={Intent.DANGER} aria-label={`Remove ${folder.path}`} onClick={() => setRemoving(folder)}/>
                  </td>
                </tr>)}
              </tbody>
            </HTMLTable>
          </div>
          : <p className={Classes.TEXT_MUTED}>None yet: QA-Board reads only its storage{data.storage_roots.length > 0 && <> (<span className={Classes.MONOSPACE_TEXT}>{data.storage_roots.join(':')}</span>)</>}.</p>}
        <AddForm/>
      </>}
    <RemoveAlert folder={removing} onClose={() => setRemoving(null)}/>
  </section>;
};


const AddForm = () => {
  const queryClient = useQueryClient();
  const [path, setPath] = useState('');
  const [check, setCheck] = useState(true);
  const [busy, setBusy] = useState(false);
  const [server_error, setServerError] = useState(null);
  const submit = event => {
    event.preventDefault();
    setBusy(true);
    setServerError(null);
    addDataFolder(queryClient, { path: path.trim(), check })
      .then(added => {
        toaster.show({ message: `Added ${added?.path}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 });
        setPath('');
      })
      .catch(error => setServerError(errorMessage(error)))
      .finally(() => setBusy(false));
  };
  return <form onSubmit={submit} noValidate style={{ marginTop: 12, maxWidth: 760 }}>
    {server_error && <Callout intent={Intent.DANGER} style={{ marginBottom: 8 }} role="alert" title="The server refused it">{server_error}</Callout>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <InputGroup
        aria-label="Folder to add"
        value={path}
        onChange={e => setPath(e.target.value)}
        placeholder="/mnt/nas/datasets"
        className={Classes.MONOSPACE_TEXT}
        spellCheck={false}
        style={{ minWidth: 280 }}
      />
      <Button type="submit" icon="add" text="Add a data folder" loading={busy} disabled={!path.trim()}/>
      <Switch checked={check} onChange={e => setCheck(e.target.checked)} label="Check that the server sees it" style={{ margin: 0 }}/>
    </div>
  </form>;
};


const RemoveAlert = ({ folder, onClose }) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const remove = () => {
    setBusy(true);
    removeDataFolder(queryClient, folder?.path)
      .then(() => { toaster.show({ message: `Removed ${folder?.path}`, intent: Intent.SUCCESS, icon: 'tick', timeout: 3000 }); onClose(); })
      .catch(error => toaster.show({ message: errorMessage(error), intent: Intent.DANGER, timeout: 8000 }))
      .finally(() => setBusy(false));
  };
  return <Alert
    isOpen={!!folder}
    intent={Intent.DANGER}
    icon="trash"
    confirmButtonText="Remove"
    cancelButtonText="Cancel"
    loading={busy}
    onConfirm={remove}
    onCancel={() => onClose()}
  >
    <p>Stop reading {folder?.path}? Its files stay where they are: thumbnails and the file viewer just can't show them anymore.</p>
  </Alert>;
};

export default DataFolders;
