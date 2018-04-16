import React, { Fragment } from "react";
import { interpolateRdYlGn } from 'd3-scale-chromatic'
import { Tag, Callout, Intent } from "@blueprintjs/core";

import { Section } from "./Common";
import { slam_metrics, main_metrics } from "./slam/metrics";
import { metric_formatter, percent_formatter } from "./Metrics";


const ColumnsMetricImprovement = ({metrics_new, metrics_ref, metric}) => {
  if (!metrics_new || metrics_new[metric]===undefined || metrics_new[metric]===null)
    return <td style={{background:'#bbb'}}>New missing</td>
  if (!metrics_ref || metrics_ref[metric]===undefined || metrics_ref[metric]===null)
    return <td style={{background:'#bbb'}}>Ref missing</td>
  let delta = metrics_new[metric] - metrics_ref[metric];
  let delta_relative = delta / metrics_ref[metric];
  return <td style={{background: interpolateRdYlGn(.5-delta_relative)}}>{metric_formatter.format(delta)} ({percent_formatter.format(100*delta_relative)}%)</td>
}


const QualityCell = ({metric, metrics}) => {
  if (metrics===undefined || metrics[metric]===undefined || metrics[metric]===null)
    return <td style={{background:'#bbb'}}>na</td>
  let value = metrics[metric];
  const threshold = slam_metrics[metric].threshold
  const quality = 0.5 + (threshold - value) / threshold
  return <td style={{background: interpolateRdYlGn(quality)}}>{metric_formatter.format(value)}</td>
}


const TableCompare = ({ new_batch, ref_batch, output_sort, compare_cross_runtype }) => {
  return (
    <Section>
      <h2>Improvement report</h2>
      {ref_batch.label!=='default' && <Callout intent={Intent.WARNING}>We compare each output to <strong>any</strong> reference outputs with matching recording+configuration+platform, <strong>without looking at the tuning parameters</strong>.</Callout>}
      <table className="pt-html-table pt-small">
      <thead>
        <tr>
          <th></th>
          {main_metrics.map( m =>
            <th key={m}>{slam_metrics[m].label} [{slam_metrics[m].suffix}]</th>
          )}
        </tr>
        <tr>
          <th scope="col"></th>
          {main_metrics.map( m =>
            <th scope="col" key={m}>new-ref</th>
          )}
        </tr>
      </thead>
      <tbody>
      {Object.entries(new_batch.slam_outputs)
             .filter(([id, o]) => !o.is_pending && !o.is_failed)
             .sort(output_sort)
             .map( ([id, output]) => {
          let matching_ref_outputs = Object.values(ref_batch.slam_outputs)
                                           .filter(o => !o.is_pending && !o.is_failed)
                                           .filter(o => o.recording_path===output.recording_path)
                                           .filter(o => o.platform===output.platform || compare_cross_runtype)
                                           .filter(o => o.configuration===output.configuration || compare_cross_runtype)
          let output_ref = matching_ref_outputs[0] || {metrics: undefined};
          let extra_parameters = Object.keys(output.extra_parameters).length>0 ? JSON.stringify(output.extra_parameters) : '';
          return (
            <tr key={id}>
              <th scope="row">{output.recording_path} {extra_parameters}<Tag className="pt-round pt-minimal" icon={output.platform==='s8'? 'mobile-phone' : 'desktop'}>{output.platform}</Tag><Tag className="pt-round pt-minimal" icon={output.configuration==='mono_mode'?'eye-off':'blank'}>{output.configuration}</Tag></th>
              {main_metrics.map( m =>
                <ColumnsMetricImprovement key={m} metric={m} metrics_new={output.metrics} metrics_ref={output_ref.metrics} />
              )}
            </tr>)
      })}
      </tbody>
      </table>
    </Section>
  )
}


const TableKpi = ({ new_batch, ref_batch, output_sort, compare_cross_runtype }) => {
  return (
    <Section>
      <h2>Quality report</h2>
      {ref_batch.label!=='default' && <Callout intent={Intent.WARNING}>We compare each output to <strong>any</strong> reference outputs with matching recording+configuration+platform, <strong>without looking at the tuning parameters</strong>.</Callout>}
      <table className="pt-html-table pt-small">
      <thead>
        <tr>
          <th></th>
          {main_metrics.map( m =>
            <th colSpan={2} key={m}>{slam_metrics[m].label} [{metric_formatter.format(slam_metrics[m].threshold)}{slam_metrics[m].suffix}]</th>
          )}
        </tr>
        <tr>
          <th scope="col"></th>
          {main_metrics.map( m =>
            <Fragment key={m}>
              <th scope="col">New</th>
              <th scope="col">Reference</th>
            </Fragment>
          )}
        </tr>
      </thead>
      <tbody>
      {Object.entries(new_batch.slam_outputs)
             .filter(([id, o]) => !o.is_pending && !o.is_failed)
             .sort(this.sortOutputs)
             .map( ([id, output]) => {
          let matching_ref_outputs = Object.values(ref_batch.slam_outputs)
                                           .filter(o => !o.is_pending && !o.is_failed)
                                           .filter(o => o.recording_path===output.recording_path)
                                           .filter(o => o.platform===output.platform)
                                           .filter(o => o.configuration===output.configuration)
          let output_ref = matching_ref_outputs[0] || {metrics: undefined};
          let extra_parameters = Object.keys(output.extra_parameters).length>0 ? JSON.stringify(output.extra_parameters) : '';
          return (
            <tr key={id}>
              <th scope="row">{output.recording_path} {extra_parameters} <Tag className="pt-round pt-minimal" icon={output.platform==='s8'? 'mobile-phone' : 'desktop'}>{output.platform}</Tag><Tag className="pt-round pt-minimal" icon={output.configuration==='mono_mode'?'eye-off':'blank'}>{output.configuration}</Tag></th>
              {main_metrics.map( m =>
                <Fragment key={m}>
                  <QualityCell metric={m} metrics={output.metrics} />
                  <QualityCell metric={m} metrics={output_ref.metrics} />
                </Fragment>
              )}
            </tr>)
      })}
      </tbody>
      </table>
    </Section>
  )
}


export { TableKpi, TableCompare };