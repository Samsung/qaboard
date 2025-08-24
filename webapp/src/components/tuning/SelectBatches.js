import React from "react";
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

const SelectBatchesNav = ({ commit, onChange, batch, hide_counts, project, project_data }) => {
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
        
        // Check if this batch is a milestone
        const batch_obj = { label };
        const is_milestone = has_milestones({ commit, project, project_data, batch: batch_obj });
        const milestone_prefix = is_milestone ? "⭐ " : "";
        
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
          title_with_milestone: milestone_prefix + title,
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
          batchData,
          is_milestone
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
                {batchItem.title_with_milestone}
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

  return (
    <Select
      items={batchItems}
      itemRenderer={renderBatch}
      itemPredicate={filterBatch}
      onItemSelect={handleBatchSelect}
      activeItem={selectedItem}
      filterable={true}
      noResults={
        <NonIdealState
          icon="search"
          title="No batches found"
          description="Try adjusting your search terms or check if batches are available."
        />
      }
      popoverProps={{ 
        minimal: true,
        modifiers: { 
          preventOverflow: { 
            boundariesElement: "viewport" 
          } 
        }
      }}
      disabled={!has_tuning_batches}
    >
      <Button
        rightIcon="double-caret-vertical"
        disabled={!has_tuning_batches}
        style={{maxWidth: '360px', marginLeft: '5px', ...style}}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', lineHeight: '1.3', width: '100%' }}>
          <div style={{ flex: 1, textAlign: 'left' }}>
            {selectedItem ? (
              <div>
                <div style={{ fontWeight: 500 }}>
                  {selectedItem.title_with_milestone}
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
        </div>
      </Button>
    </Select>
  );
};

export { SelectBatchesNav };
