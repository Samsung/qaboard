// The `qa batch` commands that started a batch, from QA-Board, a terminal or the CI, most recent first:
// what they ran, their logs, and how to run them again.
import React, { useState } from "react";
import styled from "styled-components";
import { DateTime } from "luxon";
import { AnchorButton, Button, Classes, Collapse, Colors, Icon, Intent, Tag, Tooltip } from "@blueprintjs/core";

import { folder_url } from "../../utils/paths";
import { copyWithToast } from "../../utils/clipboard";
import { SubmittedBy } from "../SubmittedBy";
import { LogViewer } from "./LogViewer";
import { RunList, Header, Content, INTERACTIVE } from "./RunLogs";
import { SubmissionRow } from "./BatchSubmissions";
import { batchSubmissions } from "./submissions";
import { RunAgainButton, SnapshotSummary } from "./RunAgain";
import { commandText } from "./reproduce";


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


/**
 * The commands and submissions of a batch, most recent first. Commands that QA-Board started are its submissions:
 * we show them once, as submissions.
 */
export function batchEntries(batch) {
  const submissions = batchSubmissions(batch)
  const submission_ids = new Set(submissions.map(s => s.id))
  const time = iso => {
    const date = DateTime.fromISO(iso ?? '', { zone: 'utc' })
    return date.isValid ? date.toMillis() : 0
  }
  return [
    ...submissions.map(submission => ({ kind: 'submission', id: submission.id, at: time(submission.created_at), submission })),
    ...Object.entries(batch?.data?.commands ?? {})
      .filter(([id]) => !submission_ids.has(id))
      .map(([id, command]) => ({ kind: 'command', id, at: time(command.command_created_at_datetime), command })),
  ].sort((a, b) => b.at - a.at)
}


const Meta = styled.span`
  flex: 1 1 280px;
  min-width: 0;
  font-size: 13px;
  strong {
    font-weight: 600;
    margin-right: 6px;
  }
`

const CommandLine = styled.pre`
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 8px 8px 42px;
  padding: 4px 4px 4px 10px;
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

const Hint = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  margin: 0 6px;
`

const NotSaved = ({ text, why }) => <Tooltip content={<div style={{ maxWidth: 360 }}>{why} QA-Board saves the logs of each run, they are below.</div>}>
  <Hint className={Classes.TEXT_MUTED}><Icon icon="info-sign" size={12} />{text}</Hint>
</Tooltip>

const relative = date => date.isValid ? date.toRelative() : ''
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

const ORIGINS = {
  ci: { icon: 'build', text: 'CI' },
  terminal: { icon: 'console', text: 'Terminal' },
}


/**
 * A `qa batch` started from a terminal or the CI: the command, what it ran, and its logs when they were saved.
 */
const CommandRow = ({ id, command, logs, batch, project, commit, live, latest, expanded, onToggle, onShowBatchLog }) => {
  const created_at = DateTime.fromISO(command.command_created_at_datetime ?? '', { zone: 'utc' })
  const text = commandText(command.argv)
  const snapshot = command.batches_snapshot
  const saved = logs === 'saved'
  const can_expand = saved || !!snapshot
  const origin = ORIGINS[logs === 'ci' ? 'ci' : 'terminal']
  const batch_dir_url = batch.batch_dir_url
  const toggle = event => {
    if (!can_expand || event?.target?.closest?.(INTERACTIVE)) return
    onToggle()
  }
  // Without a scheduler, the dask runner starts workers on LSF, they log in the batch directory
  const dask_logs = command.runner === 'dask' && !command.scheduler_address && !!batch_dir_url && <AnchorButton
    size="small" variant="minimal" icon="folder-shared-open" href={folder_url(`${batch_dir_url}/dask/${id.slice(0, 8)}`)} target="_blank" rel="noopener noreferrer"
  >
    Dask workers' logs
  </AnchorButton>
  const files = snapshot?.files?.length ?? 0
  return <div>
    <Header onClick={toggle} $expanded={expanded} style={can_expand ? undefined : { cursor: 'default' }}>
      {can_expand
        ? <Button size="small" variant="minimal" icon={expanded ? "chevron-down" : "chevron-right"} aria-label={expanded ? "Hide the details" : "Show the details"} aria-expanded={expanded} onClick={() => onToggle()} />
        : <span style={{ width: 24, flex: 'none' }} />}
      <Tag minimal icon={origin.icon}>{origin.text}</Tag>
      <Meta>
        <strong>{(command.argv ?? []).includes('optimize') ? 'qa optimize' : 'qa batch'}</strong>
        <span className={Classes.TEXT_MUTED}>
          {!!command.user && <>by {latest ? <SubmittedBy data={{ user: command.user, submitted_by: batch.data?.submitted_by }} /> : command.user} · </>}
          <Tooltip content={created_at.isValid ? created_at.toLocal().toLocaleString(DateTime.DATETIME_FULL) : ''}>{relative(created_at)}</Tooltip>
          {!!command.HOST && <> · on {command.HOST}</>}
          {files > 0 && <> · from {files === 1 ? snapshot.files[0] : plural(files, 'batch file')}</>}
        </span>
      </Meta>
      <span className="actions">
        {dask_logs}
        {logs === 'ci' && <AnchorButton size="small" variant="minimal" intent={Intent.PRIMARY} icon="share" href={command.job_url} target="_blank" rel="noopener noreferrer">Logs in the CI job</AnchorButton>}
        {saved && <Button size="small" variant="minimal" intent={Intent.PRIMARY} icon={expanded ? "chevron-up" : "console"} aria-expanded={expanded} onClick={() => onToggle()}>
          {expanded ? 'Hide its logs' : 'Show its logs'}
        </Button>}
        {logs === 'batch-log' && <Button size="small" variant="minimal" intent={Intent.PRIMARY} icon="console" onClick={onShowBatchLog}>Show its logs</Button>}
        {logs === 'terminal' && <NotSaved text="Logs not saved: started from a terminal" why="qa batch printed its logs in the terminal it was started from. Recent versions of qaboard save them." />}
        {logs === 'unknown' && <NotSaved text="Logs not saved" why="QA-Board doesn't have the logs of this qa batch." />}
        <RunAgainButton entry={{ kind: 'command', id, command }} batch={batch} project={project} commit={commit} />
      </span>
    </Header>
    {!!text && <CommandLine className={Classes.MONOSPACE_TEXT}>
      <code title={(command.argv ?? []).join(' ')}>{text}</code>
      <Tooltip content="Copy the command">
        <Button size="small" variant="minimal" icon="duplicate" aria-label="Copy the command" onClick={() => copyWithToast(text, { what: 'the command' })} />
      </Tooltip>
    </CommandLine>}
    {can_expand && <Collapse isOpen={expanded} transitionDuration={150}>
      <Content>
        <SnapshotSummary snapshot={snapshot} />
        {saved && <LogViewer files={[{ name: 'log.txt', url: `${batch_dir_url}/${command.log}` }]} live={live} />}
      </Content>
    </Collapse>}
  </div>
}


const SHOWN = 4

/**
 * How the batch was started: the `qa batch` commands, from QA-Board, a terminal or the CI, most recent first.
 * If the batch has no runs yet, we open its most recent submission: it's likely why.
 */
export const BatchCommands = ({ batch, project, commit, has_runs, has_pending_runs, has_batch_log, onShowBatchLog, available_tests_files, repo_file_url }) => {
  const entries = batchEntries(batch)
  const submission_ids = new Set(entries.filter(e => e.kind === 'submission').map(e => e.id))
  const [expanded, setExpanded] = useState(() => new Set(!has_runs && entries[0]?.kind === 'submission' ? [entries[0].id] : []))
  const [show_all, setShowAll] = useState(false)
  if (!entries.length) return null
  const toggle = id => setExpanded(expanded => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const shown = show_all ? entries : entries.slice(0, SHOWN)
  return <>
    <RunList>
      {shown.map((entry, index) => entry.kind === 'submission'
        ? <SubmissionRow
            key={entry.id}
            submission={entry.submission}
            expanded={expanded.has(entry.id)}
            onToggle={() => toggle(entry.id)}
            available_tests_files={available_tests_files}
            repo_file_url={repo_file_url}
            actions={<RunAgainButton entry={entry} batch={batch} project={project} commit={commit} />}
          >
            <SnapshotSummary snapshot={entry.submission.batches_snapshot} />
          </SubmissionRow>
        : <CommandRow
            key={entry.id}
            id={entry.id}
            command={entry.command}
            logs={commandLogs(entry.id, entry.command, { submission_ids, has_batch_log })}
            batch={batch}
            project={project}
            commit={commit}
            // qa batch usually waits for its runs
            live={index === 0 && has_pending_runs}
            latest={index === 0}
            expanded={expanded.has(entry.id)}
            onToggle={() => toggle(entry.id)}
            onShowBatchLog={onShowBatchLog}
          />)}
    </RunList>
    {entries.length > SHOWN && <Button style={{ marginTop: 6 }} size="small" variant="minimal" onClick={() => setShowAll(!show_all)}>
      {show_all ? 'Show less' : `Show ${entries.length - SHOWN} older`}
    </Button>}
  </>
}
