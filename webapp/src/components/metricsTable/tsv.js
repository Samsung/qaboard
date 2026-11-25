// The metrics tables as tab-separated values, that paste into spreadsheets: the numbers in full, not rounded
import { diff_cell, is_number } from "../../utils/compare";
import { configurationSummary } from "../../configurations/tokens";
import { clean_number, raw_value, to_tsv } from "./stats";


// e.g. "PSNR [dB]"
const column_name = metric => `${metric.label}${metric.suffix?.trim() ? ` [${metric.suffix.trim()}]` : ''}`;

// rows: [{ output, output_ref }], name(output): the run's name as the table shows it
const run_columns = rows => {
  const with_configurations = rows.some(({ output }) => configurationSummary(output));
  return {
    header: ['Run', ...(with_configurations ? ['Configuration'] : []), 'Failed'],
    cells: (output, name) => [name(output), ...(with_configurations ? [configurationSummary(output)] : []), output.is_failed ? 'yes' : ''],
  };
};

// The Metrics Table: each metric's value, and the reference run's when the table shows it.
// with_refs: the keys of metrics that have reference values, labels: [new, reference]
export const kpi_tsv = ({ rows, metrics, with_refs, labels, name }) => {
  const runs = run_columns(rows);
  const header = [...runs.header, ...metrics.flatMap(m => with_refs.has(m.key)
    ? [`${column_name(m)} ${labels[0]}`, `${column_name(m)} ${labels[1]}`]
    : [column_name(m)])];
  const lines = rows.map(({ output, output_ref }) => [
    ...runs.cells(output, name),
    ...metrics.flatMap(m => with_refs.has(m.key)
      ? [raw_value(output.metrics?.[m.key], m), raw_value(output_ref?.metrics?.[m.key], m)]
      : [raw_value(output.metrics?.[m.key], m)]),
  ]);
  return to_tsv([header, ...lines]);
};

// The Metrics Diff: each metric's values, their difference and relative change (in %)
export const diff_tsv = ({ rows, metrics, labels, name }) => {
  const runs = run_columns(rows);
  const header = [...runs.header, ...metrics.flatMap(m => [
    `${column_name(m)} ${labels[0]}`,
    `${column_name(m)} ${labels[1]}`,
    `${column_name(m)} change`,
    `${m.label} change (%)`,
  ])];
  const lines = rows.map(({ output, output_ref }) => [
    ...runs.cells(output, name),
    ...metrics.flatMap(m => {
      const value = output.metrics?.[m.key];
      const value_ref = output_ref?.metrics?.[m.key];
      if (!is_number(value) || !is_number(value_ref))
        return [raw_value(value, m), raw_value(value_ref, m), '', ''];
      const { delta } = diff_cell(value, value_ref);
      // exactly, not with the cells' epsilon: none from 0
      const relative = value_ref === 0 ? '' : clean_number(100 * delta / Math.abs(value_ref));
      return [raw_value(value, m), raw_value(value_ref, m), clean_number(delta * (m.scale ?? 1)), relative];
    }),
  ]);
  return to_tsv([header, ...lines]);
};
