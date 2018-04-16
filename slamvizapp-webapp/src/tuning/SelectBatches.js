import React from "react";
import { FormGroup } from "@blueprintjs/core";


const SelectBatches = ({ commit, prefix, onChange }) => {
  const batches_to_options = batches => Object.keys(batches)
                                  .map( label=> <option key={label} value={label}>
                                                  {label==='default' ? 'CI results' : label} • {Object.keys(batches[label].slam_outputs).length} outputs
                                                </option>)      
  let has_tuning_batches = Object.values(commit.batches).length>1;
  if (!has_tuning_batches)
    return <span></span>
  return <FormGroup
          label={<span>{prefix} You can view results from different tuning experiments</span>}
          labelFor="batch-select"
          helperText="The CI results use the default parameters."
         >
          <div className="pt-select pt-minimal">
            <select id='batch-select-new' defaultValue="default" onChange={onChange}>
              {batches_to_options(commit.batches)}
            </select>
          </div>
  </FormGroup>
} 


export { SelectBatches };
