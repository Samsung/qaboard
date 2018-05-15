import React from "react";
import { FormGroup } from "@blueprintjs/core";


const SelectBatches = ({ commit, prefix, onChange, selected }) => {
  const batches_to_options = batches => Object.keys(batches)
                                  .map( label=> {
                                    let slam_outputs = Object.values(batches[label].slam_outputs);
                                    let title = label==='default' ? 'CI results' : label;
                                    let nb_success = slam_outputs.filter(o=>!o.is_pending && !o.is_failed).length;
                                    let status = `${nb_success}/${slam_outputs.length} ✅`
                                    let nb_failed = slam_outputs.filter(o=>o.is_failed).length;
                                    let failures = nb_failed > 0 ? `${nb_failed}❌` : '';
                                    return <option key={label} selected={label===selected} value={label}>
                                            {title}
                                            &nbsp;•&nbsp;
                                            {status}
                                            &nbsp;{failures}
                                    </option>})
  let has_tuning_batches = Object.values(commit.batches).length>1;
  return <FormGroup
          label={<span>{prefix}</span>}
          labelFor="batch-select"
          helperText={has_tuning_batches ? "You can view results from different batches or tuning experiments." : ''}
         >
          <div className="pt-select pt-minimal">
            <select disabled={!has_tuning_batches} id='batch-select-new' defaultValue="default" onChange={onChange}>
              {batches_to_options(commit.batches)}
            </select>
          </div>
  </FormGroup>
} 


export { SelectBatches };
