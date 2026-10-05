import React, { useMemo, useState } from "react";
import styled from "styled-components";
import { DateTime } from 'luxon';
import {
  AnchorButton,
  Button,
  Classes,
  Colors,
  Icon,
  Intent,
  NonIdealState,
  SegmentedControl,
  Tooltip,
} from "@blueprintjs/core";

import { pretty_label } from '../utils'
import { toaster } from "../toaster";
import { RunList, RunLogs } from './logs/RunLogs'


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
  .meta > span {
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

const copy = text => navigator.clipboard?.writeText(text).then(
  () => toaster.show({ message: 'Copied', icon: 'tick', intent: Intent.SUCCESS, timeout: 1500 }),
)

const BatchCommand = ({ command }) => {
  const created_at = DateTime.fromISO(command.command_created_at_datetime, { zone: 'utc' })
  const text = command.argv.join(" ")
  return <Command>
    <div className={`meta ${Classes.TEXT_MUTED}`}>
      <span>
        <Icon icon="time" size={12} />
        <Tooltip content={created_at.toLocal().toLocaleString(DateTime.DATETIME_FULL)}>{created_at.toRelative()}</Tooltip>
      </span>
      {!!command.user && <span><Icon icon="user" size={12} />{command.user}</span>}
      {!!command.HOST && <span><Icon icon="desktop" size={12} />{command.HOST}</span>}
      <span className="spacer" />
      {!!command.job_url && <AnchorButton size="small" variant="minimal" icon="share" href={command.job_url} target="_blank" rel="noopener noreferrer">
        CI job
      </AnchorButton>}
    </div>
    <pre className={`command ${Classes.MONOSPACE_TEXT}`}>
      <code>{text}</code>
      <Tooltip content="Copy the command">
        <Button size="small" variant="minimal" icon="duplicate" aria-label="Copy the command" onClick={() => copy(text)} />
      </Tooltip>
    </pre>
  </Command>
}


/**
 * The logs of all the runs in a batch, and of the commands that started it.
 */
export const BatchLogs = ({ batch, project, commit, dispatch }) => {
  const [filter, setFilter] = useState('all')
  const [expanded, setExpanded] = useState(() => new Set())
  const [limit, setLimit] = useState(PAGE_SIZE)

  const outputs = useMemo(() => (batch?.filtered?.outputs ?? [])
    .map(id => batch.outputs[id])
    .filter(output => !!output && output.output_type !== "optim_iteration"),
  [batch])
  const failed = useMemo(() => outputs.filter(output => output.is_failed), [outputs])
  const pending = useMemo(() => outputs.filter(output => output.is_pending), [outputs])

  if (batch === null || batch === undefined || batch.batch_dir_url === undefined)
    return null

  const shown = filter === 'failed' ? failed : (filter === 'pending' ? pending : outputs)
  const toggle = id => setExpanded(expanded => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const commands = Object.values(batch.data?.commands ?? {})
  const has_tuning_commands = batch.data?.optimization ?? commands.some(c => !c.job_url)
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
    <ListToolbar>
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
    </ListToolbar>

    {shown.length > 0
      ? <RunList>
          {shown.slice(0, limit).map(output => <RunLogs
            key={output.id}
            output={output}
            project={project}
            commit={commit}
            dispatch={dispatch}
            expanded={expanded.has(output.id)}
            onToggle={() => toggle(output.id)}
          />)}
        </RunList>
      : <NonIdealState
          icon={filter === 'failed' ? "tick-circle" : "search"}
          title={filter === 'failed' ? "No failed runs" : (filter === 'pending' ? "No running runs" : "No runs")}
          layout="horizontal"
        />
    }
    {shown.length > limit && <Button style={{ marginTop: 8 }} variant="outlined" fill onClick={() => setLimit(limit => limit + PAGE_SIZE)}>
      Show {Math.min(PAGE_SIZE, shown.length - limit)} more ({(shown.length - limit).toLocaleString()} hidden)
    </Button>}

    <h3 className={Classes.HEADING} style={{ marginTop: 28 }}>Batch: {pretty_label(batch)}</h3>
    {has_tuning_commands && <RunList style={{ marginBottom: 12 }}>
      <RunLogs
        output={batch_output}
        project={project}
        commit={commit}
        dispatch={dispatch}
        title="Batch logs"
        expanded={expanded.has('batch')}
        onToggle={() => toggle('batch')}
      />
    </RunList>}
    {commands.length > 0 && <RunList>
      {commands.map((command, index) => <BatchCommand key={index} command={command} />)}
    </RunList>}
  </>
}
