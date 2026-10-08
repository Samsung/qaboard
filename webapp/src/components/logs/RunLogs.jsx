import React, { memo, useEffect, useMemo, useState } from "react";
import styled from "styled-components";
import { useInView } from "react-intersection-observer";
import { AnchorButton, Button, Classes, Collapse, Colors, PopoverNext, Tooltip } from "@blueprintjs/core";

import { hidden_keys, ConfigurationsTags, ExtraParametersTags, PlatformTag, RunActionsMenu, RunBadges, StatusTag } from "../tags";
import { LogViewer } from "./LogViewer";
import { LsfReport, LsfTag } from "./LsfReport";
import { fetchLsfReport, lsfKilled } from "./lsf";
import { fetchRange } from "./fetchRange";
import { folder_url } from "../../utils/paths";


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
  & > .${Classes.BUTTON}, & > .${Classes.TAG}, & > .${Classes.POPOVER_TARGET} {
    flex: none;
  }
  h5 {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .name {
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
  .name, .summary {
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

// Don't toggle the logs when users click links, buttons, tags...
export const INTERACTIVE = `a, button, input, [role="button"], .${Classes.POPOVER_TARGET}`

// How the run is named elsewhere in QA-Board
export const runName = output => {
  if (output.test_input_metadata?.label) return output.test_input_metadata.label
  if (output.output_type === "pipeline" || output.test_input_path === "PIPELINE") return `${output.data?.batch} (pipeline)`
  return `${output.test_input_database === '/' ? '/' : ''}${output.test_input_path}`
}

// "base · config.yaml · isp: {...} · lr=0.1": how the run is configured, as one line of text.
// Rendering the configurations as tags is slow and wide when lists have 100s of runs.
export const configurationSummary = output => {
  const parts = []
  if (output.platform && output.platform !== 'linux') parts.push(`@${output.platform}`)
  for (const configuration of output.configurations ?? []) {
    if (typeof configuration === 'string') parts.push(configuration)
    else if (configuration && typeof configuration === 'object')
      for (const [key, value] of Object.entries(configuration))
        if (!hidden_keys.includes(key)) parts.push(`${key}: ${JSON.stringify(value)}`)
  }
  for (const [key, value] of Object.entries(output.extra_parameters ?? {}))
    if (!hidden_keys.includes(key)) parts.push(`${key}=${JSON.stringify(value)}`)
  return parts.join(' · ')
}


// The configuration as tags (to copy it), with the full input path
const RunDetails = ({ output }) => {
  const has_configurations = (output.configurations ?? []).length > 0 || Object.keys(output.extra_parameters ?? {}).length > 0
  const has_badges = (output.params?.badges ?? []).length > 0
  return <Details>
    <span className={`input ${Classes.TEXT_MUTED}`}>{output.test_input_path}</span>
    {has_configurations && <span className={`label ${Classes.TEXT_MUTED}`}>Configuration</span>}
    <PlatformTag platform={output.platform} />
    {has_configurations && <ConfigurationsTags configurations={output.configurations ?? []} />}
    <ExtraParametersTags parameters={output.extra_parameters ?? {}} />
    {has_badges && <RunBadges output={output} />}
  </Details>
}


const EMPTY_HINTS = {
  "log.lsf.txt": "Only runs on LSF have it.",
}


/**
 * One run, and when expanded, its logs. `onToggle(id)` expands or collapses it.
 * Failed runs show why LSF ended them as soon as they're on screen.
 * Lists can have 100s of runs: keep props stable, so that toggling a run doesn't render the others,
 * and keep the header light: plain text, the same as soon as it renders.
 */
export const RunLogs = memo(function RunLogs({ id, output, project, commit, dispatch, expanded, onToggle, title }) {
  const { ref, inView } = useInView({ triggerOnce: true, rootMargin: '300px 0px' })
  const [lsf, setLsf] = useState({ status: 'unknown', report: null })
  const [has_dask_log, setHasDaskLog] = useState(false)
  const [file, setFile] = useState('log.txt')
  const base = output.output_dir_url
  const is_pending = !!output.is_pending
  const is_batch = output.output_type === "batch"
  const summary = useMemo(() => is_batch ? '' : configurationSummary(output), [is_batch, output])

  // Is there a log.lsf.txt? For failed runs, what does LSF's report say?
  // We don't care about LSF's report for runs that didn't fail: lists can have 100s of them.
  const is_failed = !!output.is_failed && !is_pending
  const wants_lsf = !!base && (expanded || (inView && is_failed))
  useEffect(() => {
    if (!wants_lsf) return
    const controller = new AbortController()
    const url = `${base}/log.lsf.txt`
    const check = is_failed
      ? fetchLsfReport(url, { signal: controller.signal })
      : fetchRange(url, 'bytes=0-0', { signal: controller.signal }).then(() => null)
    check
      .then(report => setLsf({ status: 'present', report }))
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

  // The dask runner saves logs too
  useEffect(() => {
    if (!expanded || !base) return
    const controller = new AbortController()
    fetchRange(`${base}/log.dask.txt`, 'bytes=0-0', { signal: controller.signal })
      .then(() => setHasDaskLog(true))
      .catch(() => {})
    return () => controller.abort()
  }, [expanded, base])

  const files = [
    { name: 'log.txt', url: `${base}/log.txt` },
    ...(lsf.status === 'present' ? [{ name: 'log.lsf.txt', url: `${base}/log.lsf.txt` }] : []),
    ...(has_dask_log ? [{ name: 'log.dask.txt', url: `${base}/log.dask.txt` }] : []),
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
        : <span className="name" title={output.test_input_path}>{runName(output)}</span>
      }
      <LsfTag report={lsf.report} onClick={showLsfLog} />
      {summary
        ? <span className={`summary ${Classes.TEXT_MUTED}`} title={summary}>{summary}</span>
        : <span className="summary" />}
      <span className="actions">
        {!!base && <Tooltip content="Open the output directory" hoverOpenDelay={300}>
          <AnchorButton size="small" variant="minimal" icon="folder-shared-open" aria-label="Open the output directory" href={folder_url(base)} target="_blank" rel="noopener noreferrer" />
        </Tooltip>}
        {!is_batch && !!output.id && <PopoverNext placement="bottom-end" content={<RunActionsMenu output={output} project={project} commit={commit} dispatch={dispatch} />}>
          <Button size="small" variant="minimal" icon="more" aria-label="Run actions" />
        </PopoverNext>}
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
          emptyHint={EMPTY_HINTS}
        />
      </Content>
    </Collapse>
  </div>
})
