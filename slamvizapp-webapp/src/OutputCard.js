import React, { Component, Fragment } from "react";
// import Loadable from 'react-loadable';

import styled from "styled-components";
import { Card, Icon, Intent, Tag, Classes, Popover } from "@blueprintjs/core";
import { MetricTag } from "./MetricsSummary";



const SlimCard = styled(Card)`
  padding: 1px !important;
  overflow: "auto";
`;


// const Loading = props => {
//   if (props.error) {
//     return <div>Error!</div>;
//   } else {
//     return <div></div>;
//   }
// };


// const LoadableSlamOutputCard = Loadable({
//   loader: () => import('./slam/SlamOutputCard' /* webpackChunkName: "slam" */),
//   loading: Loading,
// });
// const LoadableTofOutputCard = Loadable({
//   loader: () => import('./tof/TofOutputCard' /* webpackChunkName: "tof" */),
//   loading: Loading,
// });
// const LoadableCisOutputCard = Loadable({
//   loader: () => import('./cis/CisOutputCard' /* webpackChunkName: "cis" */),
//   loading: Loading,
// });


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
      letterSpacing: "-1px"
    }
    return <h5 className={Classes.HEADING} style={style} >
      {output.test_input_path} <OutputTags output={output} warning={warning}/>
    </h5>

  }
}



class OutputTags extends React.PureComponent {
  render() {
    const { platform, configuration, output_dir_url, extra_parameters } = this.props.output;
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
      {Object.entries(extra_parameters).map(([k, v]) => (
        <Tag key={k} intent={Intent.PRIMARY} round minimal>
          {k}:{v}
        </Tag>
      ))}
      {warning && (
        <Popover interactionKind="hover">
          <Icon intent={Intent.WARNING} icon="warning-sign" />
          <span>{warning}</span>
        </Popover>
      )}
    </span>
  }
}

class OutputCard extends Component {
  render() {
    const { main_metrics, available_metrics } = this.props.project_data.information.qatools_metrics;
    const { output_new, output_ref, warning } = this.props;
    // layout should be plotly-like. You could also pass down a props named style.
    const { no_header, layout, ...props } = this.props;
    if (!output_new || output_new.is_failed || output_new.is_pending)
      return <Fragment/>

    let metrics_new = output_new.metrics ? output_new.metrics : {};
    let metrics_ref = output_ref && output_ref.metrics ? output_ref.metrics : {};

    let viewers = <span/> 
    // output_types =  
    // if (output_new.output_type === "slam/6dof")
    //   return (
    //     <LoadableSlamOutputCard
    //       output_new={output_new}
    //       output_ref={output_ref}
    //       warning={warning}
    //       layout={layout}
    //       {...props}
    //     />
    //   );
    // else if (output_new.output_type === "cis/image")
    //   return (
    //     <LoadableCisOutputCard
    //       output_new={output_new}
    //       output_ref={output_ref}
    //       warning={warning}
    //       layout={layout}
    //       {...props}
    //     />
    //   );
    // else if (output_new.output_type === "tof/depth")
    //   return (
    //     <LoadableTofOutputCard
    //       output_new={output_new}
    //       output_ref={output_ref}
    //       warning={warning}
    //       layout={layout}
    //       {...props}
    //     />
    //   );
    // else return <span>Unsupport output type</span>;

    let container_style = {
      flex: "0 0 auto",
      width: (!!layout && layout.width !== undefined) ? `${layout.width}px` : "350px",
      marginBottom: "20px"
    }

    return <div style={container_style}>
      <SlimCard className="output-card">
          {!no_header && <OutputHeader output={output_new} warning={warning}/>}
          <MetricsTags
            selected_metrics={main_metrics}
            available_metrics={available_metrics}
            metrics_new={metrics_new}
            metrics_ref={metrics_ref}
          />        
          {viewers}
      </SlimCard>
    </div>
  }
}


export { OutputCard };
