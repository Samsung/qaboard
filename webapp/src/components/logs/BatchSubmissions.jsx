import React, { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { DateTime } from "luxon";
import { Button, Callout, Classes, Collapse, Colors, Intent, Spinner, Tag, Tooltip } from "@blueprintjs/core";

import { toaster } from "../../toaster";
import { updateSelected } from "../../actions/selected";
import { LogViewer } from "./LogViewer";
import { LsfReport, withCode } from "./LsfReport";
import { lsfHint, lsfKilled, lsfReason } from "./lsf";
import { RunList, Header, Content, INTERACTIVE } from "./RunLogs";
import { batchSubmissions, is_final, useSubmissionStatus } from "./submissions";


const Meta = styled.span`
  flex: 1 1 280px;
  min-width: 0;
  font-size: 13px;
  strong {
    font-weight: 600;
    margin-right: 6px;
  }
`

const Command = styled.pre`
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0 0 10px 0;
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


const LastError = styled.code.attrs({ className: Classes.MONOSPACE_TEXT })`
  display: block;
  margin-top: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
`


const relative = iso => {
  const date = DateTime.fromISO(iso ?? '', { zone: 'utc' })
  return date.isValid ? date.toRelative() : ''
}

const absolute = iso => {
  const date = DateTime.fromISO(iso ?? '', { zone: 'utc' })
  return date.isValid ? date.toLocal().toLocaleString(DateTime.DATETIME_FULL) : ''
}


export const StateTag = ({ state }) => {
  switch (state) {
    case 'queued':
      return <Tag minimal intent={Intent.WARNING} icon="time">Queued</Tag>
    case 'running':
      return <Tag minimal intent={Intent.PRIMARY} icon={<Spinner size={12} />}>Running</Tag>
    case 'failed':
      return <Tag intent={Intent.DANGER} icon="cross">Failed</Tag>
    case 'done':
      return <Tag minimal intent={Intent.SUCCESS} icon="tick">Done</Tag>
    default:
      return null
  }
}


// Why `qa batch` failed, in a few words
export function failureSummary(submission, status) {
  if (status.error)
    return `Could not start qa batch: ${status.error}`
  if (lsfKilled(status.report))
    return `LSF: ${lsfReason(status.report)}. ${lsfHint(status.report) ?? ''}`.trim()
  if (submission.runner === 'lsf' && submission.status === 'failed')
    return "Could not submit the job to LSF."
  if (status.exit_code !== null && status.exit_code !== undefined)
    return `qa batch exited with code ${status.exit_code}.`
  return 'qa batch failed.'
}

const waitingHint = submission => submission.runner === 'lsf'
  ? "LSF hasn't started the job yet. The cluster may be busy."
  : "qa batch hasn't written logs yet."

const lsfJob = submission => submission.lsf_job_id ? `LSF job ${submission.lsf_job_id}${submission.queue ? ` (${submission.queue})` : ''}` : null


const copy = text => navigator.clipboard?.writeText(text).then(
  () => toaster.show({ message: 'Copied', icon: 'tick', intent: Intent.SUCCESS, timeout: 1500 }),
)


/**
 * A batch started from QA-Board: the status of `qa batch`, and its logs.
 */
const SubmissionRow = ({ submission, expanded, onToggle }) => {
  const status = useSubmissionStatus(submission)
  const [file, setFile] = useState('log.txt')
  const base = submission.log_dir_url
  const files = [
    { name: 'log.txt', url: `${base}/log.txt` },
    ...(submission.runner === 'lsf' ? [{ name: 'log.lsf.txt', url: `${base}/log.lsf.txt` }] : []),
  ]
  const failed = status.state === 'failed'
  const toggle = event => {
    if (event?.target?.closest?.(INTERACTIVE)) return
    onToggle()
  }

  return <div>
    <Header onClick={toggle} $expanded={expanded} $failed={failed}>
      <Button
        size="small"
        variant="minimal"
        icon={expanded ? "chevron-down" : "chevron-right"}
        aria-label={expanded ? "Hide the logs" : "Show the logs"}
        aria-expanded={expanded}
        onClick={() => onToggle()}
      />
      <StateTag state={status.state} />
      <Meta>
        <strong>qa batch</strong>
        <span className={Classes.TEXT_MUTED}>
          {[
            submission.user && `by ${submission.user}`,
            relative(submission.created_at),
            lsfJob(submission),
          ].filter(Boolean).map((text, index) => <React.Fragment key={index}>
            {index > 0 && ' · '}
            {index === 1 ? <Tooltip content={absolute(submission.created_at)}>{text}</Tooltip> : text}
          </React.Fragment>)}
        </span>
      </Meta>
    </Header>
    <Collapse isOpen={expanded} transitionDuration={150}>
      <Content $failed={failed}>
        {failed && (lsfKilled(status.report)
          ? <LsfReport report={status.report} />
          : <Callout compact intent={Intent.DANGER} icon="error" title={withCode(failureSummary(submission, status))} style={{ marginBottom: 8 }}>
              {!!status.last_error && <LastError>{status.last_error}</LastError>}
            </Callout>
        )}
        {!!submission.command && <Command className={Classes.MONOSPACE_TEXT}>
          <code>{submission.command}</code>
          <Tooltip content="Copy the command">
            <Button size="small" variant="minimal" icon="duplicate" aria-label="Copy the command" onClick={() => copy(submission.command)} />
          </Tooltip>
        </Command>}
        {base
          ? <LogViewer files={files} file={file} onFileChange={setFile} live={!is_final(status.state)} waitingHint={waitingHint(submission)} />
          : <span className={Classes.TEXT_MUTED}>No logs.</span>}
      </Content>
    </Collapse>
  </div>
}


const SHOWN = 3

/**
 * The batches started from QA-Board, most recent first.
 * If the batch has no runs yet, we open the most recent: it's likely why.
 */
export const BatchSubmissions = ({ batch, has_runs }) => {
  const submissions = batchSubmissions(batch)
  const [expanded, setExpanded] = useState(() => new Set(!has_runs && submissions.length ? [submissions[0].id] : []))
  const [show_all, setShowAll] = useState(false)
  if (!submissions.length) return null

  const toggle = id => setExpanded(expanded => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const shown = show_all ? submissions : submissions.slice(0, SHOWN)
  return <div style={{ marginBottom: 24 }}>
    <h3 className={Classes.HEADING}>Started from QA-Board</h3>
    <RunList>
      {shown.map(submission => <SubmissionRow
        key={submission.id}
        submission={submission}
        expanded={expanded.has(submission.id)}
        onToggle={() => toggle(submission.id)}
      />)}
    </RunList>
    {submissions.length > SHOWN && <Button style={{ marginTop: 6 }} size="small" variant="minimal" onClick={() => setShowAll(!show_all)}>
      {show_all ? 'Show less' : `Show ${submissions.length - SHOWN} older`}
    </Button>}
  </div>
}


/**
 * Tells users how the batch they started from QA-Board is doing, when they can't see it from its runs:
 * `qa batch` is waiting for LSF, running, failed, or didn't start any run.
 */
const LatestSubmissionCallout = ({ submission, has_runs, project, dispatch, onFinished }) => {
  const status = useSubmissionStatus(submission)
  const previous = useRef(status.state)
  useEffect(() => {
    if (!is_final(previous.current) && is_final(status.state))
      onFinished?.()
    previous.current = status.state
  }, [status.state, onFinished])

  const show_logs = <Button
    size="small"
    icon="console"
    onClick={() => dispatch(updateSelected(project, { selected_views: 'logs' }))}
  >
    Show the logs
  </Button>
  const when = <Tooltip content={absolute(submission.created_at)}>{relative(submission.created_at)}</Tooltip>
  const job = lsfJob(submission)

  if (status.state === 'failed')
    return <Callout intent={Intent.DANGER} icon="error" title="The batch you started from QA-Board failed">
      <p>{withCode(failureSummary(submission, status))}</p>
      {!!status.last_error && <p><LastError>{status.last_error}</LastError></p>}
      <p className={Classes.TEXT_MUTED}>Started {when}{submission.user ? ` by ${submission.user}` : ''}{job ? ` · ${job}` : ''}</p>
      {show_logs}
    </Callout>
  if (has_runs)
    return null
  if (status.state === 'queued')
    return <Callout intent={Intent.WARNING} icon="time" title="Your batch is waiting for LSF">
      <p><code className={Classes.CODE}>qa batch</code> was submitted {when}{job ? ` as ${job}` : ''}, but LSF didn't start it yet. The cluster may be busy.</p>
      {show_logs}
    </Callout>
  if (status.state === 'running')
    return <Callout intent={Intent.PRIMARY} icon={<Spinner size={16} />} title="Starting your batch…">
      <p><code className={Classes.CODE}>qa batch</code> started {when}. Its runs will show up here.</p>
      {show_logs}
    </Callout>
  return <Callout intent={Intent.WARNING} icon="warning-sign" title="qa batch didn't start any run">
    <p>It finished {when}. Maybe there were no inputs, or all the runs already existed.</p>
    {show_logs}
  </Callout>
}

export const SubmissionCallout = ({ batch, has_runs, project, dispatch, onFinished }) => {
  const [latest] = batchSubmissions(batch)
  if (!latest) return null
  return <LatestSubmissionCallout key={latest.id} submission={latest} has_runs={has_runs} project={project} dispatch={dispatch} onFinished={onFinished} />
}
