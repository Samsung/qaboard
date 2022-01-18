import React from "react";
import {
  Colors,
  HTMLSelect
} from "@blueprintjs/core";

import { pretty_label } from '../../utils'

const SelectBatchesNav = ({ commit, onChange, batch, hide_counts }) => {
  if (!commit || !commit.batches)
    return <span/>

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
      let iters = outputs.filter(o => o.output_type === "optim_iteration").length
      outputs = outputs.filter(o => o.output_type !== "optim_iteration")
      const title = pretty_label(batch)
      let nb_success = outputs.filter(o => !o.is_pending && !o.is_failed).length;
      let status = `${nb_success}/${outputs.length} ✅`;
      let nb_failed = outputs.filter(o => o.is_failed).length;
      let nb_running = outputs.filter(o => o.is_running).length;
      let failures = nb_failed > 0 ? `${nb_failed}❌` : "";
      let running = nb_running > 0 ? `${nb_running}🏃` : "";
      return  <option key={label} value={label}>
         {title} &nbsp;•&nbsp; {status} &nbsp;{failures}{running}{iters > 0 ? `${iters} 🔁` : ''}
       </option>
    });

  let has_tuning_batches = Object.values(commit.batches).length >= 1;
  let selected_batch_missing = !Object.keys(commit.batches).includes(batch.label)
  let style = selected_batch_missing ? {color: Colors.RED2} : {}
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
};

export { SelectBatchesNav };
