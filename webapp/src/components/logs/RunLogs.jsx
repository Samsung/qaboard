import React, { memo, useEffect, useMemo, useState } from "react";
import styled from "styled-components";
import { useInView } from "react-intersection-observer";
import { Button, Classes, Collapse, Colors } from "@blueprintjs/core";

import { ConfigurationsTags, PlatformTag, RunBadges, RunMenuButton, StatusTag } from "../tags";
import { configurationSummary } from "../../configurations/tokens";
import { RunName } from "../runNames";
import { LogViewer } from "./LogViewer";
import { LsfReport, LsfTag } from "./LsfReport";
import { fetchLsfReport, lsfKilled } from "./lsf";
import { fileExists } from "./fetchRange";
import { DirectoryActions } from "./DirectoryActions";
import { runTime } from "../RunInfoMenu";
import { attemptLogs } from "../../utils/attempts";


// A list of runs, each with its logs
export const RunList = styled.div`
  border: 1px solid ${Colors.LIGHT_GRAY1};
  border-radius: 4px;
  background: ${Colors.WHITE};
  .${Classes.DARK} & {
    border-color: ${Colors.DARK_GRAY5};
    background: ${Colors.DARK_GRAY2};
  }
  & > * + * {
    border-top: 1px solid ${Colors.LIGHT_GRAY2};
    .${Classes.DARK} & {
      border-top-color: ${Colors.DARK_GRAY5};
    }
  }
`

// One line, whatever the run: lists don't move when runs load, and stay as wide as the page
export const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  /* long names and configurations are truncated, they don't make the page wider */
  contain: inline-size;
  min-height: 38px;
  padding: 3px 6px 3px 4px;
  cursor: pointer;
  background: ${props => props.$expanded ? Colors.LIGHT_GRAY5 : 'transparent'};
  border-left: 3px solid ${props => props.$failed ? Colors.RED3 : 'transparent'};
  &:hover {
    background: ${Colors.LIGHT_GRAY5};
  }
  .${Classes.DARK} & {
    background: ${props => props.$expanded ? Colors.DARK_GRAY3 : 'transparent'};
    &:hover {
      background: ${Colors.DARK_GRAY3};
    }
  }
  & > .${Classes.BUTTON}, & > .${Classes.TAG}, & > .${Classes.POPOVER_TARGET}:not(.run-name-target) {
    flex: none;
  }
  h5 {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .run-name-target {
    flex: 0 1 auto;
    min-width: 0;
    max-width: ${props => props.$summary ? '65%' : 'none'};
    font-weight: 500;
  }
  .summary {
    flex: 1 1 0;
    min-width: 0;
    font-size: 12px;
  }
  .runtime {
    flex: none;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .run-name-target, .summary {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .actions {
    display: flex;
    margin-left: auto;
  }
`

export const Content = styled.div`
  padding: 10px 12px 12px 12px;
  border-left: 3px solid ${props => props.$failed ? Colors.RED3 : 'transparent'};
`

const Details = styled.div`
  contain: inline-size;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 0;
  margin-bottom: 8px;
  max-width: 1400px;
  font-size: 12px;
  .label {
    margin-right: 8px;
  }
  .input {
    margin-right: 12px;
    overflow-wrap: anywhere;
  }
`

// Don't toggle the logs when users click links, buttons, tags... Clicking the run's name does: hovering it shows what we know about the run
export const INTERACTIVE = `a, button, input, [role="button"], .${Classes.POPOVER_TARGET}:not(.run-name-target)`

// how the run is configured, as one line of text
export { configurationSummary }


// the input's full path, in its database
const input_path = output => output.test_input_database
  ? `${output.test_input_database.replace(/\/+$/, '')}/${output.test_input_path}`
  : output.test_input_path

// The configuration as tags (to copy it), with the batch and the full input path
const RunDetails = ({ output }) => {
  const has_configurations = (output.configurations ?? []).length > 0 || Object.keys(output.extra_parameters ?? {}).length > 0
  const has_badges = (output.params?.badges ?? []).length > 0
  return <Details>
    <span className={`input ${Classes.TEXT_MUTED}`}>
      {!!output.data?.batch && <span title="Batch">{output.data.batch} › </span>}
      <span title="Input path">{input_path(output)}</span>
    </span>
    {has_configurations && <span className={`label ${Classes.TEXT_MUTED}`}>Configuration</span>}
    <PlatformTag platform={output.platform} />
    {has_configurations && <ConfigurationsTags configurations={output.configurations ?? []} tuning={output.extra_parameters} collapse={false} />}
    {has_badges && <RunBadges output={output} />}
  </Details>
}


// Logs of some runners, next to log.txt: Dask's (log.dask.txt), the run's output from its Kubernetes pod (log.k8s.txt),
// and why its pod, or the --no-wait driver's, is pending (log.pending.txt)
const OTHER_LOGS = ['log.dask.txt', 'log.k8s.txt', 'log.pending.txt']


// Why a finished run has no log
const emptyHints = output => ({
  "log.txt": output.deleted ? "The run's output files were deleted." : "The run may have failed before it started, or its files were deleted.",
  "log.lsf.txt": "Only runs on LSF have it.",
  ...Object.fromEntries(attemptLogs(output).map(({ name }) => [name, "This attempt's log was deleted with the run's files."])),
})


/**
 * One run, and when expanded, its logs. `onToggle(id)` expands or collapses it.
 * Failed runs show why LSF ended them as soon as they're on screen.
 * Lists can have 100s of runs: keep props stable, so that toggling a run doesn't render the others,
 * and keep the header light: plain text, the same as soon as it renders.
 */
export const RunLogs = memo(function RunLogs({ id, output, project, commit, expanded, onToggle, title }) {
  const { ref, inView } = useInView({ triggerOnce: true, rootMargin: '300px 0px' })
  const [lsf, setLsf] = useState({ status: 'unknown', report: null })
  const [other_logs, setOtherLogs] = useState([])
  const [file, setFile] = useState('log.txt')
  const base = output.output_dir_url
  const is_pending = !!output.is_pending
  const is_batch = output.output_type === "batch"
  const summary = useMemo(() => is_batch ? '' : configurationSummary(output), [is_batch, output])
  const runtime = is_batch ? null : runTime(output)

  // Is there a log.lsf.txt? For failed runs, what does LSF's report say?
  // We don't care about LSF's report for runs that didn't fail: lists can have 100s of them.
  const is_failed = !!output.is_failed && !is_pending
  const wants_lsf = !!base && (expanded || (inView && is_failed))
  useEffect(() => {
    if (!wants_lsf) return
    const controller = new AbortController()
    const url = `${base}/log.lsf.txt`
    const check = is_failed
      ? fetchLsfReport(url, { signal: controller.signal }).then(report => ({ status: 'present', report }))
      : fileExists(url, { signal: controller.signal }).then(exists => ({ status: exists ? 'present' : 'missing', report: null }))
    check
      .then(setLsf)
      .catch(error => {
        if (!controller.signal.aborted)
          setLsf(lsf => error.status === 404 ? { status: 'missing', report: null } : lsf)
      })
    return () => controller.abort()
  }, [wants_lsf, base, is_failed])

  // LSF jobs create log.lsf.txt when they start
  useEffect(() => {
    if (!expanded || !is_pending || lsf.status !== 'missing') return
    const timer = setTimeout(() => setLsf({ status: 'unknown', report: null }), 10000)
    return () => clearTimeout(timer)
  }, [expanded, is_pending, lsf.status])

  // The dask and kubernetes runners save logs too
  useEffect(() => {
    if (!expanded || !base) return
    const controller = new AbortController()
    Promise.all(OTHER_LOGS.map(name => fileExists(`${base}/${name}`, { signal: controller.signal }).catch(() => false)))
      .then(exists => { if (!controller.signal.aborted) setOtherLogs(OTHER_LOGS.filter((_, index) => exists[index])) })
    return () => controller.abort()
  }, [expanded, base])

  const files = [
    { name: 'log.txt', url: `${base}/log.txt` },
    ...(lsf.status === 'present' ? [{ name: 'log.lsf.txt', url: `${base}/log.lsf.txt` }] : []),
    ...other_logs.map(name => ({ name, url: `${base}/${name}` })),
    // the run was done again: the logs of its earlier attempts, the latest first
    ...attemptLogs(output).map(({ name }) => ({ name, url: `${base}/${name}` })),
  ]

  const toggle = event => {
    if (event?.target?.closest?.(INTERACTIVE)) return
    onToggle(id)
  }
  const showLsfLog = () => {
    setFile('log.lsf.txt')
    if (!expanded) onToggle(id)
  }

  return <div ref={ref}>
    <Header onClick={toggle} $expanded={expanded} $failed={!!output.is_failed} $summary={!!summary}>
      <Button
        size="small"
        variant="minimal"
        icon={expanded ? "chevron-down" : "chevron-right"}
        aria-label={expanded ? "Hide the logs" : "Show the logs"}
        aria-expanded={expanded}
        onClick={() => onToggle(id)}
      />
      {!is_batch && <StatusTag output={output} />}
      {title
        ? <h5 className={Classes.HEADING}>{title}</h5>
        : <RunName output={output} project={project} commit={commit} />
      }
      <LsfTag report={lsf.report} onClick={showLsfLog} />
      {summary
        ? <span className={`summary ${Classes.TEXT_MUTED}`} title={summary}>{summary}</span>
        : <span className="summary" />}
      {!!runtime && <span className={`runtime ${Classes.TEXT_MUTED}`} title="Compute time">{runtime}</span>}
      <span className="actions">
        {/* the batch's section has them */}
        {!!base && !is_batch && <DirectoryActions url={base} />}
        {!is_batch && !!output.id && <RunMenuButton output={output} project={project} commit={commit} />}
      </span>
    </Header>
    <Collapse isOpen={expanded} transitionDuration={150}>
      <Content $failed={!!output.is_failed}>
        {lsfKilled(lsf.report) && <LsfReport report={lsf.report} />}
        {!is_batch && <RunDetails output={output} />}
        <LogViewer
          files={files}
          file={file}
          onFileChange={setFile}
          live={is_pending}
          emptyHint={emptyHints(output)}
        />
      </Content>
    </Collapse>
  </div>
})
