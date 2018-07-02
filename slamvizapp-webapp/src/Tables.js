import React, { Fragment } from "react";
import { interpolateRdYlGn } from "d3-scale-chromatic";
import { Icon, Tag, Intent, Popover } from "@blueprintjs/core";

import { Section } from "./common/containers";
import { matching_output, sortOutputs } from "./common/utils";

const metric_formatter = new Intl.NumberFormat("en-US", {
  style: "decimal",
  minimumFractionDigits: 3,
  maximumFractionDigits: 3
});
const percent_formatter = new Intl.NumberFormat("en-US", {
  style: "decimal",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

const RowHeaderCell = ({ output, warning }) => {
  let extra_parameters =
    Object.keys(output.extra_parameters).length > 0
      ? JSON.stringify(output.extra_parameters)
      : "";
  return (
    <th scope="row">
      {output.test_input_path} {extra_parameters}
      <Tag
        className="pt-round pt-minimal"
        icon={output.platform === "s8" ? "mobile-phone" : "desktop"}
      >
        {output.platform}
      </Tag>
      <Tag
        className="pt-round pt-minimal"
        icon={output.configuration === "mono_mode" ? "eye-off" : "blank"}
      >
        {output.configuration}
      </Tag>
      {warning && (
        <Popover interactionKind="hover">
          <Icon intent={Intent.WARNING} icon="warning-sign" />
          <span>{warning}</span>
        </Popover>
      )}
    </th>
  );
};

const ColumnsMetricImprovement = ({ metrics_new, metrics_ref, metric }) => {
  if (
    !metrics_new ||
    metrics_new[metric.key] === undefined ||
    metrics_new[metric.key] === null
  )
    return <td style={{ background: "#bbb" }}>New missing</td>;
  if (
    !metrics_ref ||
    metrics_ref[metric.key] === undefined ||
    metrics_ref[metric.key] === null
  )
    return <td style={{ background: "#bbb" }}>Ref missing</td>;
  let delta = metrics_new[metric.key] - metrics_ref[metric.key];
  let delta_relative = delta / (metrics_ref[metric.key] + 0.00001);
  return (
    <td style={{ background: interpolateRdYlGn(0.5 - delta_relative) }}>
      {metric_formatter.format(delta)} ({percent_formatter.format(
        100 * delta_relative
      )}%)
    </td>
  );
};

const QualityCell = ({ metric, metrics }) => {
  if (
    metrics === undefined ||
    metrics[metric.key] === undefined ||
    metrics[metric.key] === null
  )
    return <td style={{ background: "#bbb" }}>na</td>;
  let value = metrics[metric.key];
  const threshold = metric.threshold;
  const quality = 0.5 + (threshold - value) / (threshold + 0.0001);
  return (
    <td style={{ background: interpolateRdYlGn(quality) }}>
      {metric_formatter.format(value)}
    </td>
  );
};

const TableCompare = ({
  new_batch,
  ref_batch,
  sort_order,
  sort_by,
  metrics,
  input,
  labels
}) => {
  if (new_batch === null) return <span />;
  const [label_new, label_ref] = labels || ["new", "ref"];
  let outputs = Object.entries(new_batch.outputs)
    .filter(([id, o]) => !o.is_pending)
    .sort(sortOutputs(sort_by, sort_order));
  return (
    <Section>
      {input}
      <table className="pt-html-table pt-small">
        <thead>
          <tr>
            <th />
            {metrics.map(m => (
              <th key={m.key}>
                {m.label} [{m.suffix}]
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">
              <span className="pt-text-muted">
                {Object.keys(outputs).length} tests
              </span>
            </th>
            {metrics.map(m => (
              <th scope="col" key={m.key}>
                {label_new}-{label_ref}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {outputs.map(([id, output]) => {
            let { output_ref, warning } = matching_output({
              output: output,
              batch: ref_batch
            });
            return (
              <tr key={id}>
                <RowHeaderCell output={output} warning={warning} />
                {metrics.map(m => (
                  <ColumnsMetricImprovement
                    key={m.key}
                    metric={m}
                    metrics_new={output.metrics}
                    metrics_ref={output_ref.metrics}
                  />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
};

const TableKpi = ({
  new_batch,
  ref_batch,
  sort_order,
  sort_by,
  metrics,
  input,
  labels
}) => {
  if (new_batch === null) return <span />;
  const [label_new, label_ref] = labels || ["New", "Reference"];
  let outputs = Object.entries(new_batch.outputs)
    .filter(([id, o]) => !o.is_pending)
    .sort(sortOutputs(sort_by, sort_order));
  return (
    <Section>
      {input}
      <table className="pt-html-table pt-small">
        <thead>
          <tr>
            <th />
            {metrics.map(m => (
              <th colSpan={2} key={m.key}>
                {m.label} [{metric_formatter.format(m.threshold * m.scale)}
                {m.suffix}]
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">
              <span className="pt-text-muted">
                {Object.keys(outputs).length} tests
              </span>
            </th>
            {metrics.map(m => (
              <Fragment key={m.key}>
                <th scope="col">{label_new}</th>
                <th scope="col">{label_ref}</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {outputs.map(([id, output]) => {
            let { output_ref, warning } = matching_output({
              output: output,
              batch: ref_batch,
              soft_match: false
            });
            return (
              <tr key={id}>
                <RowHeaderCell output={output} warning={warning} />
                {metrics.map(m => (
                  <Fragment key={m.key}>
                    <QualityCell metric={m} metrics={output.metrics} />
                    <QualityCell metric={m} metrics={output_ref.metrics} />
                  </Fragment>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
};

export { TableKpi, TableCompare };
