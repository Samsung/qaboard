import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { DateTime } from 'luxon';
import {
  AnchorButton,
  Button,
  Classes,
  Collapse,
  Colors,
  Icon,
  Intent,
  NonIdealState,
  SegmentedControl,
  Tooltip,
} from "@blueprintjs/core";

import { pretty_label } from '../utils'
import { folder_url } from "../utils/paths";
import { RunList, RunLogs } from './logs/RunLogs'
import { LogViewer } from './logs/LogViewer'
import { BatchSubmissions } from './logs/BatchSubmissions'
import { batchSubmissions } from './logs/submissions'
import { DirectoryActions } from './logs/DirectoryActions'
import { copyWithToast } from '../utils/clipboard'
import { fileExists } from './logs/fetchRange'


// Rendering many runs is slow
const PAGE_SIZE = 100

const ListToolbar = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
  .spacer {
    flex: 1;
  }
`

const SectionHeading = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  margin: 28px 0 10px 0;
  h3 {
    margin: 0 6px 0 0;
  }
`

const Command = styled.div`
  padding: 8px 12px;
  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 14px;
    margin-bottom: 6px;
    font-size: 12px;
  }
  .meta > span, .meta .hint {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .spacer {
    flex: 1;
  }
  .command {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
    padding: 6px 4px 6px 10px;
    border-radius: 3px;
    background: ${Colors.LIGHT_GRAY5};
    font-size: 12px;
    .${Classes.DARK} & {
      background: ${Colors.DARK_GRAY3};
    }
  }
  .command code {
    flex: 1;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding-top: 3px;
  }
`

/**
 * Where are the logs of a `qa batch` command?
 * - ci: in the CI job
 * - qaboard: it was started from QA-Board, with its own logs
 * - saved: started from a terminal, it saved its logs in the batch directory (command.log)
 * - batch-log: in the batch directory's log.txt (batches started from QA-Board before 2026-10)
 * - terminal: started with `qa --share batch` by an older qaboard, it only printed its logs in the terminal
 * - unknown: e.g. a CI that doesn't tell us the job's URL
 */
// Where `qa batch` saves its logs, relative to the batch directory. Anyone can save commands: we only follow these paths
const SAVED_LOG = /^qa-batch-logs\/\d{8}-\d{6}-[0-9a-f]{8}\/log\.txt$/

export function commandLogs(id, command, { submission_ids = new Set(), has_batch_log = false } = {}) {
  if (command.job_url) return 'ci'
  if (submission_ids.has(id)) return 'qaboard'
  if (SAVED_LOG.test(command.log ?? '')) return 'saved'
  // They ran as CI jobs (CI=true), not with --share
  if (has_batch_log && !command.share) return 'batch-log'
  if (command.share) return 'terminal'
  return 'unknown'
}

const NotSaved = ({ text, why }) => <Tooltip content={<div style={{ maxWidth: 360 }}>{why} QA-Board saves the logs of each run, they are above.</div>}>
  <span className="hint"><Icon icon="info-sign" size={12} />{text}</span>
</Tooltip>

const CommandLogs = ({ id, command, logs, batch_dir_url, expanded, onShowLogs }) => {
  // Without a scheduler, the dask runner starts workers on LSF, they log in the batch directory
  const dask_logs = command.runner === 'dask' && !command.scheduler_address && !!batch_dir_url && <AnchorButton
    size="small"
    variant="minimal"
    icon="folder-shared-open"
    href={folder_url(`${batch_dir_url}/dask/${id.slice(0, 8)}`)}
    target="_blank"
    rel="noopener noreferrer"
  >
    Dask workers' logs
  </AnchorButton>
  switch (logs) {
    case 'ci':
      return <>{dask_logs}<AnchorButton size="small" variant="minimal" intent={Intent.PRIMARY} icon="share" href={command.job_url} target="_blank" rel="noopener noreferrer">
        Logs in the CI job
      </AnchorButton></>
    case 'qaboard':
    case 'batch-log':
      return <>
        {logs === 'qaboard' && <span><Icon icon="application" size={12} />Started from QA-Board</span>}
        {dask_logs}
        <Button size="small" variant="minimal" intent={Intent.PRIMARY} icon="console" onClick={onShowLogs}>Show its logs</Button>
      </>
    case 'saved':
      return <>
        {dask_logs}
        <Button size="small" variant="minimal" intent={Intent.PRIMARY} icon={expanded ? "chevron-up" : "console"} aria-expanded={expanded} onClick={onShowLogs}>
          {expanded ? 'Hide its logs' : 'Show its logs'}
        </Button>
      </>
    case 'terminal':
      return <>{dask_logs}<NotSaved text="Logs not saved: started from a terminal" why="qa batch printed its logs in the terminal it was started from. Recent versions of qaboard save them." /></>
    default:
      return <>{dask_logs}<NotSaved text="Logs not saved" why="QA-Board doesn't have the logs of this qa batch." /></>
  }
}

/**
 * A `qa batch` command, and where its logs are. `live` while it may still write its logs.
 */
const BatchCommand = ({ id, command, logs, batch_dir_url, live, onShowLogs }) => {
  const [expanded, setExpanded] = useState(false)
  const created_at = DateTime.fromISO(command.command_created_at_datetime, { zone: 'utc' })
  const text = (command.argv ?? []).join(" ")
  // its logs are here, or elsewhere on the page
  const showLogs = logs === 'saved' ? () => setExpanded(!expanded) : onShowLogs
  return <Command>
    <div className={`meta ${Classes.TEXT_MUTED}`}>
      <span>
        <Icon icon="time" size={12} />
        <Tooltip content={created_at.toLocal().toLocaleString(DateTime.DATETIME_FULL)}>{created_at.toRelative()}</Tooltip>
      </span>
      {!!command.user && <span><Icon icon="user" size={12} />{command.user}</span>}
      {!!command.HOST && <span><Icon icon="desktop" size={12} />{command.HOST}</span>}
      <span className="spacer" />
      <CommandLogs id={id} command={command} logs={logs} batch_dir_url={batch_dir_url} expanded={expanded} onShowLogs={showLogs} />
    </div>
    <pre className={`command ${Classes.MONOSPACE_TEXT}`}>
      <code>{text}</code>
      <Tooltip content="Copy the command">
        <Button size="small" variant="minimal" icon="duplicate" aria-label="Copy the command" onClick={() => copyWithToast(text, { what: 'the command' })} />
      </Tooltip>
    </pre>
    {logs === 'saved' && <Collapse isOpen={expanded} transitionDuration={150}>
      <div style={{ marginTop: 8 }}>
        <LogViewer files={[{ name: 'log.txt', url: `${batch_dir_url}/${command.log}` }]} live={live} />
      </div>
    </Collapse>}
  </Command>
}


// null while we check, then true, false, or 'error' (e.g. 403)
const useFileExists = url => {
  const [state, setState] = useState({ url: null, exists: null })
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    fileExists(url, { signal: controller.signal })
      .then(exists => setState({ url, exists }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ url, exists: 'error' })
      })
    return () => controller.abort()
  }, [url])
  return state.url === url ? state.exists : null
}


/**
 * The logs of all the runs in a batch, and of the commands that started it.
 */
export const BatchLogs = ({ batch, project, commit }) => {
  const [filter, setFilter] = useState('all')
  const [expanded, setExpanded] = useState(() => new Set())
  const [limit, setLimit] = useState(PAGE_SIZE)
  // Asks BatchSubmissions to show a submission's logs
  const [focused_submission, setFocusedSubmission] = useState(null)
  const batch_log_ref = useRef(null)
  // Before 2026-10, batches started from QA-Board logged in the batch directory
  const batch_log = useFileExists(batch?.batch_dir_url ? `${batch.batch_dir_url}/log.txt` : null)

  const outputs = useMemo(() => (batch?.filtered?.outputs ?? [])
    .map(id => batch.outputs[id])
    .filter(output => !!output && output.output_type !== "optim_iteration"),
  [batch])
  const failed = useMemo(() => outputs.filter(output => output.is_failed), [outputs])
  const pending = useMemo(() => outputs.filter(output => output.is_pending), [outputs])
  const toggle = useCallback(id => setExpanded(expanded => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])

  if (batch === null || batch === undefined || batch.batch_dir_url === undefined)
    return null

  const shown = filter === 'failed' ? failed : (filter === 'pending' ? pending : outputs)

  const submission_ids = new Set(batchSubmissions(batch).map(submission => submission.id))
  const has_submissions = submission_ids.size > 0
  const has_batch_log = batch_log === true || batch_log === 'error'
  // most recent first, like the submissions
  const commands = Object.entries(batch.data?.commands ?? {})
    .sort(([, a], [, b]) => (b.command_created_at_datetime ?? '').localeCompare(a.command_created_at_datetime ?? ''))
  const has_pending_runs = Object.values(batch.outputs ?? {}).some(output => output.is_pending)
  const showBatchLog = () => {
    setExpanded(expanded => new Set(expanded).add('batch'))
    batch_log_ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }
  const batch_output = {
    is_failed: false,
    is_pending: false,
    is_running: false,
    extra_parameters: {},
    output_type: "batch",
    output_dir_url: batch.batch_dir_url,
    test_input_metadata: batch.data,
    configurations: [],
  }

  return <>
    <BatchSubmissions key={batch.id} batch={batch} has_runs={Object.keys(batch.outputs ?? {}).length > 0} focus={focused_submission} />
    {has_submissions && <h3 className={Classes.HEADING}>Runs</h3>}
    {outputs.length > 0 && <ListToolbar>
      <SegmentedControl
        size="small"
        value={filter}
        onValueChange={value => {
          setFilter(value)
          setLimit(PAGE_SIZE)
        }}
        options={[
          { value: 'all', label: `All · ${outputs.length}` },
          { value: 'failed', label: `Failed · ${failed.length}`, disabled: !failed.length && filter !== 'failed' },
          { value: 'pending', label: `Running · ${pending.length}`, disabled: !pending.length && filter !== 'pending' },
        ]}
      />
      <span className="spacer" />
      {failed.length > 0 && <Button
        size="small"
        variant="minimal"
        icon="expand-all"
        onClick={() => setExpanded(new Set(failed.slice(0, 20).map(output => output.id)))}
      >
        Open failed runs{failed.length > 20 ? ' (first 20)' : ''}
      </Button>}
      {expanded.size > 0 && <Button size="small" variant="minimal" icon="collapse-all" onClick={() => setExpanded(new Set())}>
        Collapse all
      </Button>}
    </ListToolbar>}

    {shown.length > 0
      ? <RunList>
          {shown.slice(0, limit).map(output => <RunLogs
            key={output.id}
            id={output.id}
            output={output}
            project={project}
            commit={commit}
            expanded={expanded.has(output.id)}
            onToggle={toggle}
          />)}
        </RunList>
      : <NonIdealState
          icon={filter === 'failed' ? "tick-circle" : "search"}
          title={filter === 'failed' ? "No failed runs" : (filter === 'pending' ? "No running runs" : ((batch.filtered?.outputs?.length ?? 0) < Object.keys(batch.outputs ?? {}).length ? "No run matches the filter" : "No runs yet"))}
          layout="horizontal"
        />
    }
    {shown.length > limit && <Button style={{ marginTop: 8 }} variant="outlined" fill onClick={() => setLimit(limit => limit + PAGE_SIZE)}>
      Show {Math.min(PAGE_SIZE, shown.length - limit)} more ({(shown.length - limit).toLocaleString()} hidden)
    </Button>}

    <SectionHeading>
      <h3 className={Classes.HEADING}>Batch: {pretty_label(batch)}</h3>
      {!!batch.batch_dir_url && <DirectoryActions url={batch.batch_dir_url} what="the batch directory" />}
    </SectionHeading>
    {has_batch_log && <RunList ref={batch_log_ref} style={{ marginBottom: 12, scrollMarginTop: 16 }}>
      <RunLogs
        id="batch"
        output={batch_output}
        project={project}
        commit={commit}
        title="Batch logs"
        expanded={expanded.has('batch')}
        onToggle={toggle}
      />
    </RunList>}
    {commands.length > 0 && <RunList>
      {commands.map(([id, command], index) => <BatchCommand
        key={id}
        id={id}
        command={command}
        logs={commandLogs(id, command, { submission_ids, has_batch_log })}
        batch_dir_url={batch.batch_dir_url}
        // qa batch usually waits for its runs
        live={index === 0 && has_pending_runs}
        onShowLogs={submission_ids.has(id) ? () => setFocusedSubmission({ id }) : showBatchLog}
      />)}
    </RunList>}
    {!commands.length && !has_batch_log && batch_log !== null && <p className={Classes.TEXT_MUTED}>
      No <code className={Classes.CODE}>qa batch</code> command was saved for this batch.
    </p>}
  </>
}
