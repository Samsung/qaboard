import React from "react";
import { FormGroup } from "@blueprintjs/core";


const SelectBatches = ({ commit, prefix, onChange }) => {
  const batches_to_options = batches => Object.keys(batches)
                                  .map( label=> {
                                    let slam_outputs = Object.values(batches[label].slam_outputs);
                                    return <option key={label} value={label}>
                                            {label==='default' ? 'CI results' : label}
                                            &nbsp;•&nbsp;
                                            {slam_outputs.filter(o=>!o.is_pending && !o.is_crashed).length}/{slam_outputs.length} ✔️
                                    </option>})      
  let has_tuning_batches = Object.values(commit.batches).length>1;
  if (!has_tuning_batches)
    return <span></span>

  //  You can 
  return <FormGroup
          label={<span>{prefix}</span>}
          labelFor="batch-select"
          helperText="You can view results from different batches or tuning experiments."
         >
          <div className="pt-select pt-minimal">
            <select id='batch-select-new' defaultValue="default" onChange={onChange}>
              {batches_to_options(commit.batches)}
            </select>
          </div>
  </FormGroup>
} 


export { SelectBatches };
