import React from "react";
import {
  Colors,
  HTMLSelect
} from "@blueprintjs/core";

import { pretty_label } from '../../utils'

const SelectBatchesNav = ({ commit, prefix, onChange, batch, hide_counts }) => {
  if (!commit || !commit.batches)
    return <span/>

  const batches_to_options = batches =>
    Object.entries(batches).map(([label, batch]) => {
      let outputs = Object.values(batch.outputs || {});
      const title = pretty_label(batch)
      let nb_success = outputs.filter(o => !o.is_pending && !o.is_failed).length;
      let status = `${nb_success}/${outputs.length} ✅`;
      let nb_failed = outputs.filter(o => o.is_failed).length;
      let failures = nb_failed > 0 ? `${nb_failed}❌` : "";


      // {title}{(hide_counts===undefined || !hide_counts) && <span>&nbsp;•&nbsp; {status} &nbsp;{failures}</span>}
      return  <option key={label} value={label}>
         {title} &nbsp;•&nbsp; {status} &nbsp;{failures}
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
