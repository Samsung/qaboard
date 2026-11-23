// Did the batches change? Compares the batches two commands ran (their snapshots), e.g. with the reference batch's
import React, { useState } from "react";
import styled from "styled-components";
import { Button, Classes, Colors, HTMLSelect, Icon, Intent, SegmentedControl, Spinner, Tag } from "@blueprintjs/core";

import { MonacoDiffEditor } from "../MonacoEditor";
import { useSnapshotYaml } from "./RunAgain";
import { batchesChanges, changesSummary, snapshotBody, snapshotOptions } from "./batchesDiff";


const Panel = styled.div`
  margin: 0 0 10px 0;
  padding: 6px 10px;
  border: 1px solid ${Colors.LIGHT_GRAY1};
  border-radius: 4px;
  font-size: 13px;
  .${Classes.DARK} & {
    border-color: ${Colors.DARK_GRAY5};
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
  }
  .spacer {
    flex: 1;
  }
  select {
    max-width: 420px;
  }
`


/**
 * Compares the batches the commands of a batch ran, with each other or with those of the reference batch.
 * Shows nothing until there are two to compare. The default: the latest of this batch, with the latest of the
 * reference batch, else the previous command of this batch.
 */
export const BatchesComparison = ({ batch, ref_batch }) => {
  const mine = snapshotOptions(batch, 'This batch')
  const reference = ref_batch && ref_batch.id !== batch?.id ? snapshotOptions(ref_batch, 'Reference') : []
  const options = [...mine, ...reference]
  const [after_key, setAfter] = useState(null)
  const [before_key, setBefore] = useState(null)
  const [open, setOpen] = useState(false)
  const [side_by_side, setSideBySide] = useState(true)

  const after = options.find(o => o.key === after_key) ?? mine[0]
  const default_before = reference[0] ?? mine[1]
  const before = options.find(o => o.key === before_key) ?? (default_before?.key !== after?.key ? default_before : options.find(o => o.key !== after?.key))
  const after_yaml = useSnapshotYaml(after?.snapshot, !!after)
  const before_yaml = useSnapshotYaml(before?.snapshot, !!before)
  if (!after || !before) return null

  const loading = after_yaml.loading || before_yaml.loading
  const error = after_yaml.error || before_yaml.error
  const ready = !loading && !error && after_yaml.yaml !== null && before_yaml.yaml !== null
  const changes = ready ? batchesChanges(snapshotBody(before_yaml.yaml), snapshotBody(after_yaml.yaml)) : null
  const select = (value, onChange, label) => <HTMLSelect
    minimal
    aria-label={label}
    value={value}
    onChange={event => onChange(event.target.value)}
    options={options.map(o => ({ value: o.key, label: o.label }))}
  />

  return <Panel aria-label="Compare the batches">
    <div className="bar">
      <Icon icon="comparison" />
      <span>Batches that ran:</span>
      {select(after.key, setAfter, 'Compare')}
      <span className={Classes.TEXT_MUTED}>vs</span>
      {select(before.key, setBefore, 'With')}
      <span className="spacer" />
      {loading && <Spinner size={14} />}
      {!!error && <span className={Classes.TEXT_MUTED}>Could not read the batches: {error}</span>}
      {!!changes && (changes.same
        ? <Tag minimal intent={Intent.SUCCESS} icon="tick">Same batches</Tag>
        : <Tag minimal intent={Intent.WARNING} icon="changes">{changesSummary(changes)}</Tag>)}
      {ready && !changes?.same && <Button size="small" variant="minimal" icon={open ? "chevron-up" : "eye-open"} onClick={() => setOpen(!open)}>
        {open ? 'Hide the changes' : 'Show the changes'}
      </Button>}
    </div>
    {open && ready && !changes.same && <div style={{ marginTop: 8 }}>
      <div className="bar" style={{ marginBottom: 6 }}>
        <span className={Classes.TEXT_MUTED}>Left: {before.label}. Right: {after.label}.</span>
        <span className="spacer" />
        <SegmentedControl
          size="small"
          value={side_by_side ? 'split' : 'inline'}
          onValueChange={value => setSideBySide(value === 'split')}
          options={[{ value: 'split', label: 'Side by side' }, { value: 'inline', label: 'Inline' }]}
        />
      </div>
      <MonacoDiffEditor
        height="360px"
        language="yaml"
        original={snapshotBody(before_yaml.yaml)}
        value={snapshotBody(after_yaml.yaml)}
        options={{ readOnly: true, renderSideBySide: side_by_side, minimap: { enabled: false }, scrollBeyondLastLine: false, renderOverviewRuler: false }}
      />
    </div>}
  </Panel>
}
