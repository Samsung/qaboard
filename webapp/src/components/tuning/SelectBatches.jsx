import React, { useState, useMemo, useCallback } from "react";
import {
  Colors,
  MenuItem,
  Button,
  NonIdealState
} from "@blueprintjs/core";
import {
  Select,
} from "@blueprintjs/select";


import { pretty_label } from '../../utils'
import { has_milestones } from '../milestones'


const by_label = ([label1], [label2]) => {
  if (label1 === 'default')
    return -1;
  if (label2 === 'default')
    return 1;
  return label1.localeCompare(label2);
}

const prepare_batch = ({ label, batchData, commit_id, project, project_data }) => {
  const outputs = Object.values(batchData.outputs || {}).filter(o => o.output_type !== "optim_iteration")
  const data = batchData.data || {}
  const title = pretty_label(batchData)
  const is_milestone = has_milestones({ commit: { id: commit_id }, project, project_data, batch: { label } });

  const nb_success = outputs.filter(o => !o.is_pending && !o.is_failed).length;
  const nb_failed = outputs.filter(o => o.is_failed).length;
  const nb_running = outputs.filter(o => o.is_running).length;

  const commands = Object.values(data.commands || {});
  const username = commands[0]?.user ?? null;

  return {
    label,
    title: (is_milestone ? "⭐ " : "") + title,
    status: [
      `${nb_success}/${outputs.length} ✅`,
      nb_failed > 0 ? ` ${nb_failed}❌` : "",
      nb_running > 0 ? ` ${nb_running}🏃` : "",
      data.optimization ? ` ${data.iteration} 🔁` : "",
    ].join(''),
    username,
    // what the filter input matches
    searchText: [
      title,
      label,
      username ?? '',
      nb_failed > 0 ? 'failed fail error' : '',
      nb_running > 0 ? 'running' : '',
      nb_success > 0 ? 'success successful' : '',
      data.optimization ? 'optimization tuning' : '',
      data.type === 'local' ? 'local' : 'ci',
    ].join(' ').toLowerCase(),
  };
}

// Defined once: Blueprint's QueryList re-filters the items, resets the active item to the first one
// and scrolls to it whenever `items` or `itemPredicate` change identity. With new ones on each render,
// any re-render (of the navbar, of the page...) made the open menu jump back to the top, e.g. while scrolling.
const filterBatch = (query, batchItem) => batchItem.searchText.includes(query.trim().toLowerCase());

const popoverProps = { minimal: true };

const BatchLabel = ({ item }) => <>
  <div style={{ fontWeight: 500 }}>{item.title}</div>
  <div style={{ fontSize: '12px', color: Colors.GRAY1, marginTop: '2px' }}>{item.status}</div>
</>

const Username = ({ item, style }) => item.username
  ? <div style={{ fontSize: '11px', color: Colors.GRAY3, fontStyle: 'italic', ...style }}>{item.username}</div>
  : null


const SelectBatchesNav = ({ commit, onChange, batch, project, project_data }) => {
  const batches = commit?.batches;
  const commit_id = commit?.id;
  // Store updates (e.g. project data or commit re-fetched) give us new objects with the same content.
  // Comparing as JSON keeps the same items, to not reset the menu (see `filterBatch`).
  const batchItemsJson = useMemo(
    () => JSON.stringify(
      Object.entries(batches ?? {})
        .sort(by_label)
        .map(([label, batchData]) => prepare_batch({ label, batchData, commit_id, project, project_data }))
    ),
    [batches, commit_id, project, project_data],
  );
  const batchItems = useMemo(() => JSON.parse(batchItemsJson), [batchItemsJson]);
  const selectedBatch = useMemo(
    () => batchItems.find(item => item.label === batch.label) ?? null,
    [batchItems, batch.label],
  );

  // The item highlighted for keyboard navigation. It's controlled so that the menu opens on the selected batch.
  const [activeLabel, setActiveLabel] = useState(batch.label);
  const activeItem = useMemo(
    () => batchItems.find(item => item.label === activeLabel) ?? null,
    [batchItems, activeLabel],
  );
  const onOpening = useCallback(() => setActiveLabel(batch.label), [batch.label]);
  const selectPopoverProps = useMemo(() => ({ ...popoverProps, onOpening }), [onOpening]);

  const renderBatch = (batchItem, { handleClick, modifiers, ref, id }) => (
    <MenuItem
      key={batchItem.label}
      id={id}
      ref={ref}
      roleStructure="listoption"
      onClick={handleClick}
      active={modifiers.active}
      selected={batchItem.label === selectedBatch?.label}
      intent={batchItem.label === selectedBatch?.label ? "primary" : undefined}
      text={
        <div style={{ lineHeight: '1.3', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
          <div><BatchLabel item={batchItem} /></div>
          <Username item={batchItem} />
        </div>
      }
    />
  );

  if (!batches)
    return <span/>

  const has_batches = batchItems.length > 0;
  return (
    <Select
      items={batchItems}
      itemsEqual="label"
      itemRenderer={renderBatch}
      itemPredicate={filterBatch}
      onItemSelect={item => onChange({ target: { value: item.label } })}
      activeItem={activeItem}
      onActiveItemChange={item => setActiveLabel(item?.label ?? null)}
      noResults={
        <NonIdealState
          icon="search"
          title="No batches found"
          description="Try other search terms: a batch, a user, failed, running, local, ci, tuning..."
        />
      }
      popoverProps={selectPopoverProps}
      disabled={!has_batches}
    >
      <Button
        endIcon="double-caret-vertical"
        disabled={!has_batches}
        style={{ maxWidth: '360px', marginLeft: '5px' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', lineHeight: '1.3', width: '100%' }}>
          <div style={{ flex: 1, textAlign: 'left' }}>
            {selectedBatch
              ? <BatchLabel item={selectedBatch} />
              : <div style={{ color: Colors.RED2 }}>{pretty_label(batch)} (no results)</div>
            }
          </div>
          {selectedBatch && <Username item={selectedBatch} style={{ marginRight: '8px' }} />}
        </div>
      </Button>
    </Select>
  );
};

export { SelectBatchesNav };
