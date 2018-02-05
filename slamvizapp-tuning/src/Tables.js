import React, { Fragment } from "react";
import { interpolateRdYlGn } from 'd3-scale-chromatic'


import { Section } from "./Common";
import { available_metrics, metric_formatter, percent_formatter } from "./Metrics";
// import { Table, Column, Row } from "@blueprintjs/core";


const ColumnsMetricImprovement = ({v_new, v_ref}) => {
  if (!v_new || !v_ref)
    return <td style={{background:'#bbb'}}>na</td>
  let delta = v_new - v_ref;
  let delta_relative = delta / v_ref;
  return <td style={{background: interpolateRdYlGn(.5-delta_relative)}}>{metric_formatter.format(delta)} ({percent_formatter.format(100*delta_relative)}%)</td>
}


const QualityCell = ({metric, value}) => {
  if (!value)
    return <td style={{background:'#bbb'}}>na</td>
  const threshold = available_metrics[metric].threshold
  const quality = 0.5 + (threshold - value) / threshold
  return <td style={{background: interpolateRdYlGn(quality)}}>{metric_formatter.format(value)}</td>
}

const ColumnsMetricQuality = ({metric, v_new, v_ref}) => {
  return (
    <Fragment>
      <QualityCell metric={metric} value={v_new} />
      <QualityCell metric={metric} value={v_ref} />
    </Fragment>
  )
}

const OutputTable = ({ new_commit, ref_commit, output_sort }) => {
  const displayed_metrics = ['translation_aape', 'translation_rmse', 'rotation_mean', 'translation_drift_pc'];


  return (
  <Fragment>
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
      {Object.entries(new_commit.slam_outputs)
             .sort(output_sort)
             .map( ([id, output]) => {
          // we need to find a matching output - by path name for now...
          // ideally we'd split the list of outputs by recording name and not id, 
          // and display lsf/s8 curves serparately,,,
          let matching_ref_outputs = Object.values(ref_commit.slam_outputs)
                                           .filter(o => o.recording_path===output.recording_path)
          let output_ref = matching_ref_outputs[0];
          return (
            <tr key={id}>
              <th scope="row">{output.recording_path}</th>
              {displayed_metrics.map( m =>
                <ColumnsMetricImprovement key={m}v_new={output[m]} v_ref={output_ref[m]} />
              )}
            </tr>)
      })}
      </tbody>
      </table>
    </Section>

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
      {Object.entries(new_commit.slam_outputs)
             .sort(this.sortOutputs)
             .map( ([id, output]) => {
          // we need to find a matching output - by path name for now...
          // ideally we'd split the list of outputs by recording name and not id, 
          // and display lsf/s8 curves serparately,,,
          let matching_ref_outputs = Object.values(ref_commit.slam_outputs)
                                           .filter(o => o.recording_path===output.recording_path)
          console.log(matching_ref_outputs)
          let output_ref = matching_ref_outputs[0];
          console.log(output_ref)
          return (
            <tr key={id}>
              <th scope="row">{output.recording_path}</th>
              {displayed_metrics.map( m =>
                <ColumnsMetricQuality key={m} metric={m} v_new={output[m]} v_ref={output_ref[m]} />
              )}
            </tr>)
      })}
      </tbody>
      </table>
    </Section>
  </Fragment>)
}


export { OutputTable };