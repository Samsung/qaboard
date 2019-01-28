import React from "react";
import { FormGroup, HTMLSelect } from "@blueprintjs/core";

const SelectBatches = ({ commit, prefix, onChange, selected }) => {
  if (!commit || !commit.batches)
    return <span/>

  const batches_to_options = batches =>
    Object.entries(batches).map(([label, batch]) => {
      let outputs = Object.entries(batch.outputs || {});
      if (batch.data.type !== 'local') {
        var title = label === "default" ? "CI results" : label;
      } else {
        var [user, _label] = label.replace('@', '').split('|');
        title = `🏠 ${user} 🚧 ${_label}`;
      }
      let nb_success = outputs.filter(o => !o.is_pending && !o.is_failed)
        .length;
      let status = `${nb_success}/${outputs.length} ✅`;
      let nb_failed = outputs.filter(o => o.is_failed).length;
      let failures = nb_failed > 0 ? `${nb_failed}❌` : "";


      return (
        <option key={label} value={label}>
          {title}
          &nbsp;•&nbsp;
          {status}
          &nbsp;{failures}
        </option>
      );
    });

  let has_tuning_batches = Object.values(commit.batches).length >= 1;
  return (
    <FormGroup
      label={<span>{prefix}</span>}
      labelFor="batch-select"
      helperText={
        has_tuning_batches
          ? "You can view results from different batches or tuning experiments."
          : " "
      }
    >
      <HTMLSelect
        minimal
        disabled={!has_tuning_batches}
        id="batch-select-new"
        defaultValue={selected}
        onChange={onChange}
      >
        {batches_to_options(commit.batches)}
      </HTMLSelect>
    </FormGroup>
  );
};

export { SelectBatches };
