import React from "react";
import {
  Colors,
  HTMLSelect,
  MenuItem
} from "@blueprintjs/core";
import {
  Select,
} from "@blueprintjs/select";


import { pretty_label } from '../../utils'

const SelectBatchesNav = ({ commit, onChange, batch, hide_counts, alwaysUseSearchable = true, searchThreshold = 0 }) => {
  if (!commit || !commit.batches)
    return <span/>

  // Prepare batch data for Select component
  const prepareBatchData = (batches) => {
    return Object.entries(batches)
      .sort( ([label1, _1], [label2, _2]) => {
        if (label1 === 'default')
          return -1;
        if (label2 === 'default')
          return 1;
        return label1.localeCompare(label2);
      })
      .map(([label, batchData]) => {
        let outputs = Object.values(batchData.outputs || {})
        outputs = outputs.filter(o => o.output_type !== "optim_iteration")
        const title = pretty_label(batchData)
        let nb_success = outputs.filter(o => !o.is_pending && !o.is_failed).length;
        let nb_failed = outputs.filter(o => o.is_failed).length;
        let nb_running = outputs.filter(o => o.is_running).length;
        
        const status = `${nb_success}/${outputs.length} ✅`;
        const failures = nb_failed > 0 ? `${nb_failed}❌` : "";
        const running = nb_running > 0 ? `${nb_running}🏃` : "";
        const optimization = batchData.data.optimization ? `${batchData.data.iteration} 🔁` : "";
        
        // Extract username from commands or batch data
        const commands = Object.values(batchData.data?.commands || {});
        const username = commands.length > 0 ? commands[0]?.user : null;
        
        // Create searchable text for filtering
        const searchText = [
          title.toLowerCase(),
          label.toLowerCase(),
          username?.toLowerCase() || '',
          nb_failed > 0 ? 'failed fail error' : '',
          nb_running > 0 ? 'running' : '',
          nb_success > 0 ? 'success successful' : '',
          batchData.data.optimization ? 'optimization tuning' : '',
          batchData.data.type === 'local' ? 'local' : 'ci',
        ].join(' ');

        return {
          label,
          title,
          status,
          failures,
          running,
          optimization,
          username,
          searchText,
          nb_success,
          nb_failed,
          nb_running,
          total: outputs.length,
          batchData
        };
      });
  };

  const batchItems = prepareBatchData(commit.batches);
  const selectedItem = batchItems.find(item => item.label === batch.label);
  
  // Custom item renderer for rich display
  const renderBatch = (batchItem, { handleClick, modifiers }) => {
    if (!modifiers.matchesPredicate) {
      return null;
    }
    
    return (
      <MenuItem
        key={batchItem.label}
        onClick={handleClick}
        active={modifiers.active}
        text={
          <div style={{ lineHeight: '1.3', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 500 }}>
                {batchItem.title}
              </div>
              <div style={{ fontSize: '12px', color: Colors.GRAY1, marginTop: '2px' }}>
                {batchItem.status} {batchItem.failures}{batchItem.running}{batchItem.optimization}
              </div>
            </div>
            {batchItem.username && (
              <div style={{ fontSize: '11px', color: Colors.GRAY3, fontStyle: 'italic' }}>
                {batchItem.username}
              </div>
            )}
          </div>
        }
      />
    );
  };

  // Custom filter predicate for smart search
  const filterBatch = (query, batchItem) => {
    if (!query) return true;
    return batchItem.searchText.includes(query.toLowerCase());
  };

  const handleBatchSelect = (batchItem) => {
    const mockEvent = {
      target: { value: batchItem.label }
    };
    onChange(mockEvent);
  };

  let has_tuning_batches = Object.values(commit.batches).length >= 1;
  let selected_batch_missing = !Object.keys(commit.batches).includes(batch.label)
  let style = selected_batch_missing ? {color: Colors.RED2} : {}

  // Use searchable Select based on configuration
  const usesSearchableSelect = alwaysUseSearchable || batchItems.length > searchThreshold;

  if (!usesSearchableSelect) {
    // Original HTMLSelect for backwards compatibility with small batch counts
    const batches_to_options = batches =>
      Object.entries(batches)
      .sort( ([label1, _1], [label2, _2]) => {
        if (label1 === 'default')
          return -1;
        if (label2 === 'default')
          return 1;
        return label1.localeCompare(label2);
      })
      .map(([label, batch]) => {
        let outputs = Object.values(batch.outputs || {})
        outputs = outputs.filter(o => o.output_type !== "optim_iteration")
        const title = pretty_label(batch)
        let nb_success = outputs.filter(o => !o.is_pending && !o.is_failed).length;
        let status = `${nb_success}/${outputs.length} ✅`;
        let nb_failed = outputs.filter(o => o.is_failed).length;
        let nb_running = outputs.filter(o => o.is_running).length;
        let failures = nb_failed > 0 ? `${nb_failed}❌` : "";
        let running = nb_running > 0 ? `${nb_running}🏃` : "";
        return  <option key={label} value={label}>
           {title} &nbsp;•&nbsp; {status} &nbsp;{failures}{running}{batch.data.optimization && `${batch.data.iteration} 🔁`}
         </option>
      });
      
    return (
        <HTMLSelect
          minimal
          disabled={!has_tuning_batches}
          id="batch-select-new"
          value={batch.label}
          title={batch.label}
          onChange={onChange}
          style={{maxWidth: '360px', ...style}}
        >
          {selected_batch_missing && <option value={batch.label} key={batch.label}>{pretty_label(batch)} (no results)</option>}
          {batches_to_options(commit.batches)}
        </HTMLSelect>
    );
  }

  return (
    <Select
      items={batchItems}
      itemRenderer={renderBatch}
      itemPredicate={filterBatch}
      onItemSelect={handleBatchSelect}
      filterable={true}
      popoverProps={{ 
        minimal: true,
        modifiers: { 
          preventOverflow: { 
            boundariesElement: "viewport" 
          } 
        }
      }}
      disabled={!has_tuning_batches}
      style={{maxWidth: '360px', marginLeft: '5px', ...style}}
    >
      <div 
        style={{ 
          border: '1px solid #ccc',
          borderRadius: '3px',
          padding: '5px 10px',
          cursor: has_tuning_batches ? 'pointer' : 'not-allowed',
          backgroundColor: has_tuning_batches ? 'white' : '#f5f5f5',
          minWidth: '200px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          lineHeight: '1.3'
        }}
      >
        <div style={{ flex: 1 }}>
          {selectedItem ? (
            <div>
              <div style={{ fontWeight: 500 }}>
                {selectedItem.title}
                {selected_batch_missing && " (no results)"}
              </div>
              <div style={{ fontSize: '12px', color: Colors.GRAY1, marginTop: '2px' }}>
                {selectedItem.status} {selectedItem.failures}{selectedItem.running}{selectedItem.optimization}
              </div>
            </div>
          ) : (
            <div style={{ color: Colors.RED2 }}>
              {pretty_label(batch)} (no results)
            </div>
          )}
        </div>
        {selectedItem && selectedItem.username && (
          <div style={{ fontSize: '11px', color: Colors.GRAY3, fontStyle: 'italic', marginRight: '8px' }}>
            {selectedItem.username}
          </div>
        )}
        <div style={{ color: Colors.GRAY1 }}>
          ▼
        </div>
      </div>
    </Select>
  );
};

export { SelectBatchesNav };
