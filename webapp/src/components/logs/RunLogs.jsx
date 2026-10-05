import React, { useEffect, useState } from "react";
import styled from "styled-components";
import { useInView } from "react-intersection-observer";
import { Button, Classes, Collapse, Colors } from "@blueprintjs/core";

import { StatusTag } from "../tags";
import { OutputHeader } from "../../viewers/OutputCard";
import { LogViewer } from "./LogViewer";
import { LsfReport, LsfTag } from "./LsfReport";
import { fetchLsfReport } from "./lsf";
import { fetchRange } from "./fetchRange";


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

const Header = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  min-height: 38px;
  padding: 3px 10px 3px 4px;
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
  h5 {
    flex: 1 1 280px;
    min-width: 0;
    margin: 0;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
`

const Content = styled.div`
  padding: 10px 12px 12px 12px;
  border-left: 3px solid ${props => props.$failed ? Colors.RED3 : 'transparent'};
`

// Don't toggle the logs when users click links, buttons, tags...
const INTERACTIVE = `a, button, input, [role="button"], .${Classes.POPOVER_TARGET}`

const EMPTY_HINTS = {
  "log.lsf.txt": "Only runs on LSF have it.",
}


/**
 * One run, and when expanded, its logs.
 * Failed runs show why LSF ended them as soon as they're on screen.
 */
export const RunLogs = ({ output, project, commit, dispatch, expanded, onToggle, title }) => {
  const { ref, inView } = useInView({ triggerOnce: true, rootMargin: '300px 0px' })
  const [lsf, setLsf] = useState({ status: 'unknown', report: null })
  const [has_dask_log, setHasDaskLog] = useState(false)
  const [file, setFile] = useState('log.txt')
  const base = output.output_dir_url
  const is_pending = !!output.is_pending

  // Is there a log.lsf.txt? Once the run is over, what does LSF's report say?
  const wants_lsf = !!base && (expanded || (inView && !!output.is_failed && !is_pending))
  useEffect(() => {
    if (!wants_lsf) return
    const controller = new AbortController()
    const url = `${base}/log.lsf.txt`
    const check = is_pending
      ? fetchRange(url, 'bytes=0-0', { signal: controller.signal }).then(() => null)
      : fetchLsfReport(url, { signal: controller.signal })
    check
      .then(report => setLsf({ status: 'present', report }))
      .catch(error => {
        if (!controller.signal.aborted)
          setLsf(lsf => error.status === 404 ? { status: 'missing', report: null } : lsf)
      })
    return () => controller.abort()
  }, [wants_lsf, base, is_pending])

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
    onToggle()
  }
  const showLsfLog = () => {
    setFile('log.lsf.txt')
    if (!expanded) onToggle()
  }

  return <div ref={ref}>
    <Header onClick={toggle} $expanded={expanded} $failed={!!output.is_failed}>
      <Button
        size="small"
        variant="minimal"
        icon={expanded ? "chevron-down" : "chevron-right"}
        aria-label={expanded ? "Hide the logs" : "Show the logs"}
        aria-expanded={expanded}
        onClick={() => onToggle()}
      />
      {output.output_type !== "batch" && <StatusTag output={output} />}
      <LsfTag report={lsf.report} onClick={showLsfLog} />
      {title
        ? <h5 className={Classes.HEADING}>{title}</h5>
        : <OutputHeader
            project={project}
            commit={commit}
            output={output}
            mismatch={output.reference_mismatch}
            dispatch={dispatch}
            tags_first
            viewable={inView}
          />
      }
    </Header>
    <Collapse isOpen={expanded} transitionDuration={150}>
      <Content $failed={!!output.is_failed}>
        <LsfReport report={lsf.report} />
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
}
