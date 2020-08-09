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
import { metric_formatter, percent_formatter } from "./metrics"



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
      <ConfigurationsTags configurations={output.configurations}/>      
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
      <Tooltip>
        <span>{metric_formatter(delta, metric)} ({percent_formatter.format(100 * delta_relative)}%)</span>
        <ul>
          <li><strong>New:</strong> {metrics_new[metric.key] * metric.scale}{metric.suffix}</li>
          <li><strong>Reference:</strong> {metrics_ref[metric.key] * metric.scale}{metric.suffix}</li>
        </ul>
      </Tooltip>
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
      <Tooltip>
       <span>{metric_formatter(value * metric.scale, metric)}</span>
       <span>{value * metric.scale}{metric.suffix}</span>
      </Tooltip>
    </td>
  );
};

const TableCompare = ({
  new_batch,
  ref_batch,
  metrics,
  input,
  labels
}) => {
  if (new_batch === undefined || new_batch === null || new_batch.outputs === undefined || new_batch.outputs === null) return <span />;
  const [label_new, label_ref] = labels || ["new", "ref"];

  const outputs = new_batch.filtered.outputs.map(id => [id, new_batch.outputs[id]])
    .filter(([id, o]) => !o.is_pending)
    .filter(([id, o]) => o.output_type!=="optim_iteration");

  const metrics_ = metrics.filter(m => outputs.some(([id, o]) => o.metrics[m.key] !== null && o.metrics[m.key] !== undefined))
  return (
    <Section>
      {input}
      <HTMLTable small>
        <thead>
          <tr>
            <th />
            {metrics_.map(m => (
              <th key={m.key} style={{boxShadow: "inset 0 0 1px 0 rgba(16, 22, 26, 0.15);"}}>
                {m.short_label} {m.suffix.length > 0 && <span className={Classes.TEXT_MUTED}>{m.suffix}</span>}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">
              <span className={Classes.TEXT_MUTED}>
                {outputs.length} tests
              </span>
            </th>
            {metrics_.map(m => (
              <th scope="col" key={m.key}>
                {label_new} − {label_ref}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {outputs.map(([id, output]) => {
            let { reference_id, reference_mismatch } = output;
            let output_ref = ref_batch.outputs[reference_id] || {}
            return (
              <Row key={id}>
                <RowHeaderCell output={output} mismatch={reference_mismatch} />
                {metrics_.map(m => (
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
  metrics,
  input,
  labels
}) => {
  if (new_batch === undefined || new_batch === null || new_batch.outputs === undefined || new_batch.outputs === null) return <span />;
  const [label_new, label_ref] = labels || ["New", "Ref"];
  const outputs = new_batch.filtered.outputs.map(id => [id, new_batch.outputs[id]])
    .filter(([id, o]) => !o.is_pending)
    .filter(([id, o]) => o.output_type!=="optim_iteration");
  const metrics_ = metrics.filter(m => outputs.some(([id, o])  => o.metrics[m.key] !== null && o.metrics[m.key] !== undefined))
  return (
    <Section>
      {input}
      <HTMLTable small>
        <thead>
          <tr>
            <th />
            {metrics_.map(m => (
              <th colSpan={2} key={m.key}>
                <Tooltip><span>{m.short_label}</span><span>{m.label}</span></Tooltip> {(!!m.target || !!m.suffix) && <span className={Classes.TEXT_MUTED}>[{!!m.target ? metric_formatter(m.target * m.scale, m) : ''}{m.suffix}]</span>}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">
              <span className={Classes.TEXT_MUTED}>
                {outputs.length} tests
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
            let { reference_id, reference_mismatch } = output;
            let output_ref = ref_batch.outputs[reference_id] || {}
            return (
              <Row key={id}>
                <RowHeaderCell output={output} mismatch={reference_mismatch} />
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
