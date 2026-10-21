// Deleting runs' files: what will be deleted, what's kept and why, then a confirmation for big deletions.
// The server computes everything again when deleting: the numbers here are what it says.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Callout, Classes, Dialog, DialogBody, DialogFooter, FormGroup, HTMLTable, Icon, InputGroup, Intent, Spinner } from "@blueprintjs/core";

import { errorMessage } from "../api/http";
import { toaster } from "../toaster";
import { previewDeletion, deleteSelection } from "./api";
import { formatBytes, formatNumber, plural } from "./format";


const Kept = ({ icon, title, kept, children }) => kept.runs > 0 && <li style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
  <Icon icon={icon} className={Classes.TEXT_MUTED} style={{ marginTop: 2 }}/>
  <span><strong>{title}</strong>: {plural(kept.runs, 'run')} ({formatBytes(kept.bytes)}) in {plural(kept.batches, 'batch', 'batches')}. {children}</span>
</li>;

// `selection`: {group, keys (null for everything matching the filters), filters, label}
export const DeleteDialog = ({ selection, onClose, onDeleted }) => {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { data: preview, isPending, error: preview_error } = useQuery({
    queryKey: ['storage', 'preview', JSON.stringify(selection)],
    queryFn: () => previewDeletion(selection),
    staleTime: 0,
    gcTime: 0,
  });
  const nothing = preview && preview.runs === 0;
  const confirmed = !preview?.confirm_phrase || confirm.trim().toLowerCase() === preview.confirm_phrase;

  const submit = event => {
    event.preventDefault();
    if (!confirmed || nothing) return;
    setBusy(true);
    setError(null);
    deleteSelection(queryClient, selection, confirm)
      .then(({ job }) => {
        toaster.show({ message: `Deleting the files of ${plural(preview.runs, 'run')}: follow it in "Your deletions"`, intent: Intent.SUCCESS, icon: 'trash', timeout: 4000 });
        onDeleted?.(job);
        onClose();
      })
      .catch(error => setError(errorMessage(error)))
      .finally(() => setBusy(false));
  };

  return <Dialog isOpen onClose={onClose} title="Delete the runs' files" icon="trash" style={{ width: 620, maxWidth: 'calc(100vw - 32px)' }}>
    <form onSubmit={submit} noValidate>
      <DialogBody>
        {selection.label && <p className={Classes.TEXT_MUTED} style={{ marginTop: 0 }}>{selection.label}</p>}
        {isPending && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Spinner size={16}/> Looking at what you selected…</div>}
        {preview_error && <Callout intent={Intent.DANGER} title="Could not prepare the deletion">{errorMessage(preview_error)}</Callout>}
        {preview && <>
          {nothing
            ? <Callout intent={Intent.WARNING} title="Nothing to delete" icon="info-sign">
              Everything you selected is kept: see why below.
            </Callout>
            : <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <span style={{ fontSize: 28, fontWeight: 600 }} data-testid="freed">{preview.partial_batches ? 'Up to ' : ''}{formatBytes(preview.bytes)}</span>
              <span className={Classes.TEXT_MUTED}>
                freed: the files of {plural(preview.runs, 'run')} in {plural(preview.batches, 'batch', 'batches')}
                {preview.commits > 1 ? `, ${formatNumber(preview.commits)} commits` : ''}
                {preview.owner ? `, run by ${preview.owner}` : ', whoever ran them'}
              </span>
            </div>}
          {preview.projects.length > 1 && <HTMLTable compact style={{ width: '100%', marginBottom: 12 }} aria-label="By project">
            <tbody>
              {preview.projects.slice(0, 6).map(p => <tr key={p.project_id}><td>{p.project_id}</td><td style={{ textAlign: 'right' }}>{formatBytes(p.bytes)}</td></tr>)}
              {preview.projects.length > 6 && <tr><td className={Classes.TEXT_MUTED} colSpan={2}>and {preview.projects.length - 6} more projects</td></tr>}
            </tbody>
          </HTMLTable>}
          {preview.partial_batches > 0 && <p className={Classes.TEXT_MUTED}>
            {plural(preview.partial_batches, 'batch is', 'batches are')} only partly in <code>{preview.folder}</code>: only their runs in it are deleted.
          </p>}
          {(preview.kept.milestones.runs > 0 || preview.kept.others.runs > 0) && <>
            <h6 className={Classes.HEADING}>Kept</h6>
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
              <Kept icon="lock" title="Milestones" kept={preview.kept.milestones}>Delete the milestone first if you really don't need it.</Kept>
              <Kept icon="people" title="Other people's runs" kept={preview.kept.others}>
                Run by {preview.kept.others.users.join(', ')}{preview.kept.others.users.length >= 10 ? '…' : ''}: they can delete them, or an admin.
              </Kept>
            </ul>
          </>}
          {!nothing && <Callout icon="info-sign" style={{ marginBottom: 12 }}>
            The runs' files are deleted, which frees your quota. The runs stay listed, as deleted, with their metrics:
            you can redo them later. Runs still running are kept. <strong>The files can't be recovered.</strong>
          </Callout>}
          {!nothing && preview.confirm_phrase && <FormGroup
            label={<>That's a lot: type <code>{preview.confirm_phrase}</code> to confirm</>}
            labelFor="storage-confirm"
          >
            <InputGroup id="storage-confirm" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} placeholder={preview.confirm_phrase}/>
          </FormGroup>}
          {error && <Callout intent={Intent.DANGER} role="alert">{error}</Callout>}
        </>}
      </DialogBody>
      <DialogFooter actions={<>
        <Button text="Cancel" onClick={onClose}/>
        {!nothing && <Button
          type="submit"
          intent={Intent.DANGER}
          icon="trash"
          text={preview ? `Delete the files of ${plural(preview.runs, 'run')}` : 'Delete'}
          disabled={!preview || !confirmed}
          loading={busy}
        />}
      </>}/>
    </form>
  </Dialog>;
};

export default DeleteDialog;
