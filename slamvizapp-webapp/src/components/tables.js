import React, { Fragment } from "react";
import styled from "styled-components";
import { interpolateRdYlGn } from "d3-scale-chromatic";
import {
  Classes,
  Intent,
  Colors,
  Tag,
  HTMLTable,
  Tooltip,
} from "@blueprintjs/core";

import { Section } from "./layout";
import { PlatformTag, ConfigurationsTags, ExtraParametersTags } from './tags'
import { sortOutputs } from "../utils";

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


const Row = styled.tr`
  transition: background 0.2s;
  :hover {
  	background: ${Colors.LIGHT_GRAY3};
  }
`

const RowHeaderCell = ({ output, warning }) => {
  return (
    <th scope="row">
      {output.test_input_path} <ExtraParametersTags parameters={output.extra_parameters} />
      <PlatformTag platform={output.platform}/>
      <ConfigurationsTags configuration={output.configuration}/>      
      {warning && (
        <Tooltip>
          <Tag intent={Intent.WARNING} icon="not-equal-to">ref</Tag>
          <span>{warning}</span>
        </Tooltip>
      )}
      {output.is_failed && <Tag style={{marginLeft: '5px'}} intent={Intent.DANGER}>Failed</Tag>}
    </th>
  );
};

const ColumnsMetricImprovement = ({ metrics_new, metrics_ref, metric }) => {
  if (
    !metrics_new ||
    metrics_new[metric.key] === undefined ||
    metrics_new[metric.key] === null
  )
    return <td></td>;
  if (
    !metrics_ref ||
    metrics_ref[metric.key] === undefined ||
    metrics_ref[metric.key] === null
  )
    return <td></td>;
  let delta = metrics_new[metric.key] - metrics_ref[metric.key];
  let delta_relative = delta / (metrics_ref[metric.key] + 0.00001);
  let quality = metric.smaller_is_better ? (0.5 - delta_relative/2) : (0.5 + delta_relative/2);
  quality = Math.max(Math.min(quality, 0.9), 0.08)
  return (
    <td style={{ background: interpolateRdYlGn(quality) }}>
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
    return <td></td>;
  let value = metrics[metric.key];
  const delta_relative = !!metric.target ? (metric.target - value) / (metric.target + 0.000001) : 0;
  let quality = metric.smaller_is_better ? (0.5 + delta_relative/2) : (0.5 - delta_relative/2);
  quality = Math.max(Math.min(quality, 0.9), 0.08)
  return (
    <td style={{ background: interpolateRdYlGn(quality) }}>
      {metric_formatter.format(value * metric.scale)}
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
  if (new_batch === undefined || new_batch === null || new_batch.outputs === undefined || new_batch.outputs === null) return <span />;
  const [label_new, label_ref] = labels || ["new", "ref"];
  let outputs = Object.entries(new_batch.outputs)
    .filter(([id, o]) => !o.is_pending)
    .filter(([id, o]) => o.output_type!=="optim_iteration")
    .sort(sortOutputs(sort_by, sort_order));
  return (
    <Section>
      {input}
      <HTMLTable small>
        <thead>
          <tr>
            <th />
            {metrics.map(m => (
              <th key={m.key}>
                {m.short_label} {m.suffix && <span className={Classes.TEXT_MUTED}>[{m.suffix}]</span>}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">
              <span className={Classes.TEXT_MUTED}>
                {Object.keys(outputs).length} tests
              </span>
            </th>
            {metrics.map(m => (
              <th scope="col" key={m.key}>
                {label_new} − {label_ref}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {outputs.map(([id, output]) => {
            let { reference_id, reference_warning } = output;
            let output_ref = ref_batch.outputs[reference_id] || {}
            return (
              <Row key={id}>
                <RowHeaderCell output={output} warning={reference_warning} />
                {metrics.map(m => (
                  <ColumnsMetricImprovement
                    key={m.key}
                    metric={m}
                    metrics_new={output.metrics}
                    metrics_ref={output_ref.metrics}
                  />
                ))}
              </Row>
            );
          })}
        </tbody>
      </HTMLTable>
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
  if (new_batch === undefined || new_batch === null || new_batch.outputs === undefined || new_batch.outputs === null) return <span />;
  const [label_new, label_ref] = labels || ["New", "Reference"];
  let outputs = Object.entries(new_batch.outputs)
    .filter(([id, o]) => !o.is_pending)
    .filter(([id, o]) => o.output_type!=="optim_iteration")
    .sort(sortOutputs(sort_by, sort_order));
  const metrics_ = metrics.filter(m => outputs.values(o => o.metrics[m] !== null || o.metrics[m] !== undefined))
  return (
    <Section>
      {input}
      <HTMLTable small>
        <thead>
          <tr>
            <th />
            {metrics_.map(m => (
              <th colSpan={2} key={m.key}>
                {m.short_label} [{!!m.target ? metric_formatter.format(m.target * m.scale) : ''}
                {m.suffix}]
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">
              <span className={Classes.TEXT_MUTED}>
                {Object.keys(outputs).length} tests
              </span>
            </th>
            {metrics_.map(m => (
              <Fragment key={m.key}>
                <th scope="col">{label_new}</th>
                <th scope="col">{label_ref}</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {outputs.map(([id, output]) => {
            let { reference_id, reference_warning } = output;
            let output_ref = ref_batch.outputs[reference_id] || {}
            return (
              <Row key={id}>
                <RowHeaderCell output={output} warning={reference_warning} />
                {metrics_.map(m => (
                  <Fragment key={m.key}>
                    <QualityCell metric={m} metrics={output.metrics} />
                    <QualityCell metric={m} metrics={output_ref.metrics} />
                  </Fragment>
                ))}
              </Row>
            );
          })}
        </tbody>
      </HTMLTable>
    </Section>
  );
};

export { TableKpi, TableCompare };
