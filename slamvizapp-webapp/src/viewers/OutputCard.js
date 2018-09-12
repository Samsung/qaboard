import React, { Component } from "react";
import Loadable from 'react-loadable';

import styled from "styled-components";
import { Card, Icon, Intent, Tag, Classes, Popover } from "@blueprintjs/core";
import { MetricTag } from "../components/metrics";



const SlimCard = styled(Card)`
  padding: 5px !important;
  overflow: "auto";
`;


const Loading = props => {
  if (props.error) {
    return <div>Error!</div>;
  } else {
    return <div></div>;
  }
};


const LoadableSlamViewer = Loadable({
  loader: () => import('./slam/SlamOutputCard' /* webpackChunkName: "slam" */),
  loading: Loading,
});
const LoadableTofViewer = Loadable({
  loader: () => import('./tof/TofOutputCard' /* webpackChunkName: "tof" */),
  loading: Loading,
});
const LoadableCisViewer = Loadable({
  loader: () => import('./cis/CisOutputCard' /* webpackChunkName: "cis" */),
  loading: Loading,
});
const LoadablePlotlyViewer = Loadable({
  loader: () => import('./plotly' /* webpackChunkName: "plotly-viewer" */),
  loading: Loading,
});


class MetricsTags extends React.PureComponent {
  render() {
    const { metrics_new, metrics_ref } = this.props;
    const { available_metrics, selected_metrics } = this.props;
    return selected_metrics
      .filter(key => metrics_new[key] !== undefined)
      .map(key => (
        <p key={key}>
          <MetricTag
            metrics_new={metrics_new}
            metrics_ref={metrics_ref}
            metric_info={available_metrics[key]}
          />
        </p>
      ))
  }
}


class OutputHeader extends React.PureComponent {
  render() {
    const { output, warning } = this.props;
    const style = {
      fontSize: ".7rem",
      fontWeight: 500,
      lineHeight: 1.6,
      letterSpacing: "-1px",
    }
    return <>
      <h5 className={Classes.HEADING} style={style} >
        {output.test_input_path} <OutputTags output={output} warning={warning}/>
      </h5>
      <p>{Object.entries(output.extra_parameters).map(([k, v]) => (
        <Tag key={k} round minimal style={{margin: '3px'}}>
          {k}:{JSON.stringify(v)}
        </Tag>
      ))}
      </p>
      </>
  }
}


class OutputTags extends React.PureComponent {
  render() {
    const { platform, configuration, output_dir_url } = this.props.output;
    const { warning } = this.props;
    return <span>
      <Tag intent={Intent.PRIMARY} round minimal>{platform}</Tag>
      <Tag intent={Intent.PRIMARY} round minimal>{configuration}</Tag>
      <a
        title="Show output files"
        style={{ paddingLeft: "8px" }}
        target="_blank"
        href={output_dir_url}
      >
        <Icon icon="download" />
      </a>
      {warning && (
        <Popover interactionKind="hover">
          <Icon intent={Intent.WARNING} icon="warning-sign" />
          <span>{warning}</span>
        </Popover>
      )}
    </span>
  }
}


class OutputViewer extends React.Component {
  render() {
    const { type, ...props } = this.props;
    if (type === "6dof/txt")
      return  <LoadableSlamViewer {...props}/>
    else if (type === "pointcloud/txt")
      return <LoadableTofViewer {...props} />
    else if (type === "cis/image")
      return <LoadableCisViewer {...props} />
    else if (type === "plotly/json")
      return <LoadablePlotlyViewer {...props} />
    else return <span></span>;
  }
}



class OutputCard extends Component {
  render() {
    const { main_metrics, available_metrics } = this.props.project_data.information.qatools_metrics;
    const { output_new, output_ref, warning } = this.props;
    const { qatools_config } = this.props.project_data.information;

    // layout should be plotly-like. You could also pass down a props named style.
    if (!output_new || output_new.is_failed || output_new.is_pending)
      return <span/>

    const default_description =   [{
      path: 'cdf_noncon.json',
      type: 'plotly/json',
    }]
    const descriptions = qatools_config.outputs.descriptions || default_description; // [];

    const style = {
      ...this.props.style,
      ...qatools_config.outputs.style,
    }

    let views = descriptions.map( (description, idx) => 
      <OutputViewer
        key={idx}
        output_new={output_new}
        output_ref={output_ref}
        {...description}
        {...this.props}
        style={style}
      />
    )

    let container_style = {
      flex: "0 0 auto",
      width: style.width || '400px',
      marginBottom: "20px"
    }
    return <div style={container_style}>
      <SlimCard className="output-card">
          {!this.props.no_header && <OutputHeader output={output_new} warning={warning}/>}
          <MetricsTags
            selected_metrics={main_metrics}
            available_metrics={available_metrics}
            metrics_new={output_new.metrics ? output_new.metrics : {}}
            metrics_ref={output_ref && output_ref.metrics ? output_ref.metrics : {}}
          />        
          {views}
      </SlimCard>
    </div>
  }
}


export { OutputCard };
