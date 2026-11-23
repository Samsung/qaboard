// "Run again": how to run a `qa batch` again, with the batches as they ran (the snapshot qa and QA-Board save)
import React, { useEffect, useState } from "react";
import styled from "styled-components";
import { AnchorButton, Button, Callout, Classes, Colors, Dialog, DialogBody, DialogFooter, Icon, Intent, Spinner, Tag, Tooltip } from "@blueprintjs/core";
import { DateTime } from "luxon";

import { usePrefsStore } from "../../stores/prefs";
import { updateSelected } from "../../selection";
import { copyWithToast } from "../../utils/clipboard";
import { againLabel, formPrefill, runSpec, snapshotFileName, terminalCommands } from "./reproduce";


const Section = styled.section`
  margin-bottom: 18px;
  h4 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 6px 0;
    font-size: 14px;
  }
  p {
    margin: 0 0 8px 0;
  }
`

const Code = styled.pre`
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 4px 0 10px 0;
  padding: 6px 4px 6px 10px;
  border-radius: 3px;
  background: ${Colors.LIGHT_GRAY5};
  font-size: 12px;
  .${Classes.DARK} & {
    background: ${Colors.DARK_GRAY3};
  }
  code {
    flex: 1;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding-top: 3px;
  }
`

const Yaml = styled(Code)`
  max-height: 320px;
  overflow: auto;
  code {
    white-space: pre;
    overflow-wrap: normal;
  }
`

const Step = styled.div`
  font-size: 12px;
  font-weight: 600;
  margin-top: 4px;
`


export const CopyableCommand = ({ text, what = 'the command', label = 'Copy the command' }) => <Code className={Classes.MONOSPACE_TEXT}>
  <code>{text}</code>
  <Tooltip content={label}>
    <Button size="small" variant="minimal" icon="duplicate" aria-label={label} onClick={() => copyWithToast(text, { what })} />
  </Tooltip>
</Code>


// The snapshot's YAML: sent with the command, or in the submission's folder
export function useSnapshotYaml(snapshot, enabled = true) {
  const inline = snapshot?.yaml ?? null
  const url = !inline && enabled ? snapshot?.url : null
  const [state, setState] = useState({ url: null, yaml: null, error: null })
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    fetch(url, { signal: controller.signal, credentials: 'same-origin' })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 404 ? 'The file was deleted.' : `HTTP ${response.status}`)
        setState({ url, yaml: await response.text(), error: null })
      })
      .catch(error => {
        if (!controller.signal.aborted) setState({ url, yaml: null, error: error.message })
      })
    return () => controller.abort()
  }, [url])
  if (inline) return { yaml: inline, loading: false, error: null }
  if (!url) return { yaml: null, loading: false, error: null }
  return state.url === url ? { ...state, loading: false } : { yaml: null, loading: true, error: null }
}


export function downloadText(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}


const listed = names => names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

// What ran, in a sentence
export const SnapshotSummary = ({ snapshot }) => {
  if (!snapshot) return null
  const batches = snapshot.batches ?? []
  const aliases = snapshot.aliases ?? []
  return <p>
    {batches.length
      ? <>Ran {batches.length > 6 ? `${batches.length} batches` : <>{batches.map((b, i) => <React.Fragment key={b}>{i > 0 && (i === batches.length - 1 ? ' and ' : ', ')}<Tag minimal>{b}</Tag></React.Fragment>)}</>}</>
      : 'No batch definition'}
    {aliases.length > 0 && <> through {listed(aliases)}</>}
    {(snapshot.files ?? []).length > 0 && <span className={Classes.TEXT_MUTED}>, from {listed(snapshot.files)}</span>}
    {(snapshot.inputs ?? []).length > 0 && <span className={Classes.TEXT_MUTED}>. Input paths: {listed(snapshot.inputs)}</span>}
    .
  </p>
}


/**
 * How to run a `qa batch` again: from QA-Board (Run Tests / Tuning, filled in), or from a terminal.
 * `entry`: {kind: 'submission', submission} or {kind: 'command', id, command}.
 */
export const RunAgainDialog = ({ isOpen, onClose, entry, batch, project, commit }) => {
  const updateTuning = usePrefsStore(state => state.updateTuning)
  const spec = runSpec(entry, batch)
  const { yaml, loading, error } = useSnapshotYaml(spec.snapshot, isOpen)
  const file = snapshotFileName(spec.label)
  const label = againLabel(batch?.label, Object.keys(commit?.batches ?? {}))
  const commit_id = commit?.hexsha ?? commit?.id
  const { local, server } = terminalCommands(spec, { file, commit_id, label })
  const created_at = entry.kind === 'submission' ? entry.submission.created_at : entry.command.command_created_at_datetime
  const when = DateTime.fromISO(created_at ?? '', { zone: 'utc' })

  const openForm = () => {
    updateTuning(project, formPrefill(spec, { yaml, label, created_at }))
    updateSelected({ selected_views: 'tuning' })
    onClose()
  }

  const has_snapshot = !!spec.snapshot
  return <Dialog
    isOpen={isOpen}
    onClose={onClose}
    title={`Run ${spec.label || 'this batch'} again`}
    icon="repeat"
    style={{ width: 760, maxWidth: 'calc(100vw - 32px)' }}
  >
    <DialogBody>
      {has_snapshot
        ? <Section>
            <p>
              QA-Board saved the batches as they were defined when it started{when.isValid ? <> ({when.toRelative()})</> : null}, with
              only what ran: edits to the batch files since then don't change what runs.
            </p>
            <SnapshotSummary snapshot={spec.snapshot} />
          </Section>
        : <Callout intent={Intent.WARNING} icon="history" style={{ marginBottom: 16 }} title="QA-Board doesn't have the batches as they ran">
            {spec.snapshot_error ?? <>It started before QA-Board saved them (qa batch and QA-Board save them since 2026-11). Running it again uses the batches as they are defined now.</>}
          </Callout>}

      <Section>
        <h4><Icon icon="application" />From QA-Board</h4>
        <p>
          Fills in <strong>Run Tests / Tuning</strong> for this commit{has_snapshot ? ', with these batches' : ''}
          {spec.tuning_search?.parameter_search && Object.keys(spec.tuning_search.parameter_search).length ? ' and the same tuning' : ''}.
          You can change them, and the name, before starting.
        </p>
        <Button intent={Intent.PRIMARY} icon="play" onClick={openForm} disabled={has_snapshot && !yaml} loading={has_snapshot && loading}>
          Open in Run Tests / Tuning
        </Button>
        {!!error && <span className={Classes.TEXT_MUTED} style={{ marginLeft: 8 }}>Could not read the batches: {error}</span>}
      </Section>

      {(local || server) && <Section>
        <h4><Icon icon="console" />From a terminal</h4>
        {has_snapshot && <>
          <Step>1. Save the batches as {file}</Step>
          <div style={{ display: 'flex', gap: 6, margin: '4px 0 8px 0' }}>
            <Button size="small" icon="download" disabled={!yaml} onClick={() => downloadText(yaml, file)}>Download {file}</Button>
            <Button size="small" icon="duplicate" variant="minimal" disabled={!yaml} onClick={() => copyWithToast(yaml, { what: 'the batches' })}>Copy the YAML</Button>
          </div>
          <Step>2. Run them</Step>
        </>}
        {!!local && <>
          <div className={Classes.TEXT_MUTED}>{spec.argv ? 'Like it was started, from the same folder:' : 'In a checkout of this commit:'}</div>
          <CopyableCommand text={has_snapshot || spec.argv ? local : local.replace(/ --batches-file \S+/, '')} />
        </>}
        {!!server && <>
          <div className={Classes.TEXT_MUTED}>Or have QA-Board run it on this commit, from its artifacts:</div>
          <CopyableCommand text={has_snapshot ? server : server.replace(/ --batches-file \S+/, '')} />
        </>}
      </Section>}

      {has_snapshot && <Section>
        <h4><Icon icon="document" />{file}</h4>
        {loading && <Spinner size={16} />}
        {!!yaml && <Yaml className={Classes.MONOSPACE_TEXT} aria-label="The batches as they ran"><code>{yaml}</code></Yaml>}
        {!!spec.snapshot.url && <AnchorButton size="small" variant="minimal" icon="share" href={spec.snapshot.url} target="_blank" rel="noopener noreferrer">Open the file</AnchorButton>}
      </Section>}
    </DialogBody>
    <DialogFooter actions={<Button onClick={onClose}>Close</Button>} />
  </Dialog>
}


export const RunAgainButton = ({ entry, batch, project, commit, ...props }) => {
  const [open, setOpen] = useState(false)
  return <>
    <Button size="small" variant="minimal" icon="repeat" onClick={() => setOpen(true)} {...props}>Run again…</Button>
    {open && <RunAgainDialog isOpen onClose={() => setOpen(false)} entry={entry} batch={batch} project={project} commit={commit} />}
  </>
}
