import React, { Fragment } from "react";
import { interpolateRdYlGn } from 'd3-scale-chromatic'
import { Tag } from "@blueprintjs/core";


import { Section } from "./Common";
import { available_metrics, metric_formatter, percent_formatter } from "./Metrics";
// import { Table, Column, Row } from "@blueprintjs/core";


const ColumnsMetricImprovement = ({output_new, output_ref, metric}) => {
  if (!output_new || output_new[metric]===undefined || output_new[metric]===null)
    return <td style={{background:'#bbb'}}>New missing</td>
  if (!output_ref || output_ref[metric]===undefined || output_ref[metric]===null)
    return <td style={{background:'#bbb'}}>Ref missing</td>
  let delta = output_new[metric] - output_ref[metric];
  let delta_relative = delta / output_ref[metric];
  return <td style={{background: interpolateRdYlGn(.5-delta_relative)}}>{metric_formatter.format(delta)} ({percent_formatter.format(100*delta_relative)}%)</td>
}


const QualityCell = ({metric, output}) => {
  if (output===undefined || output[metric]===undefined || output[metric]===null)
    return <td style={{background:'#bbb'}}>na</td>
  let value = output[metric];
  const threshold = available_metrics[metric].threshold
  const quality = 0.5 + (threshold - value) / threshold
  return <td style={{background: interpolateRdYlGn(quality)}}>{metric_formatter.format(value)}</td>
}


const TableCompare = ({ new_batch, ref_batch, output_sort, compare_cross_runtype }) => {
  const displayed_metrics = ['translation_aape', 'translation_rmse', 'rotation_mean', 'translation_drift_pc'];
  return (
    <Section>
      <h2>Improvement report</h2>
      <table className="pt-html-table pt-small">
      <thead>
        <tr>
          <th></th>
          {displayed_metrics.map( m =>
            <th key={m}>{available_metrics[m].label} [{available_metrics[m].suffix}]</th>
          )}
        </tr>
        <tr>
          <th scope="col"></th>
          {displayed_metrics.map( m =>
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
          let output_ref = matching_ref_outputs[0];
          let extra_parameters = Object.keys(output.extra_parameters).length>0 ? JSON.stringify(output.extra_parameters) : '';
          return (
            <tr key={id}>
              <th scope="row">{output.recording_path} {extra_parameters}<Tag className="pt-round pt-minimal" icon={output.platform==='s8'? 'mobile-phone' : 'desktop'}>{output.platform}</Tag><Tag className="pt-round pt-minimal" icon={output.configuration==='mono_mode'?'eye-off':'blank'}>{output.configuration}</Tag></th>
              {displayed_metrics.map( m =>
                <ColumnsMetricImprovement key={m} metric={m} output_new={output} output_ref={output_ref} />
              )}
            </tr>)
      })}
      </tbody>
      </table>
    </Section>
  )
}


const TableKpi = ({ new_batch, ref_batch, output_sort, compare_cross_runtype }) => {
  const displayed_metrics = ['translation_aape', 'translation_rmse', 'rotation_mean', 'translation_drift_pc'];
  return (
    <Section>
      <h2>Quality report</h2>
      <table className="pt-html-table pt-small">
      <thead>
        <tr>
          <th></th>
          {displayed_metrics.map( m =>
            <th colSpan={2} key={m}>{available_metrics[m].label} [{metric_formatter.format(available_metrics[m].threshold)}{available_metrics[m].suffix}]</th>
          )}
        </tr>
        <tr>
          <th scope="col"></th>
          {displayed_metrics.map( m =>
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
          let output_ref = matching_ref_outputs[0];
          let extra_parameters = Object.keys(output.extra_parameters).length>0 ? JSON.stringify(output.extra_parameters) : '';
          return (
            <tr key={id}>
              <th scope="row">{output.recording_path} {extra_parameters} <Tag className="pt-round pt-minimal" icon={output.platform==='s8'? 'mobile-phone' : 'desktop'}>{output.platform}</Tag><Tag className="pt-round pt-minimal" icon={output.configuration==='mono_mode'?'eye-off':'blank'}>{output.configuration}</Tag></th>
              {displayed_metrics.map( m =>
                <Fragment key={m}>
                  <QualityCell metric={m} output={output} />
                  <QualityCell metric={m} output={output_ref} />
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