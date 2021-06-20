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
import { PlatformTag, ConfigurationsTags, ExtraParametersTags, MismatchTags } from './tags'
import { metric_formatter, percent_formatter } from "./metrics"



const Row = styled.tr`
  transition: background 0.2s;
  :hover {
  	background: ${Colors.LIGHT_GRAY3};
  }
`

const RowHeaderCell = ({ output }) => {
  let test_input = output.test_input_metadata?.label ?? `${output.test_input_database === '/' ? '/' : ''}${output.test_input_path}`
  return (
    <th scope="row">
      {test_input} <ExtraParametersTags parameters={output.extra_parameters} />
      <PlatformTag platform={output.platform}/>
      <ConfigurationsTags configurations={output.configurations}/>
      <MismatchTags mismatch={output.reference_mismatch}/>
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
  let delta_relative = delta / (Math.abs(metrics_ref[metric.key]) + 0.00001);
  let quality = metric.smaller_is_better ? (0.5 - delta_relative/2) : (0.5 + delta_relative/2);
  quality = Math.max(Math.min(quality, 0.9), 0.08)
  return (
    <td style={{ background: interpolateRdYlGn(quality) }}>
      <Tooltip>
        {delta === 0 ? "=" : <span>{metric_formatter(delta, metric)} ({percent_formatter.format(100 * delta_relative)}%)</span>}
        <ul>
          <li><strong>New:</strong> {metrics_new[metric.key] * metric.scale}{metric.suffix}</li>
          <li><strong>Reference:</strong> {metrics_ref[metric.key] * metric.scale}{metric.suffix}</li>
        </ul>
      </Tooltip>
    </td>
  );
};

const QualityCell = ({ metric_info, metric, metric_ref }) => {
  if (
    metric_info === undefined ||
    metric === undefined || metric === null
  )
    return <td></td>;
  const delta_relative = !!metric_info.target ? (metric_info.target - metric) / (metric_info.target + 0.000001) : 0;
  if (metric_info.target_passfail) {
    var quality = metric_info.smaller_is_better ? metric_info.target >= metric : metric_info.target < metric
  } else {
    quality = metric_info.smaller_is_better ? (0.5 + delta_relative/2) : (0.5 - delta_relative/2);
  }
  quality = Math.max(Math.min(quality, 0.9), 0.08)
  const color = interpolateRdYlGn(quality)
  return (
    <td style={{ background: color }}>
      <Tooltip>
       <span>{metric_ref === metric ? '=' : metric_formatter(metric * metric_info.scale, metric_info)}</span>
       <span>{metric * metric_info.scale}{metric_info.suffix}</span>
      </Tooltip>
    </td>
  );
};

const TableCompare = ({
  new_batch,
  ref_batch,
  metrics=[],
  available_metrics={},
  input,
  labels
}) => {
  if (new_batch === undefined || new_batch === null || new_batch.outputs === undefined || new_batch.outputs === null) return <span />;
  const [label_new, label_ref] = labels || ["new", "ref"];

  const outputs = new_batch.filtered.outputs.map(id => [id, new_batch.outputs[id]])
    .filter(([id, o]) => !o.is_pending)
    .filter(([id, o]) => o.output_type!=="optim_iteration");
  const metrics_ = (metrics.length > 0 ? metrics : Object.keys(available_metrics))
                          .filter(m => !!available_metrics[m])
                          .map(m => available_metrics[m])
                          .filter(m => new_batch.used_metrics.has(m.key)
                                    && new_batch.metrics_with_refs.has(m.key))
  return (
    <Section>
      {input}
      <HTMLTable small>
        <thead>
          <tr>
            <th />
            {metrics_.map(m => (
              <th key={m.key} style={{boxShadow: "inset 0 0 1px 0 rgba(16, 22, 26, 0.15)"}}>
                {m.short_label} {m.suffix.length > 0 && <span className={Classes.TEXT_MUTED}>{m.suffix}</span>}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">
              <span className={Classes.TEXT_MUTED}>
                {outputs.length} runs
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
  metrics=[],
  available_metrics={},
  input,
  labels
}) => {
  if (new_batch?.outputs === undefined || new_batch?.outputs === null) return <span />;
  const [label_new, label_ref] = labels || ["New", "Ref"];
  const outputs = new_batch.filtered.outputs.map(id => [id, new_batch.outputs[id]])
    .filter(([id, o]) => !o.is_pending)
    .filter(([id, o]) => o.output_type!=="optim_iteration");
    const metrics_ = (metrics.length > 0 ? metrics : Object.keys(available_metrics))
                            .filter(m => !!available_metrics[m])
                            .map(m => available_metrics[m]).filter(m => new_batch.used_metrics.has(m.key))
  return (
    <Section>
      {input}
      <HTMLTable small>
        <thead>
          <tr>
            <th />
            {metrics_.map(m => (
              <th colSpan={new_batch.metrics_with_refs.has(m.key) ? 2 : 1} key={m.key}>
                <Tooltip>
                  <span>{m.short_label}</span>
                  <span>{m.label}</span>
                </Tooltip>
                {(!!m.target || !!m.suffix) && <span className={Classes.TEXT_MUTED}>
                  [{!!m.target ? metric_formatter(m.target * m.scale, m) : ''}{m.suffix}]
                </span>}
              </th>
            ))}
          </tr>
          <tr>
            <th scope="col">
              <span className={Classes.TEXT_MUTED}>
                {outputs.length} runs
              </span>
            </th>
            {metrics_.map(m => (
              <Fragment key={m.key}>
                {new_batch.metrics_with_refs.has(m.key) && <>
                  <th scope="col">{label_new}</th>
                  <th scope="col">{label_ref}</th>
                </>}
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {outputs.map(([id, output]) => {
            let { reference_id, reference_mismatch } = output;
            let output_ref = ref_batch.outputs[reference_id] || {metrics: {}}
            return (
              <Row key={id}>
                <RowHeaderCell output={output} mismatch={reference_mismatch} />
                {metrics_.map(m => (
                  <Fragment key={m.key}>
                    <QualityCell metric_info={m} metric={output.metrics[m.key]} />
                    {new_batch.metrics_with_refs.has(m.key) && <QualityCell metric_info={m} metric={output_ref.metrics[m.key]} metric_ref={output.metrics[m.key]}/>}
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
