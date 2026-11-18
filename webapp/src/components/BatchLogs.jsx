import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import {
  Button,
  Classes,
  NonIdealState,
  SegmentedControl,
} from "@blueprintjs/core";

import { RunList, RunLogs } from './logs/RunLogs'
import { BatchCommands, batchEntries } from './logs/BatchCommands'
import { BatchesComparison } from './logs/BatchesComparison'
import { DirectoryActions } from './logs/DirectoryActions'
import { fileExists } from './logs/fetchRange'

// where it was defined before
export { commandLogs } from './logs/BatchCommands'


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
  .spacer {
    flex: 1;
  }
`

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
// `ref_batch`: the reference batch, to compare the batches they ran
export const BatchLogs = ({ batch, ref_batch, project, commit, available_tests_files, repo_file_url }) => {
  const [filter, setFilter] = useState('all')
  const [expanded, setExpanded] = useState(() => new Set())
  const [limit, setLimit] = useState(PAGE_SIZE)
  const batch_log_ref = useRef(null)
  // Before 2026-10, batches started from QA-Board logged in the batch directory
  const batch_log = useFileExists(batch?.batch_dir_url ? `${batch.batch_dir_url}/log.txt` : null)

  const outputs = useMemo(() => (batch?.filtered?.outputs ?? [])
    .map(id => batch.outputs[id])
    .filter(output => !!output && output.output_type !== "optim_iteration"),
  [batch])
  const failed = useMemo(() => outputs.filter(output => output.is_failed), [outputs])
  const pending = useMemo(() => outputs.filter(output => output.is_pending), [outputs])
  const successful = useMemo(() => outputs.filter(o => !o.is_failed && !o.is_pending && !o.is_running), [outputs])
  const toggle = useCallback(id => setExpanded(expanded => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])

  if (batch === null || batch === undefined || batch.batch_dir_url === undefined)
    return null

  const shown = { failed, pending, successful }[filter] ?? outputs
  const has_runs = Object.keys(batch.outputs ?? {}).length > 0
  const has_batch_log = batch_log === true || batch_log === 'error'
  const n_commands = batchEntries(batch).length
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
    <SectionHeading style={{ marginTop: 0 }}>
      <h3 className={Classes.HEADING}>Commands</h3>
      <span className={Classes.TEXT_MUTED} style={{ fontSize: 13 }}>
        {n_commands ? 'how the batch was started, most recent first' : null}
      </span>
      <span className="spacer" />
      {!!batch.batch_dir_url && <DirectoryActions url={batch.batch_dir_url} what="the batch directory" />}
    </SectionHeading>
    <BatchesComparison key={`compare-${batch.id}-${ref_batch?.id}`} batch={batch} ref_batch={ref_batch} />
    <BatchCommands
      key={batch.id}
      batch={batch}
      project={project}
      commit={commit}
      has_runs={has_runs}
      has_pending_runs={has_pending_runs}
      has_batch_log={has_batch_log}
      onShowBatchLog={showBatchLog}
      available_tests_files={available_tests_files}
      repo_file_url={repo_file_url}
    />
    {!n_commands && !has_batch_log && batch_log !== null && <p className={Classes.TEXT_MUTED}>
      No <code className={Classes.CODE}>qa batch</code> command was saved for this batch.
    </p>}
    {has_batch_log && <RunList ref={batch_log_ref} style={{ marginTop: 8, scrollMarginTop: 16 }}>
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

    <SectionHeading>
      <h3 className={Classes.HEADING}>Runs</h3>
    </SectionHeading>
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
          { value: 'successful', label: `Successful · ${successful.length}`, disabled: !successful.length && filter !== 'successful' },
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
          icon={filter === 'failed' ? "tick-circle" : (filter === 'successful' ? "endorsed" : "search")}
          title={filter === 'failed' ? "No failed runs" : (filter === 'pending' ? "No running runs" : (filter === 'successful' ? "No successful runs" : ((batch.filtered?.outputs?.length ?? 0) < Object.keys(batch.outputs ?? {}).length ? "No run matches the filter" : "No runs yet")))}
          layout="horizontal"
        />
    }
    {shown.length > limit && <Button style={{ marginTop: 8 }} variant="outlined" fill onClick={() => setLimit(limit => limit + PAGE_SIZE)}>
      Show {Math.min(PAGE_SIZE, shown.length - limit)} more ({(shown.length - limit).toLocaleString()} hidden)
    </Button>}
  </>
}
